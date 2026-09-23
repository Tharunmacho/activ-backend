const ApiError = require('../../core/utils/ApiError');
const { LeaderMessage } = require('./cms.models');

/**
 * ============================================================================
 * MESSAGES ADDRESSED TO AN OFFICE-BEARER, HELD BY THE SUPER ADMIN
 * ============================================================================
 *
 * The association's ask, in their words: somebody in Tiruvannamalai opens the
 * Tamil Nadu page, sees the leaders their district actually has, and asks to be
 * put in touch. The super admin sees who wrote and whom they were reading
 * about, and takes the district's schemes and events to them personally.
 *
 * Two rules shape everything below, and both came from the same sentence.
 *
 * 1. THE VISITOR DOES NOT WRITE THE MESSAGE.
 *
 *    They pick a purpose from a fixed list and give a telephone number; the
 *    SERVER composes the sentence. "hi", "bye" and anything else a stranger
 *    might send a state chairman cannot be posted, because there is no field
 *    that reaches `body`. `note` exists, is optional, is capped hard, and is
 *    stored separately — so an admin reading it knows it is the visitor's
 *    typing and not the association's wording.
 *
 * 2. A NUMBER FIRST.
 *
 *    Every composed message ends by offering one, because the reply the
 *    association intends to make is a telephone call. A form that took an
 *    enquiry without a way to answer it would generate work nobody can finish.
 *
 * Nothing here emails the leader. These are records for the super admin, who
 * decides what is passed on — see the note on the model.
 */

/* ------------------------------------------------------------------ helpers */

const str = (v) => String(v ?? '').trim();
const capped = (v, n) => str(v).slice(0, n);

/** Digits, spaces, +, - and brackets. Anything else is not a telephone number. */
const PHONE_OK = /^[+()\-\s\d]{6,24}$/;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TIERS = ['national', 'region', 'state', 'district'];

/**
 * ============================================================================
 * THE STANDARD MESSAGES
 * ============================================================================
 *
 * One entry per thing a visitor can plausibly want from an office-bearer. The
 * list is deliberately short: a long menu is a free-text box with extra steps,
 * and every one of these maps to something the association can actually do.
 *
 * `compose` receives the sender and the addressee and returns the whole
 * message. It reads as the visitor because that is who it is from — but it is
 * the association's wording, which is the entire point of the feature.
 *
 * The LABEL is stored on the message beside the key. Re-wording an option here
 * must not silently re-caption a message somebody sent last year.
 */
const PURPOSES = [
    {
        key: 'callback',
        label: 'Please call me back',
        hint: 'You will be rung on the number you give.',
        compose: (s, l) => `${s.name || 'A visitor'} has asked to be called back by `
            + `${l.name || 'this office-bearer'}. Their number is ${s.phone}.`
            + (s.district ? ` They are in ${s.district}.` : ''),
    },
    {
        key: 'membership',
        label: 'I want to join ACTIV',
        hint: 'A membership enquiry, passed to your region.',
        compose: (s, l) => `${s.name || 'A visitor'} would like to join ACTIV and has asked `
            + `${l.name || 'this office-bearer'} about membership.`
            + (s.district ? ` They are in ${s.district}.` : '')
            + ` Please call them on ${s.phone}.`,
    },
    {
        key: 'scheme',
        label: 'I want to know about a scheme or benefit',
        hint: 'Which schemes apply where you are.',
        compose: (s, l) => `${s.name || 'A visitor'} has asked ${l.name || 'this office-bearer'} `
            + 'which schemes and benefits apply to them'
            + (s.district ? ` in ${s.district}` : '')
            + `. Please call them on ${s.phone}.`,
    },
    {
        key: 'event',
        label: 'I want to know about an event',
        hint: 'Dates, venues and how to attend.',
        compose: (s, l) => `${s.name || 'A visitor'} has asked ${l.name || 'this office-bearer'} `
            + 'about an upcoming event'
            + (s.district ? ` in ${s.district}` : '')
            + `. Please call them on ${s.phone}.`,
    },
    {
        key: 'introduction',
        label: 'I would like to introduce my business',
        hint: 'For members and prospective members with a firm.',
        compose: (s, l) => `${s.name || 'A visitor'}`
            + (s.organisation ? ` of ${s.organisation}` : '')
            + ` would like to introduce their business to ${l.name || 'this office-bearer'}`
            + (s.district ? ` in ${s.district}` : '')
            + `. Please call them on ${s.phone}.`,
    },
    /**
     * ========================================================================
     * THE ONE THE VISITOR WRITES, AND WHY IT DOES NOT REOPEN THE OPEN BOX
     * ========================================================================
     *
     * Five fixed reasons cannot be complete, and a visitor whose reason is
     * not among them has to pick the nearest wrong one — which puts a
     * mislabelled enquiry in the inbox and is worse than their own sentence.
     *
     * It is LAST and it is not the default, so anybody scanning the list
     * meets their real reason first; `requiresNote` makes the free text
     * mandatory for this option alone, because “something else” with nothing
     * after it is the empty enquiry the fixed list exists to prevent.
     *
     * The composed sentence QUOTES them rather than speaking as them. An
     * administrator reading the inbox can tell the association's wording
     * from a stranger's without checking which option was picked.
     */
    {
        key: 'other',
        label: 'Something else — I will write it',
        hint: 'Tell us in a line or two what it is about.',
        requiresNote: true,
        compose: (s, l) => `${s.name || 'A visitor'} has written to `
            + `${l.name || 'this office-bearer'}`
            + (s.district ? ` from ${s.district}` : '')
            + `. In their words: “${str(s.note)}”`
            + ` Please call them on ${s.phone}.`,
    },
];

const PURPOSE_BY_KEY = new Map(PURPOSES.map((p) => [p.key, p]));

/** The list the form renders. `compose` stays on the server and is not sent. */
/* `requiresNote` goes to the client so the form can mark the box required
   and refuse before a round trip; the server checks it again below, because
   a client's validation is a convenience and never the rule. */
const purposeOptions = () => PURPOSES.map(({ key, label, hint, requiresNote }) => ({
    key, label, hint, requiresNote: requiresNote === true,
}));

/* -------------------------------------------------------------- read shape */

const toMessage = (doc = {}) => ({
    _id: String(doc._id || ''),
    leader: {
        id: doc.leader?.id || '',
        name: doc.leader?.name || '',
        role: doc.leader?.role || '',
        designation: doc.leader?.designation || '',
        organisation: doc.leader?.organisation || '',
    },
    tier: doc.tier || 'state',
    region: doc.region || '',
    state: doc.state || '',
    district: doc.district || '',
    pagePath: doc.pagePath || '',
    sender: {
        name: doc.sender?.name || '',
        phone: doc.sender?.phone || '',
        email: doc.sender?.email || '',
        organisation: doc.sender?.organisation || '',
        district: doc.sender?.district || '',
    },
    purpose: doc.purpose || '',
    purposeLabel: doc.purposeLabel || '',
    body: doc.body || '',
    note: doc.note || '',
    status: doc.status || 'new',
    adminNote: doc.adminNote || '',
    handledBy: { email: doc.handledBy?.email || '', at: doc.handledBy?.at || null },
    createdAt: doc.createdAt || null,
});

module.exports = {
    purposeOptions,

    /* ------------------------------------------------------------ public */

    /**
     * Record one message.
     *
     * Every field a visitor sends is either validated against a fixed list or
     * capped and trimmed. `body` is NOT among them: it is composed here, from
     * the purpose, and a `body` in the payload is ignored rather than rejected
     * — a client has no business sending one and saying so achieves nothing.
     */
    async create(payload = {}, meta = {}) {
        const purpose = PURPOSE_BY_KEY.get(str(payload.purpose))
            /* An unknown key is the callback template rather than an error: the
               list is ours, a mismatch means an old page against a new build,
               and dropping the enquiry would lose a real person's details. */
            || PURPOSE_BY_KEY.get('callback');

        const sender = {
            name: capped(payload.sender?.name, 120),
            phone: capped(payload.sender?.phone, 24),
            email: capped(payload.sender?.email, 160).toLowerCase(),
            organisation: capped(payload.sender?.organisation, 160),
            district: capped(payload.sender?.district, 120),
        };

        if (!sender.name) throw ApiError.badRequest('Please give your name.');
        if (!PHONE_OK.test(sender.phone)) {
            throw ApiError.badRequest('Please give a telephone number we can call you on.');
        }
        // Optional, but a malformed one is worse than none: it looks answerable.
        if (sender.email && !EMAIL_OK.test(sender.email)) {
            throw ApiError.badRequest('That email address does not look right.');
        }

        const leader = {
            id: capped(payload.leader?.id, 80),
            name: capped(payload.leader?.name, 160),
            role: capped(payload.leader?.role, 120),
            designation: capped(payload.leader?.designation, 200),
            organisation: capped(payload.leader?.organisation, 200),
        };
        if (!leader.name && !leader.role) {
            throw ApiError.badRequest('This message is not addressed to anybody.');
        }

        /*
         * The free text, read BEFORE the message is composed.
         *
         * `other` is the only purpose whose wording depends on it, and
         * `compose` is handed the sender — so it has to be on that object
         * rather than added to the document afterwards.
         */
        const note = capped(payload.note, 300);
        if (purpose.requiresNote && !note) {
            throw ApiError.badRequest(
                'Please say in a line or two what it is about.',
            );
        }

        const doc = await LeaderMessage.create({
            leader,
            tier: TIERS.includes(str(payload.tier)) ? str(payload.tier) : 'state',
            region: capped(payload.region, 120),
            state: capped(payload.state, 120),
            district: capped(payload.district, 120),
            pagePath: capped(payload.pagePath, 300),
            sender,
            purpose: purpose.key,
            purposeLabel: purpose.label,
            body: purpose.compose({ ...sender, note }, leader),
            /* The one free field. Capped at a sentence or two — this is a
               structured enquiry, not a message box. Stored SEPARATELY from
               `body` even when `other` quotes it there, so an administrator
               can always see the visitor's own words unedited. */
            note,
            meta: {
                ip: capped(meta.ip, 60),
                userAgent: capped(meta.userAgent, 300),
            },
        });

        /* The visitor is told it was recorded and nothing else. Echoing the
           composed message back would invite a client to treat it as editable. */
        return { sent: true, purposeLabel: purpose.label };
    },

    /* ------------------------------------------------------- super admin */

    /**
     * The inbox.
     *
     * Filtered by status and by geography, because those are the two questions
     * the super admin has: what is outstanding, and where is it coming from.
     */
    async list({ status = 'all', tier = 'all', state = '', district = '', limit = 100 } = {}) {
        const query = {};
        if (status && status !== 'all') query.status = status;
        if (tier && tier !== 'all') query.tier = tier;
        if (str(state)) query.state = str(state);
        if (str(district)) query.district = str(district);

        const capped_ = Math.min(Math.max(Number(limit) || 100, 1), 500);

        const [rows, unread] = await Promise.all([
            LeaderMessage.find(query).sort({ createdAt: -1 }).limit(capped_).lean().catch(() => []),
            LeaderMessage.countDocuments({ status: 'new' }).catch(() => 0),
        ]);

        return { messages: (rows || []).map(toMessage), unread };
    },

    /**
     * What the super admin can change: the status and their own note.
     *
     * Not the message, not the sender, not the addressee. Those are a record of
     * what a member of the public actually sent, and a record an administrator
     * can edit is not a record.
     */
    async update(id, payload = {}, user = {}) {
        const set = { handledBy: { email: user.email || '', at: new Date() } };

        const status = str(payload.status);
        if (status) {
            if (!['new', 'read', 'contacted', 'closed'].includes(status)) {
                throw ApiError.badRequest('Unknown status');
            }
            set.status = status;
        }
        if (payload.adminNote !== undefined) set.adminNote = capped(payload.adminNote, 2000);

        const doc = await LeaderMessage.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
        if (!doc) throw ApiError.notFound('No such message');
        return toMessage(doc);
    },

    async remove(id) {
        const done = await LeaderMessage.findByIdAndDelete(id);
        if (!done) throw ApiError.notFound('No such message');
        return { deleted: true };
    },
};
