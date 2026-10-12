const REGIONAL_ROLES = new Set(['state_admin', 'district_admin', 'block_admin']);
const STAFF_ROLES = new Set(['cms_admin', 'events_admin', 'attendance_admin']);
const indexes = new WeakMap();
const text = value => String(value || '').trim().toLowerCase();
const regionKey = row => [row.role, text(row.state), text(row.district), text(row.block)].join('|');

// The repository replaces its cached array after a refresh or a write. Reuse
// this index for that exact snapshot; never cache permission-filtered results.
const indexFor = rows => {
    if (indexes.has(rows)) return indexes.get(rows);
    const regions = new Map();
    for (const row of rows) {
        if (!row.active) continue;
        const key = regionKey(row);
        regions.set(key, (regions.get(key) || 0) + 1);
    }
    const entries = rows.map(row => ({
        row,
        state: text(row.state), district: text(row.district), block: text(row.block),
        search: [row.fullName, row.email, row.state, row.district, row.block, row.roleLabel].map(text).join(' '),
        coAdmins: Math.max(0, (regions.get(regionKey(row)) || 0) - (row.active ? 1 : 0))
    })).sort((a, b) => String(a.row.fullName || '').localeCompare(String(b.row.fullName || '')) ||
        String(a.row.id || '').localeCompare(String(b.row.id || '')));
    indexes.set(rows, entries);
    return entries;
};

const positiveInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const adminRosterPage = (rows, filters, scope, allowedRoles) => {
    const paginated = filters.page !== undefined || filters.limit !== undefined;
    const limit = Math.min(100, positiveInteger(filters.limit, 25));
    const requestedPage = positiveInteger(filters.page, 1);
    const counts = { all: 0, state_admin: 0, district_admin: 0, block_admin: 0, staff: 0 };
    const selected = [];
    const needle = text(filters.q);
    const role = text(filters.role);
    const state = text(filters.state), district = text(filters.district), block = text(filters.block);
    const scopeState = text(scope.state), scopeDistrict = text(scope.district);
    const superAdmin = scope.role === 'super_admin';
    const authorized = superAdmin || (scope.role === 'state_admin' && scopeState) ||
        (scope.role === 'district_admin' && scopeState && scopeDistrict);

    if (authorized) for (const entry of indexFor(rows)) {
        const row = entry.row;
        if (!superAdmin && !allowedRoles.includes(row.role)) continue;
        if (!superAdmin && entry.state !== scopeState) continue;
        if (scope.role === 'district_admin' && entry.district !== scopeDistrict) continue;
        if (filters.kind === 'regional' && !REGIONAL_ROLES.has(row.role)) continue;
        if (state && entry.state !== state) continue;
        if (district && entry.district !== district) continue;
        if (block && entry.block !== block) continue;
        // Tabs describe the accounts in this geography. Search narrows the
        // result total, not the other tabs, matching existing clients.
        counts.all += 1;
        if (REGIONAL_ROLES.has(row.role)) counts[row.role] += 1;
        if (STAFF_ROLES.has(row.role)) counts.staff += 1;
        if (role && role !== 'all' && (role === 'staff' ? !STAFF_ROLES.has(row.role) : row.role !== role)) continue;
        if (needle.length >= 2 && !entry.search.includes(needle)) continue;
        selected.push(entry);
    }

    const total = selected.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, pages);
    const visible = paginated ? selected.slice((page - 1) * limit, page * limit) : selected;
    return {
        admins: visible.map(({ row, coAdmins }) => ({
            ...row, coAdmins, region: [row.block, row.district, row.state].filter(Boolean).join(', ')
        })),
        counts,
        total,
        ...(paginated ? { pagination: { page, limit, total, pages } } : {}),
        scope: { role: scope.role, state: scope.state, district: scope.district, manageableRoles: authorized ? allowedRoles : [] }
    };
};

module.exports = adminRosterPage;
