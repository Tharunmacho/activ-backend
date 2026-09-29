const mongoose = require('mongoose');

/**
 * A member asking for Platinum — the ₹2,00,000 lifetime tier.
 *
 * Platinum is paid at the office and GRANTED by the Super Admin
 * (`platinum.service.grant`), never bought online. This row is the step
 * before: the member says "I want it, call me like this", the office and the
 * Super Admin are told, somebody calls, and the grant closes it ('converted').
 *
 * One OPEN request per member ('new' or 'contacted'); asking again returns it.
 */
const STATUSES = ['new', 'contacted', 'converted', 'declined'];
const CONTACT = ['call', 'whatsapp', 'email'];

const platinumRequestSchema = new mongoose.Schema({
    memberId: { type: String, required: true, index: true },
    name: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    block: { type: String, trim: true, default: '' },
    district: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    companyName: { type: String, trim: true, default: '' },
    preferredContact: { type: String, enum: CONTACT, default: 'call' },
    preferredTime: { type: String, trim: true, default: '' },
    message: { type: String, trim: true, default: '' },
    status: { type: String, enum: STATUSES, default: 'new', index: true },
    notes: { type: String, trim: true, default: '' },
    handledBy: { type: String, trim: true, default: '' },
    handledAt: { type: Date }
}, { collection: 'platinum_requests', timestamps: true });

platinumRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PlatinumRequest', platinumRequestSchema);
module.exports.STATUSES = STATUSES;
module.exports.CONTACT = CONTACT;
