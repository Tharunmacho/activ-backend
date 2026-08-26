const mongoose = require('mongoose');

/**
 * An immutable record of one critical action on the platform.
 *
 * Nothing in the codebase updates or deletes these documents and no route
 * exposes a write other than the append in audit.service — that is the whole
 * point. If an application was wrongly rejected, this collection is the only
 * place that still says who pressed the button.
 *
 * Actor details are denormalised at write time on purpose: the log must keep
 * reading correctly after the admin who acted has been renamed or deleted.
 */
const auditLogSchema = new mongoose.Schema({
    // Dotted verb, e.g. 'application.approved', 'admin.deleted'.
    action: {
        type: String,
        required: true,
        index: true
    },
    category: {
        type: String,
        enum: ['application', 'admin', 'event'],
        required: true,
        index: true
    },
    /** The one-line sentence the audit stream renders. */
    summary: {
        type: String,
        required: true,
        trim: true
    },

    actorId: { type: String, default: '' },
    actorEmail: { type: String, default: '', index: true },
    actorRole: { type: String, default: '' },
    actorName: { type: String, default: '' },
    /** True when a super admin acted in place of the tier that owed the decision. */
    proxy: { type: Boolean, default: false },

    targetId: { type: String, default: '', index: true },
    targetLabel: { type: String, default: '' },

    // Where the action landed, so the stream can be read region by region.
    state: { type: String, default: '' },
    district: { type: String, default: '' },
    block: { type: String, default: '' },

    metadata: { type: mongoose.Schema.Types.Mixed }
}, {
    collection: 'audit_logs',
    // No updatedAt: these documents are never modified.
    timestamps: { createdAt: true, updatedAt: false }
});

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
