const mongoose = require('mongoose');
const Event = require('./event.model');
const EventRegistration = require('./eventregistration.model');
const ApiError = require('../../core/utils/ApiError');
const auditService = require('../audit/audit.service');

const LIST_LIMIT = 100;

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

    if (out.startAt && out.endAt && out.endAt < out.startAt) {
        throw ApiError.badRequest('endAt cannot be before startAt');
    }

    return out;
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
            // A member who has not paid sees only the open events. An admin
            // sees everything, so they can check what they just published.
            if (!context.isPaid) query.audience = 'all';
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

        const rows = await EventRegistration.aggregate([
            { $match: { eventId: { $in: ids }, status: 'registered' } },
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

        if (!data.title) throw ApiError.badRequest('Title is required');
        if (!data.startAt) throw ApiError.badRequest('Start date is required');

        const created = await Event.create({
            ...data,
            status: data.status || 'draft',
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

        if (existing && existing.status !== 'cancelled') {
            return { ...toRegistration(existing), alreadyRegistered: true };
        }

        const taken = event.registeredCount || 0;
        const full = event.capacity > 0 && taken >= event.capacity;

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
            registeredAt: new Date(),
            cancelledAt: null
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
