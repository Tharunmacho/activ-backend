const mongoose = require('mongoose');

const notificationLogSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true
    },
    event: {
        type: String,
        required: true,
        enum: [
            'ACCOUNT_REGISTERED',
            'APPLICATION_SUBMITTED',
            'STAGE_CHANGED',
            'CORRECTION_REQUESTED',
            'APPLICATION_APPROVED',
            'PAYMENT_REQUIRED',
            'PAYMENT_SUCCESS',
            'MEMBERSHIP_ACTIVATED',
            'ADMIN_QUEUE_ALERT',
            'EVENT_REGISTERED',
            'EVENT_REMINDER',
            'EVENT_BOOKING_CONFIRMED',
            'EVENT_BOOKING_CANCELLED',
            'EVENT_BOOKING_REMINDER',
            'EVENT_BOOKING_WAITLISTED',
            'BOT_REPLY',
            'CUSTOM'
        ],
        index: true
    },
    channel: {
        type: String,
        required: true,
        enum: ['in_app', 'email', 'whatsapp'],
        index: true
    },
    recipient: {
        type: String,
        required: true
    },
    sender: {
        type: String
    },
    replyTo: {
        type: String
    },
    templateId: {
        type: String
    },
    status: {
        type: String,
        enum: ['queued', 'sent', 'failed'],
        default: 'queued',
        index: true
    },
    providerMessageId: {
        type: String
    },
    lastError: {
        type: String
    },
    /**
     * The provider was never contacted — there are no credentials configured.
     *
     * Kept apart from `status` deliberately. A mock row IS a success in the only
     * sense the caller cares about (nothing failed, nothing was retried), so
     * folding it into `failed` would fill the oversight screen with alarms on a
     * staging box. Folding it into `sent` is worse: it tells a Super Admin that
     * eight hundred members were emailed when no mail server exists. It is a
     * successful no-op, and it is labelled as one.
     */
    mock: {
        type: Boolean,
        default: false,
        index: true
    },
    /** Subject line or WhatsApp template — what the row actually was, at a glance. */
    subject: {
        type: String
    },
    /** How many times a Super Admin has replayed this row. */
    attempts: {
        type: Number,
        default: 1
    },
    data: mongoose.Schema.Types.Mixed
}, {
    timestamps: true
});

/**
 * The oversight screen's only query: newest first, filtered by channel, status
 * or event. Without this it is a collection scan that grows with every message
 * the platform has ever sent.
 */
notificationLogSchema.index({ createdAt: -1 });
notificationLogSchema.index({ status: 1, createdAt: -1 });
notificationLogSchema.index({ channel: 1, createdAt: -1 });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);
