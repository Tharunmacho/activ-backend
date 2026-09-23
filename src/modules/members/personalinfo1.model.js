const mongoose = require('mongoose');
const { ALL_SOCIAL_CATEGORIES, GENDERS } = require('./demographicOptions');

// Additional Form for Personal Information 1 Schema
const personalInfo1Schema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    phoneNumber: {
        type: String,
        required: true,
        trim: true
    },
    state: {
        type: String,
        required: function requiredUnlessInternational() { return this.isInternational !== true; },
        trim: true
    },
    district: {
        type: String,
        required: function requiredUnlessInternational() { return this.isInternational !== true; },
        trim: true
    },
    block: {
        type: String,
        required: function requiredUnlessInternational() { return this.isInternational !== true; },
        trim: true
    },
    /*
     * MEMBERS OUTSIDE INDIA.
     *
     * Set on the server, from the phone number — a valid number with a
     * country code other than +91 — and never from anything the client
     * claims. Such a member has no state, district or block: the region
     * tree is India's, and asking a member in Dubai to pick a Tamil Nadu
     * block would file them in a queue that is not theirs. They give a
     * free-text `place` instead, which the certificate and the dashboard
     * print, and their application has no region, so no tier admin's
     * geofence matches it and it goes straight to the Super Admin.
     */
    isInternational: { type: Boolean, default: false, index: true },
    /** The country, named from the phone number's code — "United Arab Emirates". */
    country: { type: String, trim: true, default: '' },
    /** Where they are, as they wrote it — "Dubai, UAE". */
    place: { type: String, trim: true, default: '' },
    city: {
        type: String,
        trim: true
    },
    religion: {
        type: String,
        trim: true
    },
    socialCategory: {
        type: String,
        /* Legacy values kept — see the note on the same field in
           `memberdetails.model.js`. */
        enum: ALL_SOCIAL_CATEGORIES,
        trim: true,
        default: ''
    },
    /** Male / Female. Blank for every record written before it was asked. */
    gender: {
        type: String,
        enum: [...GENDERS, ''],
        trim: true,
        default: ''
    },
    isLocked: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true,
    collection: 'additional form for personal information 1'
});

// Index for faster queries
personalInfo1Schema.index({ userId: 1 });

// Prevent model recompilation in development
module.exports = mongoose.models.PersonalInfo1 || mongoose.model('PersonalInfo1', personalInfo1Schema);
