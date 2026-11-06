const mongoose = require('mongoose');
const Application = require('./application.model');
const Member = require('../members/memberdetails.model');
const { normalizeStatus } = require('../common/applicationStatus');

const idOf = value => String(value?._id || value || '');
const ownerOf = row => idOf(row.userId || row.user || row.get?.('user'));
const legacyIds = values => [...new Set(values.map(idOf))].filter(id => mongoose.isValidObjectId(id))
    .flatMap(id => [id, new mongoose.Types.ObjectId(id)]);
const dateOf = row => new Date(row.createdAt || 0).getTime() || 0;
const rank = row => ({ Approved: 3, Pending: 2, Rejected: 1 })[normalizeStatus(row.status)];

/** One current file per confirmed owner. Contact details are never identity keys. */
function currentApplications(rows, { ownerMap = new Map(), includeRejectedHistory = false } = {}) {
    const winners = new Map();
    const keyOf = row => ownerOf(row) ? `owner:${ownerMap.get(ownerOf(row)) || ownerOf(row)}` : `file:${idOf(row._id)}`;
    for (const row of rows) {
        const key = keyOf(row), previous = winners.get(key);
        if (!previous || rank(row) > rank(previous)) { winners.set(key, row); continue; }
        if (rank(row) !== rank(previous)) continue;
        // An existing approval stays authoritative; otherwise use the newest
        // submission. ObjectId is the stable tie-breaker for identical times.
        const order = dateOf(row) - dateOf(previous) || idOf(row._id).localeCompare(idOf(previous._id));
        if (normalizeStatus(row.status) === 'Approved' ? order < 0 : order > 0) winners.set(key, row);
    }
    return rows.filter(row => winners.get(keyOf(row)) === row
        || (includeRejectedHistory && normalizeStatus(row.status) === 'Rejected'));
}

/** Only aliases recorded on a member profile may join two stored owner IDs. */
async function confirmedOwnerIds(ids) {
    const valid = [...new Set(ids.map(idOf))].filter(id => mongoose.isValidObjectId(id));
    const ownerMap = new Map();
    if (!valid.length) return { ownerMap, ids: valid };
    const profileFilter = values => ({ $or: [{ _id: { $in: values } }, { userId: { $in: values } }, { memberId: { $in: legacyIds(values) } }] });
    const matched = await Member.find(profileFilter(valid))
        .select('_id userId memberId').lean();
    const aliases = new Set([...valid, ...matched.flatMap(member => [member._id, member.userId, member.memberId].map(idOf).filter(id => mongoose.isValidObjectId(id)))]);
    // An alias may actually be another profile's primary ID, or be shared by
    // two legacy profiles. Resolve these conflicts even when only one owner
    // was requested; never infer that every ID on that one profile is theirs.
    const members = aliases.size > valid.length
        ? await Member.find(profileFilter([...aliases])).select('_id userId memberId').lean()
        : matched;
    const candidates = new Map();
    for (const member of members) {
        for (const value of [member._id, member.userId, member.memberId]) {
            const id = idOf(value);
            if (!aliases.has(id)) continue;
            if (!candidates.has(id)) candidates.set(id, new Set());
            candidates.get(id).add(idOf(member._id));
        }
    }
    for (const [alias, owners] of candidates) if (owners.size === 1) ownerMap.set(alias, [...owners][0]);
    // A real profile ID always identifies that profile, even if bad legacy
    // data happens to reuse it as an alias on another profile.
    for (const member of members) if (aliases.has(idOf(member._id))) ownerMap.set(idOf(member._id), idOf(member._id));
    return { ownerMap, ids: [...new Set([...valid, ...ownerMap.keys()])] };
}

/**
 * Compare against ALL sibling files before retaining a geo/search-scoped row.
 * A duplicate pending file must not reappear by selecting its old region.
 */
async function filterCurrentApplications(rows, options = {}) {
    if (!rows.length) return rows;
    const { ownerMap, ids } = await confirmedOwnerIds(rows.map(ownerOf));
    if (!ids.length) return currentApplications(rows, options);
    const siblings = await Application.find({ $or: [{ userId: { $in: ids } }, { userId: null, user: { $in: legacyIds(ids) } }] })
        .select('_id userId user status createdAt').lean();
    const byId = new Map([...siblings, ...rows].map(row => [idOf(row._id), row]));
    const visible = new Set(currentApplications([...byId.values()], { ...options, ownerMap }).map(row => idOf(row._id)));
    return rows.filter(row => visible.has(idOf(row._id)));
}

module.exports = { currentApplications, filterCurrentApplications, confirmedOwnerIds, idOf, ownerOf, legacyIds };
