/**
 * ============================================================================
 * THE MEMBERSHIP NUMBER, AND THE YEAR IN IT
 * ============================================================================
 *
 * The association's ask: a number that says which year the member joined in.
 * Somebody registering in 2026 gets a 2026 number; the next intake gets 2027.
 * The same for an application's reference.
 *
 *     ACTIV-2026-3F9A21          a member
 *     ACTIV-APP-2026-3F9A21      their application
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

module.exports = { membershipNumberFor, applicationRefFor, yearOf };
