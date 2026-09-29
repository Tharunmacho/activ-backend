const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * A person or organisation that has donated to ACTIV. Identified by EMAIL —
 * the same address donating again is the same donor, and their details are
 * refreshed to the latest given. Each donation is its own row in `donations`.
 *
 * `statementToken` is the unguessable key in the donor's year-statement link;
 * donors have no account, so the link IS their access.
 */
const donorSchema = new mongoose.Schema({
    fullName: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, required: true },
    phone: { type: String, trim: true, default: '' },
    pan: { type: String, trim: true, uppercase: true, default: '' },
    donorType: { type: String, enum: ['individual', 'organisation'], default: 'individual' },
    address: {
        line1: { type: String, trim: true, default: '' },
        city: { type: String, trim: true, default: '' },
        district: { type: String, trim: true, default: '' },
        state: { type: String, trim: true, default: '' },
        pincode: { type: String, trim: true, default: '' }
    },
    statementToken: {
        type: String,
        default: () => crypto.randomBytes(16).toString('hex')
    },
    /** Financial years whose final statement has been emailed (`2026-27`). */
    statementsSent: { type: [String], default: [] }
}, { collection: 'donors', timestamps: true });

// Scalar unique indexes — see CLAUDE.md on unique indexes over arrays.
donorSchema.index({ email: 1 }, { unique: true });
donorSchema.index({ statementToken: 1 }, { unique: true });

module.exports = mongoose.models.Donor || mongoose.model('Donor', donorSchema);
