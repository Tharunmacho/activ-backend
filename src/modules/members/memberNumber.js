/**
 * ============================================================================
 * THE MEMBERSHIP NUMBER, AND THE YEAR IN IT
 * ============================================================================
 *
 * The association's ask: a number that says which year the member joined in.
 * Somebody registering in 2026 gets a 2026 number; the next intake gets 2027.
 * The same for an application's reference.
 *
 *     ACTIV-2026-001             a member — the 1st to join in 2026
 *     ACTIV-2026-1000            the 1,000th (the count simply grows a digit)
 *     ACTIV-APP-2026-3F9A21      their application
 *
 * ------------------------------------------------------------ year-wise count
 *
 * The number is ASSIGNED, once, the moment a membership first becomes active
 * (`assignMembershipNumber`, called by every activation path: both payment
 * paths and the Platinum grant). Each year has its own counter in
 * `membership_counters` (`_id: 'membership:2026'`), bumped atomically, so two
 * payments landing together cannot get the same number, and 2027 starts again
 * at 001. Three digits minimum because that is what the association reads at a
 * glance; `padStart` never truncates, so the thousandth member is `ACTIV-2026-1000`.
 *
 * A member who already holds a standard number keeps it for life — renewals,
 * a payment reset and re-payment, a Platinum upgrade all leave it alone.
 *
 * ---------------------------------------------------------------- stability
 *
 * A membership number is written down, quoted in an email and printed on a
 * certificate, so it must never change for a given member. Every part of it is
 * therefore derived from things that do not move:
 *
 *   the year   `membershipActivatedAt`, else `createdAt`, else the timestamp
 *              inside the ObjectId itself — which every Mongo id carries in
 *              its first four bytes, so a record with no date field still
 *              yields the year it was created in;
 *   the tail   six hex characters of the id, which is already what the old
 *              fallback used.
 *
 * A number that was ASSIGNED always wins. This is the fallback for a member who
 * has none, which is most of them.
 *
 * ------------------------------------------------------------- one expression
 *
 * It lives here because it was four copies of
 * `member.membershipNumber || String(member._id).slice(-8).toUpperCase()`
 * scattered across two controllers — and the model's own comment promised the
 * dashboard and the certificate "cannot differ" because of it. They did, for a
 * reason that had nothing to do with the expression and everything to do with
 * there being four of them. One function, imported by all four callers, is what
 * that promise actually requires.
 */

/** The four-digit year a record belongs to, from whatever it carries. */
const yearOf = (record = {}) => {
    const candidates = [
        record.membershipActivatedAt,
        record.approvedAt,
        record.createdAt,
        record.submittedAt,
    ];

    for (const value of candidates) {
        if (!value) continue;
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date.getFullYear();
    }

    /*
     * THE ID ITSELF, which is never absent.
     *
     * A Mongo ObjectId's first four bytes are the creation time in seconds.
     * Reading the year out of it means a record whose date fields were dropped
     * by strict mode — which is how several fields on this model were lost —
     * still produces the right year rather than the current one. Using "now"
     * as the fallback would hand a member registered in 2024 a 2026 number the
     * first time anybody opened their profile.
     */
    const id = String(record._id || record.id || '');
    if (/^[0-9a-f]{24}$/i.test(id)) {
        const seconds = parseInt(id.slice(0, 8), 16);
        if (seconds > 0) return new Date(seconds * 1000).getFullYear();
    }

    return new Date().getFullYear();
};

/** Six characters off the id. Upper case, as every screen has always shown it. */
const tailOf = (record = {}) =>
    String(record._id || record.id || '').slice(-6).toUpperCase() || '000000';

/** `ACTIV-2026-001` — the shape an assigned, year-wise number has. */
const STANDARD_NUMBER = /^ACTIV-\d{4}-\d{3,}$/;

const formatNumber = (year, seq) => `ACTIV-${year}-${String(seq).padStart(3, '0')}`;

/** Next value of this year's counter. Atomic: `$inc` on one document. */
const nextSequence = async (year) => {
    const mongoose = require('mongoose');
    const res = await mongoose.connection.db.collection('membership_counters').findOneAndUpdate(
        { _id: `membership:${year}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    // Driver 6 returns the document; older drivers wrap it in `{ value }`.
    const doc = res && res.value !== undefined && res.seq === undefined ? res.value : res;
    return Number((doc && doc.seq) || 0);
};

/**
 * Give this member their year-wise number if they do not have one yet, and
 * return the number they hold. Never throws: a numbering hiccup must not fail
 * a payment that has already been taken — the member keeps the derived number
 * until the next activation (or the backfill script) assigns one.
 *
 * `year` defaults to the year the membership was activated.
 */
const assignMembershipNumber = async (memberOrId, { year } = {}) => {
    try {
        const MemberDetails = require('./memberdetails.model');
        const id = memberOrId && (memberOrId._id || memberOrId.id) ? (memberOrId._id || memberOrId.id) : memberOrId;
        const member = await MemberDetails.findById(id)
            .select('membershipNumber membershipActivatedAt createdAt').lean();
        if (!member) return '';
        const current = String(member.membershipNumber || '').trim();
        if (STANDARD_NUMBER.test(current)) return current;

        const y = year || yearOf({ membershipActivatedAt: member.membershipActivatedAt || new Date() });
        const number = formatNumber(y, await nextSequence(y));

        // Conditional: if another request numbered this member first, keep theirs.
        const res = await MemberDetails.updateOne(
            { _id: member._id, membershipNumber: { $not: STANDARD_NUMBER } },
            { $set: { membershipNumber: number } }
        );
        if (res && res.modifiedCount) {
            try { require('../common/memberContext').invalidateMemberContext(member._id); } catch { /* cache only */ }
            return number;
        }
        const again = await MemberDetails.findById(member._id).select('membershipNumber').lean();
        return String((again && again.membershipNumber) || number);
    } catch (error) {
        try {
            require('../../config/logger').warn('Could not assign a membership number', { error: error && error.message });
        } catch { /* logging only */ }
        return '';
    }
};

/**
 * The number to show for this member.
 *
 * An assigned `membershipNumber` is returned untouched — including one that
 * predates this format. Renaming somebody's existing number would be worse than
 * having two formats in the field.
 */
const membershipNumberFor = (member = {}) => {
    const assigned = String(member.membershipNumber || '').trim();
    if (assigned) return assigned;
    return `ACTIV-${yearOf(member)}-${tailOf(member)}`;
};

/**
 * The reference to show for an application.
 *
 * Same shape, with `APP` in it, so a member quoting a number over the telephone
 * and an administrator searching for it cannot confuse the two. The year is the
 * year it was SUBMITTED, which is the year the applicant remembers.
 */
const applicationRefFor = (application = {}) => {
    const assigned = String(application.applicationNumber || '').trim();
    if (assigned) return assigned;
    return `ACTIV-APP-${yearOf(application)}-${tailOf(application)}`;
};

module.exports = {
    membershipNumberFor, applicationRefFor, yearOf,
    assignMembershipNumber, nextSequence, formatNumber, STANDARD_NUMBER
};
