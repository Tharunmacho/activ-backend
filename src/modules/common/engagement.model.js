const mongoose = require('mongoose');

/**
 * Who looked at what — the raw material for a member's operational analytics.
 *
 * One collection for both profile views and catalogue views rather than two,
 * because every question the analytics screen asks is asked of both in the same
 * shape ("how many this month", "which of mine got the most", "on which days")
 * and two collections would mean writing each of those twice.
 *
 * `day` is a `YYYY-MM-DD` string and is part of the unique index below, which is
 * what stops a member refreshing a page thirty times from reading as thirty
 * views. The trade is that the finest resolution this can answer is a day —
 * which is the finest resolution anyone actually asks a small business for.
 *
 * Stored as a string rather than a truncated Date deliberately: a Date is an
 * instant and would be truncated in UTC, so a view at 9pm IST would be filed
 * under the next day. The string is built in the server's local timezone, which
 * is the one the member's "views today" figure is judged against.
 */
const engagementSchema = new mongoose.Schema({
    kind: {
        type: String,
        enum: ['profile', 'product'],
        required: true,
        index: true
    },
    /** The profile or product that was viewed. */
    targetId: {
        type: String,
        required: true,
        index: true
    },
    /** The member who owns it — every analytics query starts here. */
    ownerId: {
        type: String,
        required: true,
        index: true
    },
    /** Who looked. Empty for a signed-out visitor, which is still a view. */
    viewerId: {
        type: String,
        default: '',
        index: true
    },
    day: {
        type: String,
        required: true,
        index: true
    }
}, {
    collection: 'engagements',
    timestamps: true
});

/**
 * One view per viewer, per thing, per day.
 *
 * The write path is an upsert against this key, so the second view of the day
 * updates a row instead of adding one. An anonymous viewer collapses to a
 * single row per day per target, which understates traffic — the alternative,
 * counting every anonymous hit, overstates it by however many times one person
 * hit refresh, and an inflated number is the more damaging of the two on a
 * screen a member uses to judge whether their catalogue is working.
 */
engagementSchema.index({ kind: 1, targetId: 1, viewerId: 1, day: 1 }, { unique: true });
engagementSchema.index({ ownerId: 1, kind: 1, day: -1 });

/** `YYYY-MM-DD` in the server's local timezone — see the note above. */
const dayKey = (date = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
};

const Engagement = mongoose.model('Engagement', engagementSchema);

/**
 * Record a view, or quietly do nothing.
 *
 * Never throws and never blocks the caller's response: analytics that break the
 * page they are measuring are worse than analytics that miss a row. A member
 * viewing their own profile or product is not a view — otherwise every member's
 * figures are dominated by their own editing.
 */
const recordView = async ({ kind, targetId, ownerId, viewerId = '' }) => {
    const owner = String(ownerId || '');
    const viewer = String(viewerId || '');

    if (!kind || !targetId || !owner) return null;
    if (viewer && viewer === owner) return null;

    return Engagement.updateOne(
        { kind, targetId: String(targetId), viewerId: viewer, day: dayKey() },
        { $setOnInsert: { ownerId: owner } },
        { upsert: true }
    ).catch(() => null);
};

module.exports = Engagement;
module.exports.dayKey = dayKey;
module.exports.recordView = recordView;
