const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    requestedBy: { type: String, required: true },
    ids: [String],
    status: { type: String, enum: ['processing', 'done'], default: 'processing' },
    summary: mongoose.Schema.Types.Mixed,
    results: [mongoose.Schema.Types.Mixed],
}, { timestamps: true });
// A durable review receipt makes repeated confirmations harmless. No delivery
// documents are deleted; this audit records only admin history visibility.
module.exports = require('../../config/dataLayout').model('NotificationHistoryBatch', schema);
