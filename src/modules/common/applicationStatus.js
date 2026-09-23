/**
 * Canonical application statuses, plus a normalizer for every legacy value that
 * already exists in the database.
 *
 * =========================================================================
 * THERE IS ONE PENDING STATE, NOT THREE
 * =========================================================================
 *
 * This workflow used to be strictly sequential — `Pending-Block` →
 * `Pending-District` → `Pending-State` → `Approved` — and the status named the
 * tier whose turn it was. It is not sequential any more. An application is
 * submitted to its Block, District and State admins AT THE SAME TIME, and the
 * first of them to decide decides it for all three.
 *
 * So there is nothing left for a tier-named status to say. `Pending-District`
 * would have to mean "pending, and also with the block and the state" — which
 * is what `Pending` means. Keeping the three spellings apart would leave every
 * reader re-deriving the same answer from three values, and each of them is a
 * chance to get it wrong in one place and not another.
 *
 * Three vocabularies have been used over the life of this project:
 *   1. canonical (schema enum) : 'Pending-Block', 'Pending-District', 'Pending-State', 'Approved', 'Rejected'
 *   2. snake_case verbose      : 'pending_block_approval', 'pending_district_approval', ...
 *   3. constants.js short form : 'pending_block', 'pending_district', ...
 *   ...plus bare lowercase 'approved' / 'rejected' and the schema default 'PENDING'.
 *
 * ALL of them that mean "not decided yet" now fold to the single canonical
 * `Pending`. That is what makes this change need no data migration: a row
 * written at `Pending-State` last month is read as pending today, by all three
 * tiers, and is actionable by any of them.
 *
 * Live documents carry every one of these spellings. Every read path must
 * normalize before comparing, or legacy rows get bucketed wrong.
 */

const STATUS = {
    /** Submitted, nobody has decided. Every tier in the region sees it. */
    PENDING: 'Pending',
    APPROVED: 'Approved',
    REJECTED: 'Rejected'
};

/**
 * The stored spellings that mean "pending".
 *
 * Kept as a list because Mongo queries still have to match what is ON DISK —
 * `normalizeStatus` fixes reads, not the database. Anything selecting unfinished
 * applications must use this, not `status: 'Pending'`, or it misses every row
 * written before the workflow was flattened.
 */
const PENDING_STORED_STATUSES = [
    'Pending',
    'PENDING',
    'Pending-Block',
    'Pending-District',
    'Pending-State'
];

// Every spelling we have seen, mapped to its canonical form. Keys are compared
// lowercased with separators stripped, so 'Pending_District' and
// 'pending-district' both resolve through the same entry.
const ALIASES = {
    // Undecided — however it was spelled, and whichever tier it once named.
    'pending': STATUS.PENDING,
    'pendingblock': STATUS.PENDING,
    'pendingblockapproval': STATUS.PENDING,
    'blockpending': STATUS.PENDING,
    'submitted': STATUS.PENDING,
    'pendingdistrict': STATUS.PENDING,
    'pendingdistrictapproval': STATUS.PENDING,
    'districtpending': STATUS.PENDING,
    'blockapproved': STATUS.PENDING,
    'pendingstate': STATUS.PENDING,
    'pendingstateapproval': STATUS.PENDING,
    'statepending': STATUS.PENDING,
    'districtapproved': STATUS.PENDING,

    // Terminal
    'approved': STATUS.APPROVED,
    'stateapproved': STATUS.APPROVED,
    'complete': STATUS.APPROVED,
    'completed': STATUS.APPROVED,
    'rejected': STATUS.REJECTED,
    'declined': STATUS.REJECTED
};

/**
 * Fold any known spelling to its canonical status.
 * Unknown values fall back to `Pending` — an unrecognised application is safest
 * treated as still needing a decision rather than silently appearing approved.
 */
const normalizeStatus = (value) => {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_\-.]/g, '');

    if (!key) return STATUS.PENDING;
    return ALIASES[key] || STATUS.PENDING;
};

/** True when the status is one nobody can act on any further. */
const isTerminal = (value) => {
    const s = normalizeStatus(value);
    return s === STATUS.APPROVED || s === STATUS.REJECTED;
};

/** True when the application still owes a decision — the inverse of terminal. */
const isPending = (value) => normalizeStatus(value) === STATUS.PENDING;

module.exports = { STATUS, PENDING_STORED_STATUSES, normalizeStatus, isTerminal, isPending };
