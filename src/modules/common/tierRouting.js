const { normalizeStatus } = require('./applicationStatus');

/**
 * Orphan fallback routing.
 *
 * A block admin resigns and their account is deleted. Fifty applications are
 * sitting at `Pending-Block`. Nobody is left who can act on them, and because
 * `Approved` and `Rejected` are the only terminal states, they would sit there
 * forever — invisible to the district admin, whose queue only shows
 * `Pending-District`.
 *
 * The fix here is resolved at read time rather than by rewriting the stored
 * status. That matters: coverage changes both ways. If the super admin staffs a
 * replacement block admin tomorrow, a stored status flip would have already
 * moved those fifty files past the block tier permanently, and the new admin
 * would inherit an empty queue for a region full of unreviewed applicants.
 * Deriving the owner from live coverage means the queue heals itself in both
 * directions, and the stored state machine is never violated.
 *
 * Every function here is pure — coverage is passed in — so this is unit-testable
 * without a database.
 */

/** Ordered from the ground up. An application always starts at index 0. */
const TIER_ORDER = ['block', 'district', 'state'];

/** The tier that owes a decision at each pending status. */
const STATUS_TIER = {
    'Pending-Block': 'block',
    'Pending-District': 'district',
    'Pending-State': 'state'
};

const TIER_LABELS = { block: 'Block', district: 'District', state: 'State', super: 'Super' };

/**
 * Which tier the state machine says owes a decision, ignoring staffing.
 * `null` for the terminal states, which nobody owes anything on.
 */
const owningTier = (application = {}) => STATUS_TIER[normalizeStatus(application.status)] || null;

/**
 * The tier that can actually act, given who is staffed.
 *
 * Walks up from the owning tier while each tier has zero active admins. When no
 * tier in the chain is staffed the answer is `'super'`: the super admin is not
 * geofenced, so they are always the last resort and an application can never
 * become unreachable.
 *
 * `coverage` is `{ block, district, state }` active-admin counts for the
 * application's own region, as produced by `regionService.coverageFor()`.
 * Passing `null` (coverage unknown) disables fallback and returns the owning
 * tier unchanged — an unknown is never treated as "nobody is there".
 */
const effectiveTier = (application = {}, coverage = null) => {
    const owner = owningTier(application);
    if (!owner) return null;
    if (!coverage) return owner;

    let i = TIER_ORDER.indexOf(owner);
    while (i < TIER_ORDER.length && Number(coverage[TIER_ORDER[i]] || 0) === 0) {
        i += 1;
    }

    return i < TIER_ORDER.length ? TIER_ORDER[i] : 'super';
};

/** True when this application has bubbled past the tier that formally owns it. */
const isOrphaned = (application = {}, coverage = null) => {
    const owner = owningTier(application);
    if (!owner) return false;
    const effective = effectiveTier(application, coverage);
    return !!effective && effective !== owner;
};

/**
 * The tiers whose approvals an acting tier absorbs.
 *
 * A district admin approving an orphaned `Pending-Block` file has to satisfy the
 * block step too, or the sequential state machine would only advance the file to
 * `Pending-District` — their own queue — and they would have to approve it
 * twice. The returned list is the steps to record as fallback approvals before
 * the acting tier's own decision.
 */
const absorbedTiers = (application = {}, actingTier = '') => {
    const owner = owningTier(application);
    if (!owner || !actingTier) return [];

    const from = TIER_ORDER.indexOf(owner);
    const to = actingTier === 'super' ? TIER_ORDER.length : TIER_ORDER.indexOf(actingTier);
    if (from < 0 || to < 0 || to <= from) return [];

    return TIER_ORDER.slice(from, to);
};

/**
 * One line explaining why a file is in a queue it does not formally belong to.
 * Rendered on the applicant card so an admin is never asked to decide on
 * something from another tier without being told why it reached them.
 */
const fallbackReason = (application = {}, coverage = null) => {
    const owner = owningTier(application);
    if (!owner) return '';
    const effective = effectiveTier(application, coverage);
    if (!effective || effective === owner) return '';

    return `No active ${TIER_LABELS[owner]} Admin for this region — escalated to the ${TIER_LABELS[effective]} tier`;
};

module.exports = {
    TIER_ORDER,
    TIER_LABELS,
    STATUS_TIER,
    owningTier,
    effectiveTier,
    isOrphaned,
    absorbedTiers,
    fallbackReason
};
