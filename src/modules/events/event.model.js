const mongoose = require('mongoose');

/**
 * Platform-wide events, authored by the super admin.
 *
 * `status` is the publish gate: a draft is visible only to admins, a published
 * event is visible to everyone. Members never see drafts.
 */
const eventSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    startAt: {
        type: Date,
        required: true,
        index: true
    },
    endAt: {
        type: Date
    },
    venue: {
        type: String,
        trim: true,
        default: ''
    },
    // Optional geographic targeting. Empty means "everywhere".
    state: {
        type: String,
        trim: true,
        default: '',
        index: true
    },
    district: {
        type: String,
        trim: true,
        default: ''
    },
    block: {
        type: String,
        trim: true,
        default: ''
    },
    bannerUrl: {
        type: String,
        trim: true,
        default: ''
    },
    /**
     * How the banner sits in its frame, and what it depicts.
     *
     * Additive and optional, so the mobile app — which reads this same
     * collection and knows only `bannerUrl` — is unaffected. Without them an
     * uploaded portrait photograph is cropped to a strip in the website's wide
     * event card with no way for the editor to say otherwise, which is the one
     * media control every other CMS screen already offers.
     */
    bannerAlt: {
        type: String,
        trim: true,
        default: ''
    },
    bannerFit: {
        type: String,
        enum: ['cover', 'contain'],
        default: 'cover'
    },
    bannerPosition: {
        type: String,
        trim: true,
        default: 'center'
    },
    status: {
        type: String,
        enum: ['draft', 'published'],
        default: 'draft',
        index: true
    },
    createdBy: {
        type: String,
        trim: true,
        default: ''
    }
}, {
    collection: 'events',
    timestamps: true
});

eventSchema.index({ status: 1, startAt: -1 });

module.exports = mongoose.model('Event', eventSchema);
