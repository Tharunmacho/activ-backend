const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');
const schema = new mongoose.Schema({
    _id: String,
    provider: { type: String, enum: ['google', 'facebook', 'linkedin'], required: true },
    subject: { type: String, required: true },
    linkedAuthId: { type: mongoose.Schema.Types.ObjectId, default: null },
    email: { type: String, default: '' },
    name: { type: String, default: '' },
    verified: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, expires: 0 },
    usedAt: { type: Date, default: null },
    otpHash: { type: String, default: '' },
    otpEmail: { type: String, default: '', index: true },
    attempts: { type: Number, default: 0 },
    sendCount: { type: Number, default: 0 },
    lastSentAt: { type: Date, default: null },
}, { timestamps: true });
module.exports = dataLayout.model('OAuthFlow', schema);
