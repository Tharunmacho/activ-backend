const mongoose = require('mongoose');
const layout = require('../../config/dataLayout');
const device = new mongoose.Schema({
    secretHash: { type: String, required: true, unique: true, select: false },
    token: { type: String, select: false },
    platform: { type: String, enum: ['android', 'ios', 'web'] },
    enabled: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });
device.index({ token: 1 }, { unique: true, partialFilterExpression: { token: { $type: 'string' } } });
device.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 * 86400 });
const notice = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['announcement', 'event'], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    cursor: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending' },
    leaseUntil: Date, worker: String, lastError: String,
    attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
}, { timestamps: true });
notice.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
notice.index({ createdAt: -1 });
const delivery = new mongoose.Schema({
    notice: { type: mongoose.Schema.Types.ObjectId, required: true },
    device: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['pending', 'sending', 'sent', 'failed', 'skipped'], default: 'pending' },
    sentAt: Date, openedAt: Date, inAppOpenedAt: Date, leaseUntil: Date, worker: String, lastError: String,
    attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
}, { timestamps: true });
delivery.index({ notice: 1, device: 1 }, { unique: true });
delivery.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
delivery.index({ createdAt: -1 });
module.exports = { VisitorDevice: layout.model('VisitorDevice', device), PublicNotice: layout.model('PublicNotice', notice),
    VisitorDelivery: layout.model('VisitorDelivery', delivery) };
