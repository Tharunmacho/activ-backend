const mongoose = require('mongoose');

const channel = new mongoose.Schema({
    status: { type: String, enum: ['pending', 'sending', 'done', 'failed', 'held', 'skipped'], default: 'pending' },
    outcome: mongoose.Schema.Types.Mixed,
    lastError: String,
}, { _id: false });
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['lifecycle', 'payment_pending'], default: 'lifecycle' },
    event: String,
    recipient: mongoose.Schema.Types.Mixed,
    payload: mongoose.Schema.Types.Mixed,
    status: { type: String, enum: ['pending', 'processing', 'done'], default: 'pending' },
    nextAttemptAt: { type: Date, default: Date.now },
    leaseUntil: Date,
    worker: String,
    attempts: { type: Number, default: 0 },
    lastError: String,
    channels: {
        in_app: { type: channel, default: () => ({}) },
        email: { type: channel, default: () => ({}) },
        whatsapp: { type: channel, default: () => ({}) },
    },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
// Keep completed keys: replaying an old webhook must not resend an accepted notice.
module.exports = require('../../config/dataLayout').model('LifecycleOutbox', schema);
