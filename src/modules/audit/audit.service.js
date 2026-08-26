const mongoose = require('mongoose');
const AuditLog = require('./audit.model');
const logger = require('../../config/logger');

const LIST_LIMIT = 50;

const ROLE_LABELS = {
    block_admin: 'Block Admin',
    district_admin: 'District Admin',
    state_admin: 'State Admin',
    super_admin: 'Super Admin',
    member: 'Member'
};

const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toEntry = (doc = {}) => ({
    id: doc._id ? doc._id.toString() : '',
    action: doc.action || '',
    category: doc.category || '',
    summary: doc.summary || '',
    actorName: doc.actorName || '',
    actorEmail: doc.actorEmail || '',
    actorRole: doc.actorRole || '',
    actorRoleLabel: ROLE_LABELS[doc.actorRole] || 'Admin',
    proxy: !!doc.proxy,
    targetId: doc.targetId || '',
    targetLabel: doc.targetLabel || '',
    location: [doc.block, doc.district, doc.state].filter(Boolean).join(', '),
    metadata: doc.metadata || null,
    createdAt: doc.createdAt || null
});

class AuditService {
    /**
     * Append one entry.
     *
     * Never throws and never rejects: an audit write failing must not roll back
     * or block the action it is describing. A lost log line is recoverable; a
     * failed approval because logging broke is not.
     */
    async record(entry = {}) {
        try {
            const actorEmail = String(entry.actorEmail || '').toLowerCase();

            // Resolve the actor's name once, at write time, so the entry keeps
            // reading correctly after that admin is renamed or hard-deleted.
            let actorName = String(entry.actorName || '').trim();
            if (!actorName && actorEmail) {
                const doc = await mongoose.connection.db.collection('admins').findOne(
                    { email: new RegExp(`^${escapeRegex(actorEmail)}$`, 'i') },
                    { projection: { fullName: 1, name: 1 } }
                ).catch(() => null);
                actorName = doc?.fullName || doc?.name || '';
            }

            await AuditLog.create({
                action: entry.action || 'unknown',
                category: entry.category || 'application',
                summary: entry.summary || entry.action || 'Action recorded',
                actorId: String(entry.actorId || ''),
                actorEmail,
                actorRole: String(entry.actorRole || ''),
                actorName: actorName || actorEmail || 'Unknown admin',
                proxy: !!entry.proxy,
                targetId: String(entry.targetId || ''),
                targetLabel: String(entry.targetLabel || ''),
                state: String(entry.state || ''),
                district: String(entry.district || ''),
                block: String(entry.block || ''),
                metadata: entry.metadata || undefined
            });
        } catch (err) {
            logger.warn('Audit log write failed', { action: entry?.action, error: err?.message });
        }
    }

    /** The audit stream, newest first. */
    async list(filters = {}) {
        const page = Math.max(1, parseInt(filters.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || LIST_LIMIT));

        const query = {};
        const category = String(filters.category || 'all').toLowerCase();
        if (['application', 'admin', 'event'].includes(category)) query.category = category;

        const term = String(filters.q || '').trim();
        if (term.length >= 2) {
            const pattern = new RegExp(escapeRegex(term), 'i');
            query.$or = [
                { summary: pattern },
                { actorName: pattern },
                { actorEmail: pattern },
                { targetLabel: pattern }
            ];
        }

        const [documents, total] = await Promise.all([
            AuditLog.find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .lean()
            .catch(() => []),
            AuditLog.countDocuments(query).catch(() => 0)
        ]);

        return {
            entries: (documents || []).map(toEntry),
            pagination: {
                page,
                limit,
                total: total || 0,
                pages: Math.max(1, Math.ceil((total || 0) / limit))
            }
        };
    }

    /** Counts per category, for the stream's filter pills. */
    async counts() {
        const categories = ['application', 'admin', 'event'];
        const totals = await Promise.all(
            categories.map(category => AuditLog.countDocuments({ category }).catch(() => 0))
        );

        const counts = { all: 0 };
        categories.forEach((category, index) => {
            counts[category] = totals[index] || 0;
            counts.all += totals[index] || 0;
        });
        return counts;
    }
}

module.exports = new AuditService();
module.exports.ROLE_LABELS = ROLE_LABELS;
