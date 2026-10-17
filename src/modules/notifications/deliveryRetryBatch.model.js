const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    requestedBy: { type: String, required: true },
    ids: [String],
    status: { type: String, enum: ['processing', 'done'], default: 'processing' },
    summary: mongoose.Schema.Types.Mixed,
    results: [mongoose.Schema.Types.Mixed],
}, { timestamps: true });
// Keep the reviewed request/audit key permanently. Repeating a confirmation
// cannot repeat sends, including after an interrupted request or API restart.
module.exports = require('../../config/dataLayout').model('DeliveryRetryBatch', schema);
