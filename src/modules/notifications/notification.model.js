const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');

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
    data: mongoose.Schema.Types.Mixed
}, {
    timestamps: true
});

notificationSchema.index({ deliveryKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ 'push.status': 1, 'push.nextAttemptAt': 1 });
notificationSchema.index({ user: 1, createdAt: -1 });
module.exports = dataLayout.model('Notification', notificationSchema);
