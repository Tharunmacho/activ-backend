const mongoose = require('mongoose');

/**
 * Association Updates — news and notices the association publishes to members.
 *
 * Distinct from `Event` on purpose. An event is a thing that happens at a time
 * and a place and may be registered for; an update is something the association
 * wants read. They were nearly folded into one collection with a `kind` flag,
 * and the fields diverge almost immediately: an update has no start time, no
 * agenda and no attendee list, while an event has no pinning and no expiry.
 *
 * `state`/`district`/`block` are the targeting, and EMPTY MEANS EVERYONE — the
 * opposite default from an application's region fields. `regionMatch.js` holds
 * the matching, and the note at the top of it explains why the two directions
 * are separate helpers rather than one with a flag.
 *
 * `audience` is the membership gate. `paid` is the interesting one and the
 * reason this field exists: the association wanted notices that only members
 * who have actually paid can read.
 */
const announcementSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    /**
     * A one-line standfirst, shown in the dashboard feed where the body is too
     * long to render. Optional: `toAnnouncement` falls back to the opening of
     * the body rather than showing a card with a headline and nothing under it.
     */
    summary: {
        type: String,
        trim: true,
        default: ''
    },
    body: {
        type: String,
        trim: true,
        default: ''
    },
    category: {
        type: String,
        enum: ['general', 'notice', 'policy', 'scheme', 'achievement', 'urgent'],
        default: 'general',
        index: true
    },

    // ---- targeting. Empty means everywhere; see regionMatch.js.
    state: { type: String, trim: true, default: '', index: true },
    district: { type: String, trim: true, default: '' },
    block: { type: String, trim: true, default: '' },

    /**
     * Who may read it.
     *
     * `all` — every signed-in member, paid or not.
     * `paid` — only a member whose membership is active.
     *
     * Enforced in the service, never by the client asking nicely.
     */
    audience: {
        type: String,
        enum: ['all', 'paid'],
        default: 'all',
        index: true
    },

    bannerUrl: { type: String, trim: true, default: '' },
    bannerAlt: { type: String, trim: true, default: '' },
    /** A circular, order form or notice the member can open. */
    attachmentUrl: { type: String, trim: true, default: '' },
    attachmentLabel: { type: String, trim: true, default: '' },

    /** Pinned updates sort above everything else, regardless of date. */
    pinned: {
        type: Boolean,
        default: false,
        index: true
    },

    status: {
        type: String,
        enum: ['draft', 'published'],
        default: 'draft',
        index: true
    },

    /**
     * When it went out — not when the row was created.
     *
     * A draft written on Monday and published on Friday is Friday's news, and
     * sorting the feed by `createdAt` would file it under Monday, four days
     * below items the member has already read. Stamped on the transition to
     * `published` and cleared on the way back to `draft`.
     */
    publishedAt: {
        type: Date,
        default: null,
        index: true
    },

    /** After this instant the update drops out of the member feed. */
    expiresAt: {
        type: Date,
        default: null
    },

    createdBy: { type: String, trim: true, default: '' }
}, {
    collection: 'announcements',
    timestamps: true
});

announcementSchema.index({ status: 1, pinned: -1, publishedAt: -1 });
announcementSchema.index({ status: 1, state: 1, district: 1, block: 1 });

module.exports = mongoose.model('Announcement', announcementSchema);
