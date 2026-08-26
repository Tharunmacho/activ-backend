const mongoose = require('mongoose');
const Event = require('./event.model');
const ApiError = require('../../core/utils/ApiError');
const auditService = require('../audit/audit.service');

const LIST_LIMIT = 100;

const toEvent = (doc = {}) => ({
    id: doc._id ? doc._id.toString() : '',
    title: doc.title || '',
    description: doc.description || '',
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    venue: doc.venue || '',
    state: doc.state || '',
    district: doc.district || '',
    block: doc.block || '',
    bannerUrl: doc.bannerUrl || '',
    status: doc.status || 'draft',
    createdBy: doc.createdBy || '',
    createdAt: doc.createdAt || null
});

/** Only the fields a client is allowed to set, coerced and trimmed. */
const sanitize = (payload = {}) => {
    const out = {};
    const text = (key) => {
        if (payload[key] === undefined) return;
        out[key] = String(payload[key] || '').trim();
    };

    text('title');
    text('description');
    text('venue');
    text('state');
    text('district');
    text('block');
    text('bannerUrl');

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
        const status = String(payload.status || '').toLowerCase();
        if (!['draft', 'published'].includes(status)) {
            throw ApiError.badRequest("status must be 'draft' or 'published'");
        }
        out.status = status;
    }

    if (out.startAt && out.endAt && out.endAt < out.startAt) {
        throw ApiError.badRequest('endAt cannot be before startAt');
    }

    return out;
};

class EventService {
    /**
     * List events. Non-admin callers only ever see published ones — the
     * `includeDrafts` flag is set by the route, never by the client.
     */
    async listEvents(filters = {}, includeDrafts = false) {
        const query = {};

        if (!includeDrafts) {
            query.status = 'published';
        } else if (filters.status && filters.status !== 'all') {
            const status = String(filters.status).toLowerCase();
            if (['draft', 'published'].includes(status)) query.status = status;
        }

        const documents = await Event.find(query)
            .sort({ startAt: -1 })
            .limit(LIST_LIMIT)
            .lean()
            .catch(() => []);

        return { events: (documents || []).map(toEvent), total: (documents || []).length };
    }

    async getEvent(id, includeDrafts = false) {
        if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid event id');

        const doc = await Event.findById(id).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Event not found');
        if (!includeDrafts && doc.status !== 'published') throw ApiError.notFound('Event not found');

        return toEvent(doc);
    }

    async createEvent(payload = {}, actor = {}) {
        const data = sanitize(payload);

        if (!data.title) throw ApiError.badRequest('Title is required');
        if (!data.startAt) throw ApiError.badRequest('Start date is required');

        const created = await Event.create({
            ...data,
            status: data.status || 'draft',
            createdBy: String(actor.email || '').toLowerCase()
        });

        const event = toEvent(created.toObject());
        await auditService.record({
            action: 'event.created',
            category: 'event',
            summary: `Super Admin created event "${event.title}"`,
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: event.id,
            targetLabel: event.title,
            state: event.state,
            metadata: { status: event.status }
        });

        return event;
    }

    async updateEvent(id, payload = {}) {
        if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid event id');

        const data = sanitize(payload);
        if (data.title !== undefined && !data.title) throw ApiError.badRequest('Title cannot be empty');

        const updated = await Event.findByIdAndUpdate(id, { $set: data }, { new: true }).lean().catch(() => null);
        if (!updated) throw ApiError.notFound('Event not found');

        return toEvent(updated);
    }

    async setStatus(id, status, actor = {}) {
        const event = await this.updateEvent(id, { status });

        await auditService.record({
            action: event.status === 'published' ? 'event.published' : 'event.unpublished',
            category: 'event',
            summary: `Super Admin ${event.status === 'published' ? 'published' : 'unpublished'} event "${event.title}"`,
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: event.id,
            targetLabel: event.title,
            state: event.state
        });

        return event;
    }

    async deleteEvent(id, actor = {}) {
        if (!mongoose.Types.ObjectId.isValid(id)) throw ApiError.badRequest('Invalid event id');

        const removed = await Event.findByIdAndDelete(id).lean().catch(() => null);
        if (!removed) throw ApiError.notFound('Event not found');

        await auditService.record({
            action: 'event.deleted',
            category: 'event',
            summary: `Super Admin deleted event "${removed.title || 'Untitled'}"`,
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: id,
            targetLabel: removed.title || '',
            state: removed.state || ''
        });

        return { id, deleted: true };
    }
}

module.exports = new EventService();
