const mongoose = require('mongoose');

/**
 * MEMBER-TO-MEMBER DIRECT MESSAGES.
 *
 * Two collections rather than one document with an array of messages on it. A
 * conversation between two active members is open-ended, and Mongo's 16MB
 * document cap is a real ceiling for a thread that never ends — but the reason
 * that matters here is smaller and sooner: an unbounded array cannot be paged,
 * so opening a thread would ship every message ever sent in it.
 *
 * ==========================================================================
 * A CONVERSATION IS IDENTIFIED BY ITS PAIR, AND THE PAIR IS SORTED
 * ==========================================================================
 *
 * `participants` is stored ASCENDING by id, always, and carries a unique index.
 * That is what makes "open my conversation with X" idempotent: without the
 * sort, A→B and B→A build two different arrays, both match nothing, and each
 * member ends up talking into their own private copy of the same thread while
 * seeing none of the other's messages.
 *
 * `sortedPair()` below is the only place that ordering is decided, and every
 * write goes through it.
 */

const conversationSchema = new mongoose.Schema({
    /**
     * Exactly two member ids, ascending. See the note above.
     *
     * Ids are `MemberDetails._id` — the member profile, which is what the
     * directory lists and what `membershipStatus` hangs off. Not `MemberAuth`:
     * the two share an id today, and relying on that is the kind of assumption
     * that survives until the first account where it is not true.
     */
    participants: {
        type: [mongoose.Schema.Types.ObjectId],
        required: true,
        validate: {
            validator: (v) => Array.isArray(v) && v.length === 2 && String(v[0]) !== String(v[1]),
            message: 'A conversation is between exactly two different members',
        },
    },

    /**
     * THE PAIR, AS ONE STRING — `"<smaller id>:<larger id>"`. UNIQUE.
     *
     * ==========================================================================
     * A UNIQUE INDEX ON AN ARRAY IS NOT WHAT IT LOOKS LIKE
     * ==========================================================================
     *
     * This was `index({ participants: 1 }, { unique: true })`, which reads as
     * "one conversation per pair" and is not what Mongo does. An index on an
     * array field is MULTIKEY: it indexes each ELEMENT separately, so unique
     * means each member may appear in at most ONE conversation in the entire
     * collection — ever.
     *
     * The symptom was a member with one existing thread becoming permanently
     * unmessageable: the insert failed with E11000, the duplicate-handler
     * re-read by pair and found nothing (there IS no conversation for that
     * pair), and the caller got a 500 reading `_id` of null. Reproduced
     * directly against the collection before the fix.
     *
     * A scalar carries the constraint properly. Sorted, so A->B and B->A build
     * the same key — the same reason `participants` is sorted — and derived in
     * one place, `pairKeyOf`, which every write goes through.
     */
    pairKey: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },

    /**
     * Denormalised so the inbox is one query.
     *
     * The list screen needs, per row, the other member and the last thing said.
     * Without these it is one query for the conversations and then one per row
     * for its newest message — the classic N+1, on the screen a member opens
     * first. Kept in step by `sendMessage`, which is the only writer.
     */
    lastMessageAt: { type: Date, index: true },
    lastMessageText: { type: String, default: '', trim: true },
    lastMessageBy: mongoose.Schema.Types.ObjectId,

    /**
     * Unread count PER PARTICIPANT, keyed by member id.
     *
     * A `Map`, not two named fields: the pair is symmetric and naming them
     * `aUnread` / `bUnread` would re-introduce the ordering question this
     * schema exists to settle. Incremented for the recipient on every send and
     * zeroed for the reader on `markRead`.
     */
    unread: {
        type: Map,
        of: Number,
        default: () => new Map(),
    },
}, { collection: 'conversations', timestamps: true });

/*
 * NOT UNIQUE. Looking up "this member's threads" is exactly the multikey
 * behaviour we want; it is only the UNIQUENESS that was wrong on it. The pair
 * constraint lives on `pairKey` above.
 */
conversationSchema.index({ participants: 1, lastMessageAt: -1 });

const messageSchema = new mongoose.Schema({
    conversationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conversation',
        required: true,
        index: true,
    },
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
    },
    /**
     * The message. Trimmed and capped.
     *
     * 4000 is generous for a direct message and is there to stop a paste of a
     * whole document becoming a row the inbox then has to render a preview of.
     * Enforced on the schema rather than only in the service, because the
     * schema is the thing every future write path goes through.
     */
    body: {
        type: String,
        /*
         * NOT `required`, and the validator below is why.
         *
         * A photograph with no caption is an ordinary thing to send, and with
         * `required: true` Mongoose refused the whole document — a validation
         * error on a path the member had deliberately left blank. The rule is
         * not “there must be text”, it is “there must be SOMETHING”, and that
         * is a fact about the document rather than about this one field.
         */
        default: '',
        trim: true,
        maxlength: 4000,
    },

    /**
     * A picture sent with the message, as the url the client will load.
     *
     * The file itself is stored by the shared `upload` middleware — images
     * only, five megabytes, and a filename the client does not choose — and
     * only its path is kept here. Storing the bytes in the document would put
     * a five-megabyte field in a collection that is paged by the thread.
     */
    attachmentUrl: { type: String, default: '', trim: true },

    /** When the OTHER participant read it. Null until they do. */
    readAt: { type: Date, default: null },
}, { collection: 'messages', timestamps: true });

/*
 * TEXT OR A PICTURE — an empty message is still an empty message.
 *
 * On the schema rather than only in the service, because the schema is what
 * every future write path goes through, and “the caller always checks” is a
 * thing that is true right up until a script does not.
 */
messageSchema.pre('validate', function guardEmpty(next) {
    const hasText = String(this.body || '').trim().length > 0;
    const hasImage = String(this.attachmentUrl || '').trim().length > 0;
    if (!hasText && !hasImage) {
        return next(new Error('A message must carry text or a picture'));
    }
    return next();
});

// Paging a thread: newest first, within one conversation.
messageSchema.index({ conversationId: 1, createdAt: -1 });

/**
 * The canonical participant ordering. THE ONLY PLACE IT IS DECIDED.
 *
 * Exported because the service builds queries with it as well as documents, and
 * a second copy of this three-line sort is a second chance to get A→B and B→A
 * pointing at different rows.
 */
const sortedPair = (a, b) => [String(a), String(b)]
    .sort()
    .map(id => new mongoose.Types.ObjectId(id));

/**
 * The pair as one sortable string. THE ONLY PLACE THE KEY IS BUILT.
 *
 * Derived from the same sort as `sortedPair`, so the array and the key can
 * never disagree about which conversation they mean.
 */
const pairKeyOf = (a, b) => [String(a), String(b)].sort().join(':');

const Conversation = mongoose.models.Conversation
    || mongoose.model('Conversation', conversationSchema);
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

module.exports = { Conversation, Message, sortedPair, pairKeyOf };
