/**
 * Canonical application statuses, plus a normalizer for the legacy values that
 * already exist in the database.
 *
 * Three vocabularies have been used over the life of this project:
 *   1. canonical (schema enum) : 'Pending-Block', 'Pending-District', 'Pending-State', 'Approved', 'Rejected'
 *   2. snake_case verbose      : 'pending_block_approval', 'pending_district_approval', ...
 *   3. constants.js short form : 'pending_block', 'pending_district', ...
 *   ...plus bare lowercase 'approved' / 'rejected' and the schema default 'PENDING'.
 *
 * Live documents carry all of these. Every read path must normalize before
 * comparing, or legacy rows get bucketed into the wrong admin queue.
 */

const STATUS = {
    PENDING_BLOCK: 'Pending-Block',
    PENDING_DISTRICT: 'Pending-District',
    PENDING_STATE: 'Pending-State',
    APPROVED: 'Approved',
    REJECTED: 'Rejected'
};

// Every spelling we have seen, mapped to its canonical form. Keys are compared
// lowercased with separators stripped, so 'Pending_District' and
// 'pending-district' both resolve through the same entry.
const ALIASES = {
    // Block stage
    'pending': STATUS.PENDING_BLOCK,
    'pendingblock': STATUS.PENDING_BLOCK,
    'pendingblockapproval': STATUS.PENDING_BLOCK,
    'blockpending': STATUS.PENDING_BLOCK,
    'submitted': STATUS.PENDING_BLOCK,

    // District stage
    'pendingdistrict': STATUS.PENDING_DISTRICT,
    'pendingdistrictapproval': STATUS.PENDING_DISTRICT,
    'districtpending': STATUS.PENDING_DISTRICT,
    'blockapproved': STATUS.PENDING_DISTRICT,

    // State stage
    'pendingstate': STATUS.PENDING_STATE,
    'pendingstateapproval': STATUS.PENDING_STATE,
    'statepending': STATUS.PENDING_STATE,
    'districtapproved': STATUS.PENDING_STATE,

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
 * Unknown values fall back to the block stage — an unrecognised application is
 * safest treated as still needing the first review rather than silently
 * appearing approved.
 */
const normalizeStatus = (value) => {
    const key = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_\-.]/g, '');

    if (!key) return STATUS.PENDING_BLOCK;
    return ALIASES[key] || STATUS.PENDING_BLOCK;
};

/** True when the status is one no tier can act on any further. */
const isTerminal = (value) => {
    const s = normalizeStatus(value);
    return s === STATUS.APPROVED || s === STATUS.REJECTED;
};

module.exports = { STATUS, normalizeStatus, isTerminal };
