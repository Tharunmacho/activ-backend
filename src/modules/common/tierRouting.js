const { isPending, normalizeStatus } = require('./applicationStatus');
const tierReviews = require('./tierReviews');

/**
 * WHO MAY DECIDE AN APPLICATION.
 *
 * =========================================================================
 * EVERY TIER IN THE APPLICANT'S OWN REGION, EACH WITH ITS OWN VERDICT
 * =========================================================================
 *
 * This module used to walk a chain. An application belonged to one tier at a
 * time, the status named which, and when that tier had nobody staffing it the
 * file bubbled up to the next one so it could not become unreachable.
 *
 * The chain is gone. A submitted application is put in front of its Block,
 * District AND State admin together. That removes the orphan problem at the
 * root rather than routing around it: a block with no admin is still covered,
 * because the district and the state admin were already looking at the same
 * file. There is no queue behind an empty chair any more, so there is nothing
 * to escalate out of one.
 *
 * WHAT EACH TIER DOES WITH THE FILE IS `common/tierReviews.js`, and this module
 * is now a thin façade over it. Briefly, one shared verdict was written by
 * whoever acted first — which told a District admin their Hub row was
 * "Approved" when the State had approved it and the District had decided
 * nothing. Three separate verdicts replaced it: each tier signs its own, and
 * only the State's (or a Super Admin filling that seat) is the application's
 * outcome.
 *
 * WHAT REPLACED IT IS THE GEOFENCE, AND ONLY THE GEOFENCE. The three tiers that
 * may act are the three named ON THE APPLICATION — the state, district and
 * block the applicant picked in the registration form. No other block's admin,
 * no other district's, no other state's can see the file or act on it. That
 * check is `assertWithinScope` on the write path and `buildGeoFilter` on the
 * read path; nothing here widens either.
 *
 * `super_admin` is outside the geofence and may act on anything, as before.
 *
 * Every function here is pure — coverage is passed in — so this is
 * unit-testable without a database.
 */

/** The three geofenced tiers, smallest patch first. */
const TIER_ORDER = ['block', 'district', 'state'];

const TIER_LABELS = { block: 'Block', district: 'District', state: 'State', super: 'Super' };

/**
 * The tiers that still owe a verdict on this application.
 *
 * All three on a fresh file. The State approving removes the STATE from this
 * list and leaves the other two on it — they have not decided, and their
 * dashboards must keep saying so.
 *
 * Note what this does NOT depend on: staffing. A tier with no admin simply has
 * nobody to exercise the permission, which is not the same thing as the
 * permission being withheld — and the moment the Super Admin staffs that tier,
 * its new admin inherits the queue with no stored state to repair.
 */
const reviewingTiers = (application = {}) => tierReviews.reviewingTiers(application);

/**
 * May `tier` act on this application?
 *
 * Region membership is NOT asked here — the caller has already established it,
 * either by the geofenced query that produced the row or by `assertWithinScope`
 * before the write. This answers only the second half: has THIS TIER got a
 * verdict still outstanding.
 *
 * "This tier", not "anybody". A District admin may still record their view of
 * an applicant the State has already approved; what they may not do is record
 * it twice.
 */
const canTierAct = (application = {}, tier = '') => tierReviews.canTierAct(application, tier);

/**
 * True when no tier in the region has an active admin, so only the Super Admin
 * can act.
 *
 * This is the one thing coverage is still consulted for, and it is a REPORTING
 * question rather than a routing one — the Super Admin's "regions with nobody
 * in them" list. `coverage` is `{ block, district, state }` active-admin counts
 * for the application's own region, as produced by `regionService.coverageFor()`.
 *
 * `null` (staffing unknown) answers `false`. An unknown is not "nobody is
 * there", and reporting a staffed region as abandoned is worse than reporting
 * nothing.
 */
const isUnattended = (coverage = null) => {
    if (!coverage) return false;
    return TIER_ORDER.every(tier => Number(coverage[tier] || 0) === 0);
};

/**
 * The tiers in a region that have nobody in them, for the same report.
 * Empty when coverage is unknown, for the reason above.
 */
const unstaffedTiers = (coverage = null) => {
    if (!coverage) return [];
    return TIER_ORDER.filter(tier => Number(coverage[tier] || 0) === 0);
};

/**
 * One line naming who has yet to record a verdict, for the applicant card.
 *
 * It names the tiers that are actually outstanding rather than all three, and
 * it distinguishes the two cases that look alike from a block admin's desk:
 * the application is still undecided, or the State has decided it and this is
 * a verdict being recorded for the file.
 */
const holdingLine = (application = {}) => {
    const waiting = tierReviews.reviewingTiers(application);
    if (!waiting.length) return '';

    const names = waiting.map(tier => tierReviews.TIER_LABELS[tier]);
    const list = names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
        : names[0];

    return waiting.includes(tierReviews.DECIDING_TIER)
        ? `With the ${list} Admin — the State Admin grants the membership`
        : `With the ${list} Admin — the State Admin has already decided the application`;
};

module.exports = {
    TIER_ORDER,
    TIER_LABELS,
    reviewingTiers,
    canTierAct,
    isUnattended,
    unstaffedTiers,
    holdingLine,
    normalizeStatus
};
