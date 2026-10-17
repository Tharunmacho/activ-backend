const mongoose = require('mongoose');
const dataLayout = require('../../config/dataLayout');
const schema = new mongoose.Schema({
    provider: { type: String, enum: ['google', 'facebook', 'linkedin'], required: true },
    subject: { type: String, required: true },
    authId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
}, { timestamps: true });
schema.index({ provider: 1, subject: 1 }, { unique: true });
module.exports = dataLayout.model('OAuthIdentity', schema);
