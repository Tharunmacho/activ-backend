const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');
const updateDeliverySchema = new mongoose.Schema({
    status: { type: String, enum: ['pending', 'sending', 'sent', 'skipped', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    worker: String,
    lastError: String,
    logId: mongoose.Schema.Types.ObjectId,
}, { _id: false });

const notificationSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    title: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['info', 'success', 'warning', 'error'],
        default: 'info'
    },
    isRead: {
        type: Boolean,
        default: false
    },
    deliveryKey: { type: String },
    push: {
        status: { type: String, enum: ['pending', 'sending', 'sent', 'skipped', 'failed'], default: 'pending' },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: { type: Date, default: Date.now },
        leaseUntil: Date,
        worker: String,
        lastError: String,
        sentTokens: [String],
    },
    // Present only for newly published association updates; no historical
    // lifecycle messages or existing notifications are backfilled into a send.
    updateDelivery: {
        email: { type: updateDeliverySchema, default: undefined },
        whatsapp: { type: updateDeliverySchema, default: undefined },
    },
    data: mongoose.Schema.Types.Mixed
}, {
    timestamps: true
});

notificationSchema.index({ deliveryKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ 'push.status': 1, 'push.nextAttemptAt': 1 });
notificationSchema.index({ 'updateDelivery.email.status': 1, 'updateDelivery.email.nextAttemptAt': 1 });
notificationSchema.index({ 'updateDelivery.whatsapp.status': 1, 'updateDelivery.whatsapp.nextAttemptAt': 1 });
notificationSchema.index({ user: 1, createdAt: -1 });
module.exports = dataLayout.model('Notification', notificationSchema);
