const mongoose = require('mongoose');
const Event = require('./event.model');
const EventRegistration = require('./eventregistration.model');
const ApiError = require('../../core/utils/ApiError');
const auditService = require('../audit/audit.service');
const {
    multiTargetViewerClause, multiTargetsViewer, targetsLabel, regionPattern
} = require('../common/regionMatch');

const LIST_LIMIT = 100;

/**
 * A transaction reference for one seat.
 *
 * Minted at registration rather than at payment, so the member is looking at
 * the same reference on the checkout screen, in the receipt and in the
 * organiser's list — a number that appears only after the money moves is one
 * they cannot quote while trying to work out whether it did.
 *
 * `ACTIV-EVT-<base36 time>-<4 random>`: readable over a phone, sortable by when
 * it was issued, and unique enough for a dummy gateway. A real gateway supplies
 * its own id and it goes in the same field.
 */
const newPaymentReference = () =>
    'ACTIV-EVT-'
    + Date.now().toString(36).toUpperCase()
    + '-'
    + Math.random().toString(36).slice(2, 6).toUpperCase();

/**
 * The one caller with no patch of their own.
 *
 * Every other role — member, block, district, state — is somewhere, and sees
 * what was aimed at where they are. A super admin manages the whole programme,
 * so region targeting must not hide anything from them.
 */
const isSuperAdmin = (context = {}) => String(context.role || '') === 'super_admin';

const str = (value) => String(value === null || value === undefined ? '' : value).trim();

/**
 * "09:30" from whatever the editor typed.
 *
 * Agenda rows come from a `<input type="time">` in the CMS, which is already
 * `HH:MM` — but the same endpoint is reachable from the mobile app and from
 * anyone with a token and curl, and a malformed row would otherwise render as a
 * blank cell in the middle of an otherwise correct agenda with nothing to
 * explain it. Anything unparseable becomes empty, which the UI renders as an
 * untimed item rather than a broken one.
 */
const toClockTime = (value) => {
    const raw = str(value);
    if (!raw) return '';

    const match = raw.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return '';

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || hours > 23 || !Number.isFinite(minutes) || minutes > 59) return '';

    return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
};

/**
 * Agenda rows, cleaned and ordered.
 *
 * Sorted by start time here rather than trusting the order they arrived in: the
 * CMS lets an editor add a 9am session after a 2pm one, and an agenda printed
 * out of order is worse than no agenda. Untimed rows keep their relative
 * position at the end, because there is nothing to sort them by.
 */
const sanitizeAgenda = (value) => {
    if (!Array.isArray(value)) return [];

    const rows = value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            startTime: toClockTime(item.startTime || item.start || item.time),
            endTime: toClockTime(item.endTime || item.end),
            title: str(item.title),
            description: str(item.description),
            speaker: str(item.speaker),
            location: str(item.location)
        }))
        // A row with neither a title nor a time is an empty form field the
        // editor tabbed through, not a session.
        .filter((item) => item.title || item.startTime);

    return rows.sort((a, b) => {
        if (!a.startTime && !b.startTime) return 0;
        if (!a.startTime) return 1;
        if (!b.startTime) return -1;
        return a.startTime.localeCompare(b.startTime);
    });
};

const sanitizeSpeakers = (value) => {
    if (!Array.isArray(value)) return [];

    return value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            name: str(item.name),
            role: str(item.role),
            organization: str(item.organization || item.org),
            bio: str(item.bio),
            photoUrl: str(item.photoUrl || item.photo)
        }))
        .filter((item) => item.name);
};

/** Reminder offsets: whole positive hours, de-duplicated, soonest last. */
const sanitizeReminders = (value) => {
    if (!Array.isArray(value)) return [];

    const hours = value
        .map((entry) => Math.round(Number(entry)))
        .filter((entry) => Number.isFinite(entry) && entry > 0 && entry <= 24 * 30);

    return Array.from(new Set(hours)).sort((a, b) => b - a);
};

/**
 * When registration closes.
 *
 * The stored deadline when there is one, otherwise the moment the event starts.
 * Derived rather than stored so that moving the event moves the cutoff with it
 * — a stored default would keep pointing at the original date and quietly close
 * registration weeks early for a postponed event.
 */
const registrationClosesAt = (doc = {}) => {
    if (doc.registrationDeadline) return new Date(doc.registrationDeadline);
    return doc.startAt ? new Date(doc.startAt) : null;
};

const toEvent = (doc = {}, extras = {}) => ({
    id: doc._id ? doc._id.toString() : '',
    title: doc.title || '',
    description: doc.description || '',
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    venue: doc.venue || '',
    venueAddress: doc.venueAddress || '',
    venueMapUrl: doc.venueMapUrl || '',
    state: doc.state || '',
    district: doc.district || '',
    block: doc.block || '',
    /**
     * Who this event was aimed at, as a person reads it.
     *
     * "Tamil Nadu › Sivaganga › Kalayarkoil", or empty for everyone. Derived
     * here rather than assembled in each client: three admin dashboards and the
     * CMS all need to show an event's reach, and three different joins of the
     * same three fields is three chances to print "Tamil Nadu, , Kalayarkoil".
     */
    // Empty when the event goes to everyone, whichever way it says so: an empty
    // list, or `reachEveryone` overruling a list that is still remembered.
    // Every surface renders an empty label as "Everywhere", so printing the
    // remembered regions here would tell a member the event was aimed at a
    // district it is not narrowed to.
    targetLabel: doc.reachEveryone === true ? '' : targetsLabel(doc),
    /*
     * Every region this event was aimed at.
     *
     * The legacy `state`/`district`/`block` above are still sent — the mobile
     * app reads them — but they only ever describe the FIRST target. A client
     * that wants to know the real audience reads this.
     */
    targets: (doc.targets || []).map((target) => ({
        state: target.state || '',
        district: target.district || '',
        block: target.block || ''
    })),
    bannerUrl: doc.bannerUrl || '',
    /*
     * These three were on the model and missing from this mapper, so the CMS
     * could set a banner's alt text, fit and focal point and no client ever
     * received them — the fields were written and then dropped on the way out.
     */
    bannerAlt: doc.bannerAlt || '',
    bannerFit: doc.bannerFit === 'contain' ? 'contain' : 'cover',
    bannerPosition: doc.bannerPosition || 'center',
    status: doc.status || 'draft',
    audience: doc.audience || 'all',
    /*
     * Whether this one was also posted to the onboarding events section, and
     * which site it was authored for.
     *
     * Mapped out because the screen that sets them has to be able to show them
     * back. A control that reads `false` after a save that stored `true` is
     * indistinguishable, to the editor, from a save that failed — and the
     * channel is needed alongside it because the flag postdates every row in
     * the collection, so `false` there does not mean "not public".
     *
     * `channel` defaults to the schema's own default rather than to `''`, so a
     * document written before the field existed is described the way the
     * database would treat it.
     */
    showOnOnboarding: doc.showOnOnboarding === true,
    channel: doc.channel || 'public',
    /*
     * Whether this goes to everyone regardless of `targets`.
     *
     * Mapped out beside the list, never instead of it: the editor's form shows
     * both boxes and has to restore both. Sending only the effective audience
     * is what made every edit start from a blank tree.
     */
    reachEveryone: doc.reachEveryone === true,

    agenda: (doc.agenda || []).map((item) => ({
        id: item._id ? String(item._id) : '',
        startTime: item.startTime || '',
        endTime: item.endTime || '',
        title: item.title || '',
        description: item.description || '',
        speaker: item.speaker || '',
        location: item.location || ''
    })),
    speakers: (doc.speakers || []).map((item) => ({
        id: item._id ? String(item._id) : '',
        name: item.name || '',
        role: item.role || '',
        organization: item.organization || '',
        bio: item.bio || '',
        photoUrl: item.photoUrl || ''
    })),

    contactName: doc.contactName || '',
    contactPhone: doc.contactPhone || '',
    contactEmail: doc.contactEmail || '',

    registrationEnabled: !!doc.registrationEnabled,
    registrationDeadline: doc.registrationDeadline || null,
    registrationClosesAt: registrationClosesAt(doc),
    capacity: Number(doc.capacity || 0),
    registrationNote: doc.registrationNote || '',
    /** Rupees. 0 is free, and free is the default — see the model's note. */
    registrationFee: Number(doc.registrationFee || 0),
    /*
     * The form this event asks. The member screen renders whatever is here and
     * holds no list of its own — a client that knows the fields is a client
     * that has to ship before a new question can be asked.
     */
    registrationFields: (doc.registrationFields || []).map((field) => ({
        key: field.key || '',
        label: field.label || '',
        type: field.type || 'text',
        required: !!field.required,
        placeholder: field.placeholder || '',
        helpText: field.helpText || '',
        options: field.options || []
    })),
    reminderOffsetsHours: doc.reminderOffsetsHours || [],

    createdBy: doc.createdBy || '',
    createdAt: doc.createdAt || null,

    // Filled in by the caller when it knows: how many seats are taken, and
    // whether THIS member has one. Both default to the honest "nothing known"
    // rather than to zero, which would read as "no one has registered".
    registeredCount: extras.registeredCount === undefined ? null : extras.registeredCount,
    myRegistration: extras.myRegistration === undefined ? null : extras.myRegistration
});

const toRegistration = (doc = {}) => ({
    id: doc._id ? String(doc._id) : '',
    eventId: doc.eventId ? String(doc.eventId) : '',
    userId: doc.userId ? String(doc.userId) : '',
    /*
     * The seat's payment, defaulted for every row written before fees existed.
     *
     * `not_required` rather than `pending` for a row with no payment object:
     * those seats were taken at free events, and calling them "pending" would
     * present every existing attendee with a bill.
     */
    payment: {
        status: (doc.payment && doc.payment.status) || 'not_required',
        amount: Number((doc.payment && doc.payment.amount) || 0),
        reference: (doc.payment && doc.payment.reference) || '',
        method: (doc.payment && doc.payment.method) || '',
        paidAt: (doc.payment && doc.payment.paidAt) || null
    },
    /** The answers this member gave to the event's own form, in its order. */
    responses: (doc.responses || []).map((row) => ({
        key: row.key || '',
        label: row.label || '',
        value: row.value || ''
    })),
    memberName: doc.memberName || '',
    email: doc.email || '',
    phone: doc.phone || '',
    organization: doc.organization || '',
    state: doc.state || '',
    district: doc.district || '',
    block: doc.block || '',
    status: doc.status || 'registered',
    note: doc.note || '',
    registeredAt: doc.registeredAt || doc.createdAt || null,
    cancelledAt: doc.cancelledAt || null
});

/** Only the fields a client is allowed to set, coerced and trimmed. */
const sanitize = (payload = {}) => {
    const out = {};
    const text = (key) => {
        if (payload[key] === undefined) return;
        out[key] = str(payload[key]);
    };

    text('title');
    text('description');
    text('venue');
    text('venueAddress');
    text('venueMapUrl');
    text('state');
    text('district');
    text('block');
    text('bannerUrl');
    text('bannerAlt');
    text('bannerPosition');
    text('contactName');
    text('contactPhone');
    text('contactEmail');
    text('registrationNote');

    if (payload.bannerFit !== undefined) {
        out.bannerFit = str(payload.bannerFit) === 'contain' ? 'contain' : 'cover';
    }

    if (payload.startAt !== undefined) {
        const start = new Date(payload.startAt);
        if (Number.isNaN(start.getTime())) throw ApiError.badRequest('startAt is not a valid date');
        out.startAt = start;
    }

    if (payload.endAt !== undefined && payload.endAt !== null && payload.endAt !== '') {
        const end = new Date(payload.endAt);
        if (Number.isNaN(end.getTime())) throw ApiError.badRequest('endAt is not a valid date');
        out.endAt = end;
    }

    if (payload.status !== undefined) {
        const status = str(payload.status).toLowerCase();
        if (!['draft', 'published'].includes(status)) {
            throw ApiError.badRequest("status must be 'draft' or 'published'");
        }
        out.status = status;
    }

    if (payload.audience !== undefined) {
        const audience = str(payload.audience).toLowerCase() || 'all';
        if (!['all', 'paid'].includes(audience)) {
            throw ApiError.badRequest("audience must be 'all' or 'paid'");
        }
        out.audience = audience;
    }

    if (payload.agenda !== undefined) out.agenda = sanitizeAgenda(parseMaybeJson(payload.agenda));
    if (payload.speakers !== undefined) out.speakers = sanitizeSpeakers(parseMaybeJson(payload.speakers));
    if (payload.reminderOffsetsHours !== undefined) {
        out.reminderOffsetsHours = sanitizeReminders(parseMaybeJson(payload.reminderOffsetsHours));
    }

    if (payload.registrationEnabled !== undefined) {
        out.registrationEnabled = payload.registrationEnabled === true || payload.registrationEnabled === 'true';
    }

    /*
     * "Post this in the onboarding events section too."
     *
     * The one field on this endpoint that widens an event's audience beyond the
     * association, so it is only ever set from an explicit payload — absent
     * leaves the stored value alone, and a `channel: 'members'` event with no
     * flag stays off the public pages.
     *
     * `=== 'true'` alongside `=== true` because a multipart save sends booleans
     * as strings.
     */
    if (payload.showOnOnboarding !== undefined) {
        out.showOnOnboarding = payload.showOnOnboarding === true || payload.showOnOnboarding === 'true';
    }

    // "Everyone in the association", stored separately from `targets` so the two
    // boxes on the form cannot destroy each other. See the schema's note.
    if (payload.reachEveryone !== undefined) {
        out.reachEveryone = payload.reachEveryone === true || payload.reachEveryone === 'true';
    }

    if (payload.registrationDeadline !== undefined) {
        if (payload.registrationDeadline === null || payload.registrationDeadline === '') {
            out.registrationDeadline = null;
        } else {
            const deadline = new Date(payload.registrationDeadline);
            if (Number.isNaN(deadline.getTime())) {
                throw ApiError.badRequest('registrationDeadline is not a valid date');
            }
            out.registrationDeadline = deadline;
        }
    }

    if (payload.capacity !== undefined) {
        const capacity = Math.round(Number(payload.capacity));
        if (!Number.isFinite(capacity) || capacity < 0) {
            throw ApiError.badRequest('capacity cannot be negative');
        }
        out.capacity = capacity;
    }

    if (payload.registrationFields !== undefined) {
        out.registrationFields = sanitizeRegistrationFields(parseMaybeJson(payload.registrationFields));
    }

    if (payload.registrationFee !== undefined) {
        const fee = Number(payload.registrationFee);
        if (!Number.isFinite(fee) || fee < 0) {
            throw ApiError.badRequest('registrationFee cannot be negative');
        }
        // Rounded to whole rupees: the payment step, the receipt and the
        // organiser's total all have to agree, and they cannot if one of them
        // is carrying a fraction of a paisa from a float.
        out.registrationFee = Math.round(fee);
    }

    /*
     * The region list, and the legacy fields mirrored from its first entry.
     *
     * Written together and never separately. They are two representations of
     * one fact, and the moment a write touches one without the other the
     * collection holds an event whose audience depends on which client is
     * asking — the app reading a region the array no longer contains.
     *
     * `targets: []` is a real instruction meaning "everywhere", so it clears
     * the legacy fields too rather than leaving the previous target standing.
     */
    if (payload.targets !== undefined) {
        out.targets = sanitizeTargets(parseMaybeJson(payload.targets));

        const primary = out.targets[0] || { state: '', district: '', block: '' };
        out.state = primary.state;
        out.district = primary.district;
        out.block = primary.block;
    }

    if (out.startAt && out.endAt && out.endAt < out.startAt) {
        throw ApiError.badRequest('endAt cannot be before startAt');
    }

    return out;
};

const FIELD_TYPES = ['text', 'textarea', 'number', 'email', 'phone', 'date', 'select', 'checkbox'];

/**
 * A stable key for a form field, derived from its label ONCE.
 *
 * Only used when the client sends a field with no key — a newly added one. An
 * existing field keeps whatever key it already has, whatever its label becomes,
 * because the key is what forty already-submitted answers are stored against.
 * Regenerating it on a rename would orphan every one of them, silently, and the
 * attendee list would show forty blank cells under the new heading.
 */
const fieldKey = (label, taken) => {
    const base = str(label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'field';

    let key = base;
    let n = 2;
    while (taken.has(key)) key = base + '_' + (n++);

    return key;
};

/**
 * The registration form an editor designed, cleaned (EVT-004).
 *
 * A field with no label is dropped: it is an empty row in the builder, not an
 * instruction, and rendering it gives the member an unlabelled box.
 *
 * A `select` with no options is demoted to `text` rather than dropped. The
 * editor plainly wanted to ask something, and a dropdown with nothing in it is
 * a control the member cannot answer — turning it into a text box keeps the
 * question askable while they finish the list.
 *
 * `options` is cleared for every other type. Leaving stale options on a field
 * switched from select to text is how a later switch back silently resurrects a
 * list the editor thought they had removed.
 */
const sanitizeRegistrationFields = (value) => {
    if (!Array.isArray(value)) return [];

    const taken = new Set();

    return value
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
            const label = str(item.label);
            if (!label) return null;

            let type = str(item.type).toLowerCase();
            if (!FIELD_TYPES.includes(type)) type = 'text';

            const options = Array.isArray(item.options)
                ? item.options.map((option) => str(option)).filter(Boolean)
                : [];

            if (type === 'select' && !options.length) type = 'text';

            // An existing key is preserved; a new field gets one derived once.
            const existing = str(item.key);
            const key = existing && !taken.has(existing) ? existing : fieldKey(label, taken);
            taken.add(key);

            return {
                key,
                label,
                type,
                required: item.required === true || item.required === 'true',
                placeholder: str(item.placeholder),
                helpText: str(item.helpText),
                options: type === 'select' ? options : []
            };
        })
        .filter(Boolean);
};

/**
 * A member's answers, checked against the form the event actually declares.
 *
 * Driven by the EVENT's field list, never by what the client sent. A payload is
 * free to carry keys for fields that do not exist, or to omit ones that do, and
 * neither may decide what gets stored — otherwise a member could skip a
 * required question by simply not sending it, and an attacker could write
 * arbitrary keys into the attendee list.
 *
 * `label` is copied in at this moment on purpose: see the note on `responses`
 * in the registration model. The answer keeps the wording it was given under.
 */
const buildResponses = (fields = [], payload = {}) => {
    const answers = payload && typeof payload === 'object' ? payload : {};

    return (fields || []).map((field) => {
        const raw = answers[field.key];

        // A checkbox is the one type whose "unanswered" is a real answer.
        const value = field.type === 'checkbox'
            ? (raw === true || raw === 'true' ? 'Yes' : 'No')
            : str(raw);

        if (field.required && field.type !== 'checkbox' && !value) {
            throw ApiError.badRequest(field.label + ' is required');
        }
        if (field.required && field.type === 'checkbox' && value !== 'Yes') {
            throw ApiError.badRequest(field.label + ' must be ticked');
        }

        /*
         * A select answer must be one of ITS OWN options.
         *
         * Not a formality: the options are the organiser's categories — a
         * delegate class, a meal choice, a session stream — and an answer
         * outside them is one nothing downstream can count. Checked
         * case-insensitively and stored in the option's own spelling, so a
         * client sending "veg" records "Vegetarian".
         */
        if (field.type === 'select' && value) {
            const match = (field.options || [])
                .find((option) => option.toLowerCase() === value.toLowerCase());

            if (!match) throw ApiError.badRequest('"' + value + '" is not an option for ' + field.label);

            return { key: field.key, label: field.label, value: match };
        }

        return { key: field.key, label: field.label, value };
    });
};

/**
 * The region list an editor chose, cleaned.
 *
 * Three rules, and each one exists because the alternative fails silently:
 *
 *   A TARGET WITH NO STATE IS DROPPED. `{ district: 'Ariyalur' }` names a
 *   district in no particular state, and district names are not unique across
 *   India — matching it would deliver the event to every Ariyalur there is.
 *   The picker cannot produce one; a hand-made request can.
 *
 *   A NARROWER FIELD WITHOUT ITS PARENT IS DROPPED. `{ state, block }` with no
 *   district is a block floating inside a whole state. `regionMatch` would
 *   require both state AND block to match and ignore the gap, which reads as
 *   correct until two districts in one state have a block of the same name.
 *
 *   DUPLICATES ARE COLLAPSED. Picking the same block twice is an editor
 *   double-clicking, not an instruction, and a duplicate entry would double
 *   every `$elemMatch` the query does for no change in audience.
 *
 * Order is preserved, because the FIRST entry becomes the legacy
 * `state`/`district`/`block` the mobile app reads — so the editor's first
 * choice is the one that reaches an older client, which is the one they are
 * most likely to have meant.
 */
const sanitizeTargets = (value) => {
    if (!Array.isArray(value)) return [];

    const seen = new Set();

    return value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
            state: str(item.state),
            district: str(item.district),
            block: str(item.block)
        }))
        .filter((target) => {
            if (!target.state) return false;
            if (target.block && !target.district) return false;

            const key = [target.state, target.district, target.block].join(' ').toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);

            return true;
        });
};

/**
 * The agenda and speaker arrays arrive as JSON strings from a multipart form.
 *
 * The banner upload makes the create/update requests `multipart/form-data`, and
 * every field in a multipart body is a string — an array sent alongside a file
 * arrives as `"[{\"title\":\"Keynote\"}]"`, not as an array. Parsed here so both
 * transports work through one code path; a JSON body still passes real arrays
 * and falls straight through.
 */
function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;

    try {
        return JSON.parse(value);
    } catch {
        return [];
    }
}

class EventService {
    /**
     * List events.
     *
     * `context` carries who is asking: `isAdmin` opens drafts and every
     * audience, `isPaid` opens the members-only ones. It is built by
     * `resolveMemberContext` from the database, never from what the client
     * claims — the `includeDrafts` flag this used to take was set by the route,
     * and the audience gate needs the same guarantee.
     */
    async listEvents(filters = {}, context = {}) {
        const isAdmin = !!context.isAdmin;
        const query = {};

        if (!isAdmin) {
            query.status = 'published';
            /*
             * A member who has not paid sees only the open events. An admin
             * sees everything, so they can check what they just published.
             *
             * `$ne: 'paid'` rather than `= 'all'`, and the difference is not
             * cosmetic. `audience` was added after the first events were
             * written, so those documents have no such key — and an equality
             * match on a missing field matches nothing. The whole published
             * programme therefore vanished for every member who had not paid:
             * measured against live data, an unpaid member's event list came
             * back with zero of five published events.
             *
             * Asking "is this explicitly restricted" instead of "is this
             * explicitly public" is also the safer question. Only a document
             * that actually says `paid` is withheld, which matches the schema's
             * own `default: 'all'` and keeps a row written by any other path
             * visible rather than silently hidden.
             */
            if (!context.isPaid) query.audience = { $ne: 'paid' };
        } else if (filters.status && filters.status !== 'all') {
            const status = str(filters.status).toLowerCase();
            if (['draft', 'published'].includes(status)) query.status = status;
        }

        if (filters.audience && ['all', 'paid'].includes(str(filters.audience).toLowerCase())) {
            query.audience = str(filters.audience).toLowerCase();
        }

        if (str(filters.upcoming) === 'true') {
            query.startAt = { $gte: new Date() };
        }

        /*
         * WHERE the caller is, not just who they are.
         *
         * `state`/`district`/`block` on an event are its targeting, and empty
         * means everywhere — the same contract `announcement.model.js` states
         * and the same clause it uses, so a notice and an event aimed at one
         * block reach exactly the same people. The fields have been on this
         * schema since it was written and NOTHING read them: an event created
         * for one block was delivered to every member in the country.
         *
         * An admin is filtered too, but by their own patch rather than exempted:
         * a block admin's dashboard should show the events their block is
         * expected to attend. `super_admin` is the exception — it has no patch,
         * and the whole programme is what it is there to manage.
         */
        if (!isSuperAdmin(context)) {
            /*
             * One clause covering both eras of targeting: the legacy single
             * fields and the `targets` list. See `multiTargetClause`.
             *
             * `reachEveryone` short-circuits it. That flag is the editor's
             * first box — "everyone in the association" — and it is stored
             * separately from `targets` precisely so an event can carry both:
             * the regions the editor ticked, remembered, and an instruction to
             * ignore them for now. Reading only the list would deliver such an
             * event to those regions alone, which is the opposite of what the
             * box says.
             */
            query.$and = [...(query.$and || []), {
                $or: [{ reachEveryone: true }, multiTargetViewerClause(context)]
            }];
        }

        const documents = await Event.find(query)
            .sort({ startAt: -1 })
            .limit(LIST_LIMIT)
            .lean()
            .catch(() => []);

        const events = documents || [];
        const counts = await this.countRegistrations(events.map((doc) => doc._id));
        const mine = await this.myRegistrationsFor(events.map((doc) => doc._id), context.id);

        return {
            events: events.map((doc) => toEvent(doc, {
                registeredCount: counts[String(doc._id)] || 0,
                myRegistration: mine[String(doc._id)] || null
            })),
            total: events.length
        };
    }

    async getEvent(id, context = {}) {
        if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw ApiError.badRequest('Invalid event id');

        const doc = await Event.findById(id).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Event not found');

        const isAdmin = !!context.isAdmin;
        if (!isAdmin) {
            if (doc.status !== 'published') throw ApiError.notFound('Event not found');
            if (doc.audience === 'paid' && !context.isPaid) {
                throw ApiError.forbidden('This event is for members with an active membership');
            }
        }

        /*
         * Targeted elsewhere is a 404, not a 403.
         *
         * The list already hides these; this closes the direct link. 404
         * rather than "not for you" because an event aimed at another block is
         * not a permission the caller could ever be granted — and the id came
         * from somewhere, so saying "exists, but not for you" leaks the
         * programme of a region they are not in.
         */
        // Must agree with the list query above, `reachEveryone` included — a
        // document the list admits and this one rejects is a working link that
        // 404s, and the reverse is a targeting rule walked around by pasting a
        // URL.
        if (!isSuperAdmin(context) && doc.reachEveryone !== true && !multiTargetsViewer(doc, context)) {
            throw ApiError.notFound('Event not found');
        }

        const counts = await this.countRegistrations([doc._id]);
        const mine = await this.myRegistrationsFor([doc._id], context.id);

        return toEvent(doc, {
            registeredCount: counts[String(doc._id)] || 0,
            myRegistration: mine[String(doc._id)] || null
        });
    }

    /**
     * Seats taken per event, in one aggregate rather than one query per row.
     *
     * Only `registered` counts. A cancelled seat is a row that stays for the
     * organiser's record and must not hold capacity against anyone.
     */
    async countRegistrations(eventIds = []) {
        const ids = (eventIds || []).filter(Boolean);
        if (!ids.length) return {};

        /*
         * A held-but-unpaid seat does not count against capacity.
         *
         * Someone who opened the checkout and closed the tab would otherwise
         * hold a place indefinitely, and on a capped event a handful of
         * abandoned checkouts would show "full" to members who were ready to
         * pay. `$ne: 'pending'` rather than `= 'paid'`: every seat written
         * before fees existed has no `payment` object at all, and an equality
         * match on a missing field matches nothing — which would have reported
         * zero attendees for the entire existing programme.
         */
        const rows = await EventRegistration.aggregate([
            {
                $match: {
                    eventId: { $in: ids },
                    status: 'registered',
                    'payment.status': { $ne: 'pending' }
                }
            },
            { $group: { _id: '$eventId', count: { $sum: 1 } } }
        ]).catch(() => []);

        return (rows || []).reduce((acc, row) => {
            acc[String(row._id)] = row.count;
            return acc;
        }, {});
    }

    /** This member's own seat on each of those events, keyed by event id. */
    async myRegistrationsFor(eventIds = [], userId = '') {
        const ids = (eventIds || []).filter(Boolean);
        if (!ids.length || !userId) return {};

        const rows = await EventRegistration.find({ eventId: { $in: ids }, userId: String(userId) })
            .lean()
            .catch(() => []);

        return (rows || []).reduce((acc, row) => {
            acc[String(row.eventId)] = toRegistration(row);
            return acc;
        }, {});
    }

    async createEvent(payload = {}, actor = {}) {
        const data = sanitize(payload);

        /*
         * No field is required — see the note at the top of the event schema.
         *
         * A malformed date is still rejected, by `sanitize`: "not a date I can
         * read" and "no date yet" are different answers, and accepting the first
         * silently as the second discards something the caller did send.
         */

        const created = await Event.create({
            ...data,
            status: data.status || 'draft',
            /*
             * This endpoint is the ASSOCIATION'S programme.
             *
             * `/events` is what the mobile super admin posts through, and what it
             * posts belongs to member dashboards — the onboarding site is the
             * CMS's, and the CMS says `public` explicitly when it means it. The
             * schema's own default is `public` so that events written before the
             * field existed keep the visibility they have; a NEW row created
             * here would inherit that default and land on the marketing site,
             * which is the one place it must not be.
             */
            channel: data.channel === 'public' ? 'public' : 'members',
            createdBy: str(actor.email).toLowerCase()
        });

        const event = toEvent(created.toObject());
        await auditService.record({
            action: 'event.created',
            category: 'event',
            summary: 'Super Admin created event "' + event.title + '"',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: event.id,
            targetLabel: event.title,
            state: event.state,
            metadata: { status: event.status, audience: event.audience }
        });

        return event;
    }

    async updateEvent(id, payload = {}) {
        if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw ApiError.badRequest('Invalid event id');

        const data = sanitize(payload);
        if (data.title !== undefined && !data.title) throw ApiError.badRequest('Title cannot be empty');

        const updated = await Event.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
            .lean()
            .catch(() => null);
        if (!updated) throw ApiError.notFound('Event not found');

        return toEvent(updated);
    }

    async setStatus(id, status, actor = {}) {
        const event = await this.updateEvent(id, { status });

        await auditService.record({
            action: event.status === 'published' ? 'event.published' : 'event.unpublished',
            category: 'event',
            summary: 'Super Admin ' + (event.status === 'published' ? 'published' : 'unpublished') +
                ' event "' + event.title + '"',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: event.id,
            targetLabel: event.title,
            state: event.state
        });

        return event;
    }

    async deleteEvent(id, actor = {}) {
        if (!mongoose.Types.ObjectId.isValid(String(id || ''))) throw ApiError.badRequest('Invalid event id');

        const removed = await Event.findByIdAndDelete(id).lean().catch(() => null);
        if (!removed) throw ApiError.notFound('Event not found');

        // The seats go with the event. Leaving them would orphan every row and
        // keep the member's "you are registered" badge pointing at nothing.
        await EventRegistration.deleteMany({ eventId: removed._id }).catch(() => null);

        await auditService.record({
            action: 'event.deleted',
            category: 'event',
            summary: 'Super Admin deleted event "' + (removed.title || 'Untitled') + '"',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: String(id),
            targetLabel: removed.title || '',
            state: removed.state || ''
        });

        return { id: String(id), deleted: true };
    }

    /**
     * How many members this targeting and this audience would actually reach.
     *
     * Written because of a real failure that nothing reported. An event was
     * aimed at one block AND marked members-only; the block's only member had
     * not paid; the event reached nobody and every screen said it was
     * published. Region targeting and the audience switch are two independent
     * filters sitting next to each other on one form, and their INTERSECTION is
     * what an editor is actually choosing — which neither control shows.
     *
     * So the editor gets the number before they press Save. A count of zero is
     * not an error and is not blocked: aiming an event at a region the
     * association has not signed anyone up in yet is a perfectly reasonable
     * thing to do the week before a membership drive. It is only something the
     * editor must be told, rather than discover from a member asking why they
     * never heard about it.
     *
     * Counted against the member collection with the same clause the member
     * list uses, inverted: there, one viewer against many events; here, one
     * event against many viewers. Reusing `multiTargetClause` is not possible —
     * it builds a filter over CONTENT — so the region test is done per member
     * region rather than per event, which is why this queries members directly.
     */
    async reach({ targets = [], audience = 'all' } = {}) {
        const MemberDetails = require('../members/memberdetails.model');
        const { PAID_STATUSES } = require('../common/memberContext');

        const clean = sanitizeTargets(Array.isArray(targets) ? targets : parseMaybeJson(targets));

        const query = { isActive: { $ne: false } };

        // The audience half of the intersection.
        if (String(audience).toLowerCase() === 'paid') {
            query.membershipStatus = { $in: PAID_STATUSES };
        }

        /*
         * The region half.
         *
         * A member is reached when they stand inside ANY target. Each target is
         * a scope read left to right, so an entry naming only a state matches
         * every member in it — which is why the clause is built from the fields
         * the target actually specifies rather than from all three.
         */
        if (clean.length) {
            query.$or = clean.map((target) => {
                const clause = {};

                ['state', 'district', 'block'].forEach((field) => {
                    const pattern = regionPattern(target[field]);
                    if (pattern) clause[field] = pattern;
                });

                return clause;
            });
        }

        const members = await MemberDetails.countDocuments(query).catch(() => 0);

        return {
            members,
            targets: clean,
            audience: String(audience).toLowerCase() === 'paid' ? 'paid' : 'all',
            /*
             * How many of those would be lost by keeping the members-only
             * switch on. The single most useful number here: it names the cost
             * of the setting that silently emptied the audience.
             */
            excludedByAudience: String(audience).toLowerCase() === 'paid'
                ? Math.max(0, await MemberDetails.countDocuments({
                    ...query,
                    membershipStatus: { $nin: PAID_STATUSES }
                }).catch(() => 0))
                : 0
        };
    }

    // ======================================================== registration

    /**
     * Take a seat.
     *
     * Every refusal is checked here and not in the UI, because the UI's copy of
     * these rules is a convenience and this is the rule. In order: the event
     * must exist and be visible to this member, registration must be open, the
     * cutoff must not have passed, and there must be a seat — or the member
     * joins the waitlist rather than being turned away.
     */
    async register(eventId, context = {}, payload = {}) {
        const event = await this.getEvent(eventId, context);

        if (!event.registrationEnabled) {
            throw ApiError.badRequest('This event is not taking registrations');
        }

        const closesAt = event.registrationClosesAt ? new Date(event.registrationClosesAt) : null;
        if (closesAt && closesAt.getTime() < Date.now()) {
            throw ApiError.badRequest('Registration for this event has closed');
        }

        if (!context.id) throw ApiError.unauthorized('No member on this token');

        const existing = await EventRegistration.findOne({ eventId, userId: String(context.id) })
            .lean()
            .catch(() => null);

        /*
         * Already holding a seat — but an unpaid hold is not a registration.
         *
         * A member who abandoned the payment step and pressed Register again is
         * not making a mistake; they are trying to finish. Answering "you are
         * already registered" would strand them on a seat they can never
         * confirm and can only cancel. So a pending payment falls through and
         * the seat is rewritten below with a fresh reference.
         */
        const settled = !existing
            || !existing.payment
            || existing.payment.status !== 'pending';

        if (existing && existing.status !== 'cancelled' && settled) {
            return { ...toRegistration(existing), alreadyRegistered: true };
        }

        const taken = event.registeredCount || 0;
        const full = event.capacity > 0 && taken >= event.capacity;

        /*
         * A fee turns one step into two.
         *
         * The seat is written now with `payment.status: 'pending'` and becomes a
         * confirmed registration when `payRegistration` settles it. Writing it
         * up front rather than after payment is what lets the member close the
         * tab and come back to a checkout that is still there — and
         * `countRegistrations` excludes pending rows, so a hold that is never
         * completed costs nobody else a seat.
         *
         * A waitlisted seat is never charged. Taking money for a place that
         * does not exist yet is the one outcome nobody would defend, so the fee
         * is owed only once a real seat is held.
         */
        const fee = Math.max(0, Math.round(Number(event.registrationFee || 0)));
        const chargeable = fee > 0 && !full;

        /*
         * The event's own questions, answered.
         *
         * Built from the EVENT's declared fields rather than from the payload,
         * so a client cannot skip a required question by omitting it or write a
         * key the organiser never asked for. Throws before anything is written:
         * a half-filled registration is worse than none, because the member
         * believes they are on the list.
         */
        const responses = buildResponses(event.registrationFields, payload.responses);

        const seat = {
            eventId,
            userId: String(context.id),
            memberName: str(payload.memberName) || context.fullName || '',
            email: str(payload.email).toLowerCase() || context.email || '',
            phone: str(payload.phone),
            organization: str(payload.organization),
            state: context.state || '',
            district: context.district || '',
            block: context.block || '',
            status: full ? 'waitlist' : 'registered',
            note: str(payload.note),
            responses,
            registeredAt: new Date(),
            cancelledAt: null,
            payment: {
                status: chargeable ? 'pending' : 'not_required',
                amount: chargeable ? fee : 0,
                reference: chargeable ? newPaymentReference() : '',
                method: '',
                paidAt: null
            }
        };

        // Re-registering reuses the cancelled row: the unique index below means
        // an insert would fail anyway, and the member is the same person.
        if (existing) {
            const revived = await EventRegistration.findByIdAndUpdate(
                existing._id,
                { $set: seat },
                { new: true }
            ).lean();
            return toRegistration(revived);
        }

        try {
            const created = await EventRegistration.create(seat);
            return toRegistration(created.toObject());
        } catch (error) {
            // Two taps on a slow connection race past the check above; the
            // unique index catches the second, and "you are already registered"
            // is the honest answer to it.
            if (error && error.code === 11000) {
                const row = await EventRegistration.findOne({ eventId, userId: String(context.id) }).lean();
                return { ...toRegistration(row), alreadyRegistered: true };
            }
            throw error;
        }
    }

    /**
     * Settle the fee on a held seat — the dummy gateway (EVT-002).
     *
     * Deliberately a SEPARATE call from `register` rather than a flag on it.
     * Taking the seat and paying for it are two events with two failure modes:
     * a member can hold a seat and pay later, a payment can fail and be
     * retried, and a real gateway will one day call back into this step from
     * outside the browser entirely. Folding them into one endpoint would mean
     * unpicking them again the day a real gateway arrives.
     *
     * What makes it a DUMMY gateway is only that no money moves: the states, the
     * reference and the receipt are the real ones. Swapping in a provider means
     * verifying their signature here and writing the id they return into the
     * same `reference` field — nothing above or below this method changes.
     *
     * Idempotent. A second call on a settled seat returns it unchanged rather
     * than charging again, because a member refreshing a receipt page is not a
     * second purchase.
     */
    async payRegistration(eventId, context = {}, payload = {}) {
        if (!mongoose.Types.ObjectId.isValid(String(eventId || ''))) {
            throw ApiError.badRequest('Invalid event id');
        }
        if (!context.id) throw ApiError.unauthorized('No member on this token');

        const row = await EventRegistration.findOne({ eventId, userId: String(context.id) })
            .lean()
            .catch(() => null);

        if (!row) throw ApiError.notFound('You are not registered for this event');
        if (row.status === 'cancelled') {
            throw ApiError.badRequest('This registration was cancelled. Register again to take a seat.');
        }

        const payment = row.payment || {};
        if (payment.status === 'paid') {
            return { ...toRegistration(row), alreadyPaid: true };
        }
        if (payment.status !== 'pending') {
            // Nothing was owed. Saying so beats inventing a receipt for ₹0.
            return { ...toRegistration(row), alreadyPaid: true };
        }

        const method = str(payload.method).toLowerCase() || 'card';

        const settledRow = await EventRegistration.findByIdAndUpdate(
            row._id,
            {
                $set: {
                    'payment.status': 'paid',
                    'payment.method': method,
                    'payment.paidAt': new Date(),
                    // Keep the reference minted at registration: it is what the
                    // member has been looking at on the checkout screen.
                    'payment.reference': payment.reference || newPaymentReference()
                }
            },
            { new: true }
        ).lean();

        return toRegistration(settledRow);
    }

    /** Give the seat back. Idempotent: cancelling twice is not an error. */
    async cancelRegistration(eventId, context = {}) {
        if (!mongoose.Types.ObjectId.isValid(String(eventId || ''))) throw ApiError.badRequest('Invalid event id');
        if (!context.id) throw ApiError.unauthorized('No member on this token');

        const row = await EventRegistration.findOneAndUpdate(
            { eventId, userId: String(context.id) },
            { $set: { status: 'cancelled', cancelledAt: new Date() } },
            { new: true }
        ).lean().catch(() => null);

        if (!row) throw ApiError.notFound('You are not registered for this event');

        /*
         * Promote the longest-waiting person on the list into the seat.
         *
         * Without this a cancellation frees capacity that nobody is told about:
         * the count drops, the event stops looking full, and whoever happens to
         * open the page next takes the seat ahead of people who asked first.
         */
        await this.promoteFromWaitlist(eventId);

        return toRegistration(row);
    }

    async promoteFromWaitlist(eventId) {
        const event = await Event.findById(eventId).select('capacity').lean().catch(() => null);
        if (!event || !event.capacity) return null;

        const taken = await EventRegistration.countDocuments({ eventId, status: 'registered' }).catch(() => 0);
        if (taken >= event.capacity) return null;

        const next = await EventRegistration.findOneAndUpdate(
            { eventId, status: 'waitlist' },
            { $set: { status: 'registered' } },
            { new: true, sort: { registeredAt: 1 } }
        ).lean().catch(() => null);

        return next ? toRegistration(next) : null;
    }

    /** The organiser's attendee list. Super admin only — the route enforces it. */
    async listRegistrations(eventId, filters = {}) {
        if (!mongoose.Types.ObjectId.isValid(String(eventId || ''))) throw ApiError.badRequest('Invalid event id');

        const query = { eventId };
        const status = str(filters.status).toLowerCase();
        if (['registered', 'waitlist', 'cancelled'].includes(status)) query.status = status;

        const rows = await EventRegistration.find(query)
            .sort({ status: 1, registeredAt: 1 })
            .limit(2000)
            .lean()
            .catch(() => []);

        const counts = (rows || []).reduce((acc, row) => {
            const key = row.status || 'registered';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        return {
            registrations: (rows || []).map(toRegistration),
            total: (rows || []).length,
            counts
        };
    }

    /** Everything this member has a seat at, with the event attached. */
    async myRegistrations(context = {}) {
        if (!context.id) return { registrations: [], total: 0 };

        const rows = await EventRegistration.find({ userId: String(context.id), status: { $ne: 'cancelled' } })
            .sort({ registeredAt: -1 })
            .lean()
            .catch(() => []);

        const events = await Event.find({ _id: { $in: (rows || []).map((row) => row.eventId) } })
            .lean()
            .catch(() => []);

        const byId = (events || []).reduce((acc, doc) => {
            acc[String(doc._id)] = toEvent(doc);
            return acc;
        }, {});

        return {
            registrations: (rows || []).map((row) => ({
                ...toRegistration(row),
                event: byId[String(row.eventId)] || null
            })),
            total: (rows || []).length
        };
    }
}

module.exports = new EventService();
module.exports.toEvent = toEvent;
module.exports.toRegistration = toRegistration;
module.exports.sanitizeAgenda = sanitizeAgenda;
module.exports.sanitizeSpeakers = sanitizeSpeakers;
module.exports.sanitizeReminders = sanitizeReminders;
module.exports.toClockTime = toClockTime;
module.exports.registrationClosesAt = registrationClosesAt;
// Shared with `cms.service`, which writes the same collection through its own
// editor and must clean targeting identically or the two screens disagree.
module.exports.sanitizeTargets = sanitizeTargets;
module.exports.sanitizeRegistrationFields = sanitizeRegistrationFields;
module.exports.buildResponses = buildResponses;
