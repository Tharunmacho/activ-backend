const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['announcement', 'event', 'news', 'gallery', 'scheme'], required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    cursor: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ['pending', 'processing', 'done', 'failed'], default: 'pending' },
    leaseUntil: { type: Date, default: null },
    worker: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: { type: String, default: '' },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 86400000) },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = require('../../config/dataLayout').model('ContentBroadcast', schema);
