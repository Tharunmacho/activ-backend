const mongoose = require('mongoose');
const Announcement = require('./announcement.model');
const ApiError = require('../../core/utils/ApiError');
const auditService = require('../audit/audit.service');
const { audienceClause, targetLabel, targetDepth } = require('../common/regionMatch');

const FEED_LIMIT = 50;
const ADMIN_LIMIT = 200;
const CATEGORIES = ['general', 'notice', 'policy', 'scheme', 'achievement', 'urgent'];

const str = (value) => String(value === null || value === undefined ? '' : value).trim();

/**
 * A readable standfirst when the editor did not write one.
 *
 * Tags are stripped before truncating, not after: the body may be rich text,
 * and cutting `<strong>Sivagan` at 160 characters leaves an unclosed tag that
 * takes the rest of the card's markup with it when React renders it as HTML.
 */
const excerpt = (body, limit = 180) => {
    const text = str(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;
    return text.slice(0, limit).replace(/\s+\S*$/, '') + '…';
};

const toAnnouncement = (doc = {}) => ({
    id: doc._id ? String(doc._id) : '',
    title: doc.title || '',
    summary: doc.summary || excerpt(doc.body),
    body: doc.body || '',
    category: doc.category || 'general',
    state: doc.state || '',
    district: doc.district || '',
    block: doc.block || '',
    /** "Tamil Nadu › Sivaganga", or empty when it went to everyone. */
    targetLabel: targetLabel(doc),
    audience: doc.audience || 'all',
    bannerUrl: doc.bannerUrl || '',
    bannerAlt: doc.bannerAlt || '',
    attachmentUrl: doc.attachmentUrl || '',
    attachmentLabel: doc.attachmentLabel || '',
    pinned: !!doc.pinned,
    status: doc.status || 'draft',
    // Falls back to `createdAt` for the rows written before `publishedAt`
    // existed, so nothing in the feed renders with a blank date.
    publishedAt: doc.publishedAt || doc.createdAt || null,
    expiresAt: doc.expiresAt || null,
    createdBy: doc.createdBy || '',
    createdAt: doc.createdAt || null
});

/** Only the fields a client may set, coerced. Throws on anything malformed. */
const sanitize = (payload = {}) => {
    const out = {};

    ['title', 'summary', 'body', 'state', 'district', 'block',
        'bannerUrl', 'bannerAlt', 'attachmentUrl', 'attachmentLabel'
    ].forEach((key) => {
        if (payload[key] !== undefined) out[key] = str(payload[key]);
    });

    if (payload.category !== undefined) {
        const category = str(payload.category).toLowerCase() || 'general';
        if (!CATEGORIES.includes(category)) {
            throw ApiError.badRequest('category must be one of: ' + CATEGORIES.join(', '));
        }
        out.category = category;
    }

    if (payload.audience !== undefined) {
        const audience = str(payload.audience).toLowerCase() || 'all';
        if (!['all', 'paid'].includes(audience)) {
            throw ApiError.badRequest("audience must be 'all' or 'paid'");
        }
        out.audience = audience;
    }

    if (payload.pinned !== undefined) {
        out.pinned = payload.pinned === true || payload.pinned === 'true';
    }

    if (payload.status !== undefined) {
        const status = str(payload.status).toLowerCase();
        if (!['draft', 'published'].includes(status)) {
            throw ApiError.badRequest("status must be 'draft' or 'published'");
        }
        out.status = status;
    }

    if (payload.expiresAt !== undefined) {
        if (payload.expiresAt === null || payload.expiresAt === '') {
            out.expiresAt = null;
        } else {
            const expires = new Date(payload.expiresAt);
            if (Number.isNaN(expires.getTime())) throw ApiError.badRequest('expiresAt is not a valid date');
            out.expiresAt = expires;
        }
    }

    return out;
};

const requireId = (id) => {
    if (!mongoose.Types.ObjectId.isValid(String(id || ''))) {
        throw ApiError.badRequest('Invalid announcement id');
    }
};

/**
 * `publishedAt` follows `status`, in both directions.
 *
 * Set on the way to published and only if it is not already set, so editing a
 * live update does not re-date it to the top of everyone's feed. Cleared on the
 * way back to draft, so an update pulled and re-published is dated when it
 * actually reappeared rather than when it first went out.
 */
const withPublishStamp = (data, current) => {
    if (data.status === undefined) return data;

    if (data.status === 'published') {
        return current && current.publishedAt
            ? data
            : { ...data, publishedAt: new Date() };
    }
    return { ...data, publishedAt: null };
};

class AnnouncementService {
    /**
     * The member feed: published, in date, targeted at them, and allowed to them.
     *
     * Pinned first, then newest. The sort is applied in memory after a
     * `targetDepth` tiebreak, so that among items pinned on the same day the
     * most local one leads — a block notice matters more to the member standing
     * in that block than a national one published the same morning.
     */
    async listForMember(context = {}, filters = {}) {
        const now = new Date();

        const query = {
            status: 'published',
            $and: [
                // Targeted at this member's regions — see regionMatch.js.
                ...audienceClause(context).$and,
                // Still in date. An update with no expiry never expires.
                { $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] }
            ]
        };

        // An admin previewing the feed is not a paid member and must still see
        // the paid-only items, or they cannot check what they just published.
        if (!context.isPaid && !context.isAdmin) {
            query.audience = 'all';
        }

        if (filters.category && CATEGORIES.includes(str(filters.category).toLowerCase())) {
            query.category = str(filters.category).toLowerCase();
        }

        const limit = Math.min(Number(filters.limit) || FEED_LIMIT, FEED_LIMIT);

        const documents = await Announcement.find(query)
            .sort({ pinned: -1, publishedAt: -1 })
            .limit(limit)
            .lean()
            .catch(() => []);

        const rows = (documents || []).map(toAnnouncement);

        rows.sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

            const depth = targetDepth(b) - targetDepth(a);
            if (depth !== 0) return depth;

            return new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0);
        });

        return { announcements: rows, total: rows.length };
    }

    /** One update, with the same visibility rules the feed applies. */
    async getForMember(id, context = {}) {
        requireId(id);

        const doc = await Announcement.findById(id).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Update not found');

        const isAdmin = !!context.isAdmin;

        if (!isAdmin) {
            if (doc.status !== 'published') throw ApiError.notFound('Update not found');
            if (doc.audience === 'paid' && !context.isPaid) {
                throw ApiError.forbidden('This update is for members with an active membership');
            }
        }

        return toAnnouncement(doc);
    }

    /** Everything, drafts included. Super admin only — the route enforces it. */
    async listForAdmin(filters = {}) {
        const query = {};

        const status = str(filters.status).toLowerCase();
        if (['draft', 'published'].includes(status)) query.status = status;

        const category = str(filters.category).toLowerCase();
        if (CATEGORIES.includes(category)) query.category = category;

        const documents = await Announcement.find(query)
            .sort({ pinned: -1, publishedAt: -1, createdAt: -1 })
            .limit(ADMIN_LIMIT)
            .lean()
            .catch(() => []);

        return { announcements: (documents || []).map(toAnnouncement), total: (documents || []).length };
    }

    async create(payload = {}, actor = {}) {
        const data = sanitize(payload);

        if (!data.title) throw ApiError.badRequest('An update needs a title');
        if (!data.body && !data.summary) throw ApiError.badRequest('An update needs something to say');

        const created = await Announcement.create(withPublishStamp({
            ...data,
            status: data.status || 'draft'
        }, null));

        const announcement = toAnnouncement(created.toObject());

        await auditService.record({
            action: 'announcement.created',
            category: 'content',
            summary: 'Super Admin created update "' + announcement.title + '"',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: announcement.id,
            targetLabel: announcement.title,
            state: announcement.state,
            metadata: { status: announcement.status, audience: announcement.audience }
        });

        return announcement;
    }

    async update(id, payload = {}) {
        requireId(id);

        const data = sanitize(payload);
        if (data.title !== undefined && !data.title) throw ApiError.badRequest('Title cannot be empty');

        const current = await Announcement.findById(id).select('publishedAt').lean().catch(() => null);
        if (!current) throw ApiError.notFound('Update not found');

        const updated = await Announcement.findByIdAndUpdate(
            id,
            { $set: withPublishStamp(data, current) },
            { new: true, runValidators: true }
        ).lean().catch(() => null);

        if (!updated) throw ApiError.notFound('Update not found');
        return toAnnouncement(updated);
    }

    async setStatus(id, status, actor = {}) {
        const announcement = await this.update(id, { status });

        await auditService.record({
            action: announcement.status === 'published' ? 'announcement.published' : 'announcement.unpublished',
            category: 'content',
            summary: 'Super Admin ' + (announcement.status === 'published' ? 'published' : 'unpublished') +
                ' update "' + announcement.title + '"',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: announcement.id,
            targetLabel: announcement.title,
            state: announcement.state
        });

        return announcement;
    }

    async remove(id, actor = {}) {
        requireId(id);

        const removed = await Announcement.findByIdAndDelete(id).lean().catch(() => null);
        if (!removed) throw ApiError.notFound('Update not found');

        await auditService.record({
            action: 'announcement.deleted',
            category: 'content',
            summary: 'Super Admin deleted update "' + (removed.title || 'Untitled') + '"',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: String(id),
            targetLabel: removed.title || '',
            state: removed.state || ''
        });

        return { id: String(id), deleted: true };
    }
}

module.exports = new AnnouncementService();
module.exports.CATEGORIES = CATEGORIES;
module.exports.toAnnouncement = toAnnouncement;
module.exports.excerpt = excerpt;
