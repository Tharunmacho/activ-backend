const crypto = require('crypto');
const dataLayout = require('../../config/dataLayout');
const mongoose = require('mongoose');

const addressShape = {
    line1: { type: String, default: '' },
    city: { type: String, default: '' },
    district: { type: String, default: '' },
    state: { type: String, default: '' },
    pincode: { type: String, default: '' }
};

/**
 * ONE donation. Every gift is its own row, even from the same donor, and gets
 * its own 80G receipt once paid.
 *
 * Money is `amountPaise`, an integer — never a float.
 *
 * `donorSnapshot` is the donor's details AS GIVEN for this donation: a receipt
 * must keep saying what it said the day it was issued, even after the donor
 * updates their address on a later gift.
 *
 * `receiptNumber` (ACTIV-DON-2026-27-001) and `financialYear` are written only
 * when the donation is paid — an abandoned checkout consumes no number.
 */
const donationSchema = new mongoose.Schema({
    donorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Donor', required: true, index: true },
    amountPaise: {
        type: Number,
        required: true,
        min: 0,
        validate: { validator: Number.isInteger, message: 'amountPaise must be an integer' }
    },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
    financialYear: { type: String, default: '', index: true },
    receiptNumber: { type: String, trim: true },
    receiptToken: {
        type: String,
        default: () => crypto.randomBytes(16).toString('hex')
    },
    donorSnapshot: {
        fullName: { type: String, default: '' },
        email: { type: String, default: '' },
        phone: { type: String, default: '' },
        pan: { type: String, default: '' },
        donorType: { type: String, default: 'individual' },
        address: addressShape
    },
    message: { type: String, trim: true, maxlength: 1000, default: '' },
    orderId: { type: String, trim: true, index: true },
    gatewayPaymentId: { type: String, trim: true, default: '' },
    paymentMode: { type: String, enum: ['online', 'mock', ''], default: '' },
    paidAt: { type: Date, default: null }
}, { timestamps: true });

donationSchema.index({ receiptNumber: 1 }, { unique: true, sparse: true });
donationSchema.index({ receiptToken: 1 }, { unique: true });
donationSchema.index({ donorId: 1, status: 1, paidAt: -1 });

module.exports = dataLayout.model('Donation', donationSchema);
