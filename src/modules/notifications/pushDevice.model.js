const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], required: true },
    enabled: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });
schema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 * 86400 });
module.exports = require('../../config/dataLayout').model('PushDevice', schema);
