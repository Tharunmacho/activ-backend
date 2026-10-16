const mongoose = require('mongoose');
const { Conversation, Message, sortedPair, pairKeyOf } = require('./message.model');
const MemberDetails = require('../members/memberdetails.model');
const { memberAccess, paidAudience, STUDENT_UPGRADE_MESSAGE } = require('../common/memberAudience');
/* A delivered message raises a notification on the recipient's dashboard —
   see the note in `send`. `safeCreate` is what keeps that side-effect from
   ever failing the send itself. */
const notificationService = require('../notifications/notification.service');
const ApiError = require('../../core/utils/ApiError');
const attachments = require('./messageAttachments');

/**
 * Direct messages between members.
 *
 * ==========================================================================
 * BOTH ENDS MUST BE PAID. NOT JUST THE SENDER.
 * ==========================================================================
 *
 * The association's rule is that messaging is what an ACTIVE membership buys,
 * and a rule checked on one side only is not that rule. Checking the sender
 * alone would let a paid member open a thread with an applicant who cannot
 * reply and cannot even see it — a message delivered into a screen the
 * recipient has no access to, with the sender told it was sent.
 *
 * So `assertCanMessage` is run against BOTH ids on every open and every send,
 * and re-run on send rather than trusted from when the conversation was
 * created: a membership can lapse between the first message and the tenth.
 *
 * ==========================================================================
 * MEMBERSHIP OF A CONVERSATION IS RE-CHECKED ON EVERY READ
 * ==========================================================================
 *
 * Knowing a conversation id must not be enough to read it. `loadMine()` is the
 * one loader, and it takes the caller's id — every list, send and mark-read
 * goes through it, so there is no path that fetches a thread without asking
 * whether it belongs to the person asking.
 */

/** The fields the inbox and the thread header need about the other person. */
const MEMBER_CARD = 'fullName email profilePhoto membershipStatus block district state organizationName memberType registrationType membershipType membershipTier membershipExpiresAt membershipActivatedAt paymentId isActive deletedAt';

const toId = (value) => new mongoose.Types.ObjectId(String(value));

/**
 * This member, if they may use messaging at all.
 *
 * Returns the profile so callers do not immediately re-fetch it. Throws with a
 * sentence that names the reason: "no profile" and "not active" are different
 * problems with different next steps, and one shared "forbidden" tells the
 * member neither.
 */
const assertCanMessage = async(memberId, { self = false } = {}) => {
    const member = await MemberDetails.findById(memberId).select(MEMBER_CARD).lean();

    if (!member) {
        throw self
            ? ApiError.notFound('No member profile for this account')
            : ApiError.notFound('That member could not be found');
    }

    const reconciled = await require('../members/paymentReconcile').reconcileMember(member);
    const access = memberAccess({ ...reconciled, paidAudience: await paidAudience(reconciled) });
    if (access.isStudent) {
        throw ApiError.forbidden(self ? STUDENT_UPGRADE_MESSAGE : 'This member has a Student membership and cannot receive business connections or messages.');
    }
    if (!access.canNetwork) {
        throw self
            ? ApiError.forbidden('Messaging is part of an active membership. Complete your payment to use it.')
            : ApiError.badRequest('That member does not have an active membership yet, so they cannot receive messages.');
    }

    return member;
};

/** A conversation this caller is actually in, or nothing. */
const loadMine = async(conversationId, meId) => {
    if (!mongoose.isValidObjectId(conversationId)) {
        throw ApiError.notFound('Conversation not found');
    }

    const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: toId(meId),
    });

    if (!conversation) throw ApiError.notFound('Conversation not found');
    return conversation;
};

const otherOf = (conversation, meId) =>
    (conversation.participants || []).find(id => String(id) !== String(meId));

const previewOf = message => message?.deletedAt ? 'Message deleted' : String(message?.body ||
    (message?.attachment?.kind === 'audio' ? 'Audio message' : message?.attachment?.kind === 'file' ? `Document: ${message.attachment.name}` : message?.attachmentUrl ? 'Photograph' : '')).slice(0, 200);

// Per-member summaries prevent a hidden or withdrawn message leaking back into
// the inbox preview or unread badge. One indexed aggregate covers the inbox.
const summariesFor = async (conversationIds, meId) => {
    const mine = toId(meId);
    const rows = await Message.aggregate([
        { $match: { conversationId: { $in: conversationIds }, hiddenFor: { $ne: mine } } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $group: { _id: '$conversationId', latest: { $first: '$$ROOT' }, unread: { $sum: { $cond: [
            { $and: [{ $ne: ['$senderId', mine] }, { $eq: [{ $ifNull: ['$readAt', null] }, null] }, { $eq: [{ $ifNull: ['$deletedAt', null] }, null] }] }, 1, 0,
        ] } } } },
    ]);
    return new Map(rows.map(row => [String(row._id), row]));
};

const withSummary = (row, summary) => ({ ...row,
    lastMessageText: previewOf(summary?.latest), lastMessageAt: summary?.latest?.createdAt || null,
    lastMessageBy: summary?.latest?.senderId || null, unread: { get: () => summary?.unread || 0 },
});

const shape = (conversation, meId, member) => ({
    id: String(conversation._id),
    withMember: member
        ? {
            id: String(member._id),
            fullName: member.fullName || '',
            organizationName: member.organizationName || '',
            photoUrl: member.profilePhoto || '',
            block: member.block || '',
            district: member.district || '',
            state: member.state || '',
        }
        : null,
    lastMessageText: conversation.lastMessageText || '',
    lastMessageAt: conversation.lastMessageAt || null,
    lastMessageMine: String(conversation.lastMessageBy || '') === String(meId),
    unread: Number(conversation.unread?.get?.(String(meId)) || 0),
});

class MessageService {
    /**
     * Open the conversation with another member, creating it if this is the
     * first time.
     *
     * Idempotent by construction: the pair is sorted and uniquely indexed, so a
     * double-tap on "Message" cannot produce two threads. The `E11000` branch
     * is the race between two callers doing it at the same instant — the loser
     * reads back the winner's row rather than failing.
     */
    async openWith(meId, otherId) {
        if (String(meId) === String(otherId)) {
            throw ApiError.badRequest('You cannot start a conversation with yourself');
        }
        if (!mongoose.isValidObjectId(otherId)) {
            throw ApiError.notFound('That member could not be found');
        }

        await assertCanMessage(meId, { self: true });
        const other = await assertCanMessage(otherId);

        const participants = sortedPair(meId, otherId);
        const pairKey = pairKeyOf(meId, otherId);

        /*
         * Found or created by `pairKey`, never by the participant array.
         *
         * The array lookup is an exact-match on two ObjectIds and worked, but
         * the UNIQUE constraint behind it did not — see the note on `pairKey`
         * in the model. Keying both the read and the write on the same scalar
         * means the duplicate branch below re-reads the row that actually
         * exists.
         */
        let conversation = await Conversation.findOne({ pairKey });
        if (!conversation) {
            try {
                conversation = await Conversation.create({ participants, pairKey });
            } catch (err) {
                if (err && err.code === 11000) {
                    // Two callers raced. The loser reads the winner's row.
                    conversation = await Conversation.findOne({ pairKey });
                } else {
                    throw err;
                }
            }
        }

        /*
         * Still nothing means something is wrong with the collection rather
         * than with this request — a stale index, a failed write. Say so.
         * `shape()` would otherwise read `_id` of null and return a 500 whose
         * message names a property the member has never heard of, which is
         * exactly how the multikey bug presented.
         */
        if (!conversation) {
            throw ApiError.internal('The conversation could not be opened. Please try again.');
        }

        return shape(conversation, meId, other);
    }

    /** This member's inbox, newest activity first. */
    async listConversations(meId) {
        await assertCanMessage(meId, { self: true });

        const rows = await Conversation.find({ participants: toId(meId) })
            .sort({ lastMessageAt: -1, updatedAt: -1 })
            .limit(200)
            .lean();

        if (!rows.length) return { conversations: [], unreadTotal: 0 };

        /*
         * One lookup for every other participant, not one per row. The inbox is
         * the first screen a member opens and the N+1 here is the difference
         * between one round trip and twenty.
         */
        const otherIds = rows.map(r => otherOf(r, meId)).filter(Boolean);
        const members = await MemberDetails.find({ _id: { $in: otherIds } })
            .select(MEMBER_CARD).lean().catch(() => []);
        const byId = new Map(members.map(m => [String(m._id), m]));
        const summaries = await summariesFor(rows.map(row => row._id), meId);

        const conversations = rows.map((row) => {
            // `.lean()` gives a plain object, so the Map accessor is gone.
            const shaped = shape(withSummary(row, summaries.get(String(row._id))), meId,
                byId.get(String(otherOf(row, meId))));
            return shaped;
        });

        return {
            conversations,
            unreadTotal: conversations.reduce((sum, c) => sum + c.unread, 0),
        };
    }

    /**
     * One thread, newest last.
     *
     * Paged from the END, because that is where a conversation is read from:
     * `before` takes the next older page. Returned in ascending order so the
     * client renders it top-to-bottom without re-sorting.
     */
    async listMessages(conversationId, meId, { before = null, limit = 50 } = {}) {
        await assertCanMessage(meId, { self: true });
        const conversation = await loadMine(conversationId, meId);

        const size = Math.min(Math.max(1, parseInt(limit, 10) || 50), 100);
        const filter = { conversationId: conversation._id, hiddenFor: { $ne: toId(meId) } };
        if (before) {
            const cutoff = new Date(before);
            if (!Number.isNaN(cutoff.getTime())) filter.createdAt = { $lt: cutoff };
        }

        const rows = await Message.find(filter)
            .sort({ createdAt: -1 })
            .limit(size + 1)
            .lean();

        const hasMore = rows.length > size;
        const page = (hasMore ? rows.slice(0, size) : rows).reverse();

        const other = await MemberDetails.findById(otherOf(conversation, meId))
            .select(MEMBER_CARD).lean().catch(() => null);

        return {
            conversation: shape(withSummary(conversation.toObject(), (await summariesFor([conversation._id], meId)).get(String(conversation._id))), meId, other),
            hasMore,
            messages: page.map(m => ({
                id: String(m._id),
                body: m.deletedAt ? '' : m.body || '',
                deleted: !!m.deletedAt,
                /* Always present, empty when there is none — a client that has
                   to test for `undefined` as well as `''` gets it wrong once. */
                attachmentUrl: m.deletedAt ? '' : m.attachmentUrl || '',
                attachment: m.deletedAt ? null : attachments.publicMetadata(m.attachment),
                mine: String(m.senderId) === String(meId),
                at: m.createdAt,
                readAt: m.readAt || null,
            })),
        };
    }

    /**
     * Send. Re-checks BOTH memberships — see the note at the top of the file.
     */
    async send(conversationId, meId, body, attachmentUrl = '', uploadedAttachment = null) {
        const text = String(body || '').trim();
        const attachment = attachments.forMessage(meId, attachmentUrl, uploadedAttachment);
        const image = attachment?.url || '';
        /* TEXT OR A PICTURE. A photograph with no caption is an ordinary
           message; a message with neither is nothing at all. */
        if (!text && !image) throw ApiError.badRequest('A message cannot be empty');
        if (text.length > 4000) throw ApiError.badRequest('That message is too long (4000 characters maximum)');

        const conversation = await loadMine(conversationId, meId);
        const otherId = otherOf(conversation, meId);

        await assertCanMessage(meId, { self: true });
        await assertCanMessage(otherId);

        const message = await Message.create({
            conversationId: conversation._id,
            senderId: toId(meId),
            body: text,
            attachmentUrl: image,
            ...(attachment?.id ? { attachment } : {}),
        });

        /*
         * The inbox row, kept in step in the same breath as the write.
         *
         * `$inc` on the recipient's key rather than read-modify-write: two
         * messages arriving at once would otherwise both read 0 and both store
         * 1, and the unread badge would undercount for good.
         */
        await Conversation.updateOne(
            { _id: conversation._id },
            {
                $set: {
                    lastMessageAt: message.createdAt,
                    /*
                      The inbox row reads this. For a photograph with no caption
                      it would be the empty string, which draws a conversation
                      row with nothing in it — indistinguishable from one that
                      failed to load.
                    */
                    lastMessageText: previewOf(message),
                    lastMessageBy: toId(meId),
                    [`unread.${String(meId)}`]: 0,
                },
                $inc: { [`unread.${String(otherId)}`]: 1 },
            },
        );

        /*
         * ==================================================================
         * AND A NOTIFICATION, ON THE RECIPIENT'S DASHBOARD
         * ==================================================================
         *
         * The unread COUNT above was already kept, so the badge on the
         * Messages screen was right — but nothing was ever written to the
         * notifications collection, so the bell in the header said “nothing
         * in the last 24 hours” while a message sat waiting to be read.
         *
         * IT DOES NOT QUOTE THE MESSAGE. A notification lands in a bell that
         * may be read over somebody's shoulder; the body is between the two
         * members. It names the sender and says there is one.
         *
         * `safeCreate` swallows its own failures, which is the whole reason
         * to use it here: a bad id or a momentarily unreachable database
         * must not turn a DELIVERED message into a 500 that invites the
         * sender to send it again.
         */
        if (String(otherId) !== String(meId)) {
            const sender = await MemberDetails.findById(toId(meId))
                .select('fullName name')
                .lean()
                .catch(() => null);

            const from = String(sender?.fullName || sender?.name || '').trim()
                || 'An ACTIV member';

            await notificationService.safeCreate(otherId, {
                title: `New message from ${from}`,
                message: `${from} has sent you a message. Open Messages to read and reply.`,
                type: 'info',
                /* Enough for the panel to link straight to the thread rather
                   than to the inbox and a search. */
                data: {
                    kind: 'message',
                    conversationId: String(conversation._id),
                    messageId: String(message._id),
                    from,
                },
            });
        }

        return {
            id: String(message._id),
            body: message.body || '',
            attachmentUrl: message.attachmentUrl || '',
            attachment: attachments.publicMetadata(message.attachment),
            mine: true,
            at: message.createdAt,
            readAt: null,
        };
    }

    /** Everything in this thread, read. */
    async assertCanUpload(meId) {
        return assertCanMessage(meId, { self: true });
    }

    async attachmentForDownload(id, meId) {
        if (!attachments.FILE_ID.test(String(id || ''))) throw ApiError.notFound('Attachment not found');
        await assertCanMessage(meId, { self: true });
        const conversations = await Conversation.find({ participants: toId(meId) }).select('_id').lean();
        const message = await Message.findOne({ 'attachment.id': id,
            deletedAt: null, hiddenFor: { $ne: toId(meId) },
            conversationId: { $in: conversations.map(row => row._id) } }).select('attachment').lean();
        if (!message?.attachment?.id) throw ApiError.notFound('Attachment not found');
        return message.attachment;
    }

    /** Everything in this thread, read. */
    async markRead(conversationId, meId) {
        await assertCanMessage(meId, { self: true });
        const conversation = await loadMine(conversationId, meId);

        await Promise.all([
            Conversation.updateOne(
                { _id: conversation._id },
                { $set: { [`unread.${String(meId)}`]: 0 } },
            ),
            // Only the OTHER side's messages: a receipt on your own message is
            // meaningless, and stamping it would make "read" mean "sent".
            Message.updateMany(
                { conversationId: conversation._id, senderId: { $ne: toId(meId) }, readAt: null, deletedAt: null, hiddenFor: { $ne: toId(meId) } },
                { $set: { readAt: new Date() } },
            ),
        ]);

        return { ok: true };
    }

    /** For the bell: how many unread messages this member has, in total. */
    async unreadCount(meId) {
        await assertCanMessage(meId, { self: true });
        const rows = await Conversation.find({ participants: toId(meId) }).select('_id').lean();
        return Message.countDocuments({ conversationId: { $in: rows.map(row => row._id) }, senderId: { $ne: toId(meId) }, readAt: null, deletedAt: null, hiddenFor: { $ne: toId(meId) } });
    }

    async remove(conversationId, messageId, meId, scope) {
        if (!['me', 'everyone'].includes(scope)) throw ApiError.badRequest('Choose delete for me or delete for everyone.');
        if (!mongoose.isValidObjectId(messageId)) throw ApiError.notFound('Message not found');
        await assertCanMessage(meId, { self: true });
        const conversation = await loadMine(conversationId, meId);
        const filter = { _id: toId(messageId), conversationId: conversation._id };
        const message = await Message.findOne(filter).lean();
        if (!message) throw ApiError.notFound('Message not found');
        if (scope === 'everyone' && String(message.senderId) !== String(meId)) throw ApiError.forbidden('You can only delete your own messages for everyone.');
        if (scope === 'me') await Message.updateOne(filter, { $addToSet: { hiddenFor: toId(meId) } });
        else await Message.updateOne({ ...filter, senderId: toId(meId), deletedAt: null }, {
            $set: { deletedAt: new Date(), body: '', attachmentUrl: '' }, $unset: { attachment: '' },
        });
        return { id: String(messageId), scope, deleted: scope === 'everyone' };
    }

    // Synchronise already loaded history as well as the newest page. Returning
    // only status avoids transferring attachment/text history every ten seconds.
    async messageStatus(conversationId, meId, ids) {
        if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => !mongoose.isValidObjectId(id))) throw ApiError.badRequest('Choose up to 500 messages.');
        await assertCanMessage(meId, { self: true });
        const conversation = await loadMine(conversationId, meId);
        const rows = await Message.find({ conversationId: conversation._id, _id: { $in: ids.map(toId) } }).select('_id deletedAt hiddenFor readAt').lean();
        const byId = new Map(rows.map(row => [String(row._id), row]));
        return ids.map(id => {
            const row = byId.get(String(id));
            return { id: String(id), hidden: !row || row.hiddenFor?.some(value => String(value) === String(meId)), deleted: !!row?.deletedAt, readAt: row?.readAt || null };
        });
    }
}

module.exports = new MessageService();
module.exports.assertCanMessage = assertCanMessage;
