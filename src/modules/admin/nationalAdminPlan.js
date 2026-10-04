const crypto = require('crypto');
const geography = require('../regions/geography');
const directory = require('../regions/data/india-geography.json');
const norm = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const key = row => {
    const region = geography.normalizeRegion(row);
    return [row.role, region.state, row.role !== 'state_admin' ? region.district : '', row.role === 'block_admin' ? region.block : ''].map(norm).join('|');
};
// Recognise the first nationwide import so its generated logins can be shortened
// without renaming an address that an administrator has chosen themselves.
const legacyEmailFor = row => {
    const prefix = { state_admin: 'state', district_admin: 'district', block_admin: 'block' }[row.role];
    const label = row.block || row.district || row.state;
    const slug = norm(label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 25);
    return `${prefix}-${slug}-${crypto.createHash('sha256').update(key(row)).digest('hex').slice(0, 10)}@activ.org.in`;
};
const stateCodes = {
    1: 'jk', 2: 'hp', 3: 'pb', 4: 'ch', 5: 'uk', 6: 'hr', 7: 'dl', 8: 'rj', 9: 'up',
    10: 'br', 11: 'sk', 12: 'ar', 13: 'nl', 14: 'mn', 15: 'mz', 16: 'tr', 17: 'ml',
    18: 'as', 19: 'wb', 20: 'jh', 21: 'od', 22: 'cg', 23: 'mp', 24: 'gj', 27: 'mh',
    28: 'ap', 29: 'ka', 30: 'ga', 31: 'ld', 32: 'kl', 33: 'tn', 34: 'py', 35: 'an',
    36: 'ts', 37: 'la', 38: 'dn',
};
const slug = value => norm(value).replace(/[^a-z0-9]/g, '');
const stateCode = row => {
    const name = geography.normalizeRegion(row).state;
    const state = directory.states.find(s => norm(s.state) === norm(name));
    if (!state || !stateCodes[state.code]) throw new Error(`Unknown state: ${name}`);
    return stateCodes[state.code];
};
const blockCounts = new Map();
for (const state of directory.states) for (const district of state.districts) for (const block of district.block) {
    const name = slug(block).slice(0, 24);
    blockCounts.set(name, (blockCounts.get(name) || 0) + 1);
}
const emailFor = row => {
    const code = stateCode(row);
    if (row.role === 'state_admin') return `prst${code}@activ.org.in`;
    if (row.role === 'district_admin') return `${slug(row.district).slice(0, 3)}${code}d@activ.org.in`;
    if (row.role !== 'block_admin') throw new Error('Only regional admin logins can be generated');
    const name = slug(row.block).slice(0, 24);
    if (!name) throw new Error('Block name is required');
    return `${name}${blockCounts.get(name) > 1 ? code : ''}@activ.org.in`;
};
const allocateEmail = (row, taken) => {
    const base = emailFor(row).split('@')[0];
    let local = base;
    if (taken.has(`${local}@activ.org.in`) && row.role === 'block_admin') {
        local = `${base}${base.endsWith(stateCode(row)) ? '' : stateCode(row)}${slug(row.district).slice(0, 3)}`;
    }
    const prefix = local;
    let suffix = 2;
    while (taken.has(`${local}@activ.org.in`)) local = `${prefix}${suffix++}`;
    const email = `${local}@activ.org.in`;
    taken.add(email);
    return email;
};
function shortLoginPlan(existing = []) {
    const protectedStates = new Set(['tn', 'ka', 'py']);
    const targets = existing.filter(row => ['state_admin', 'district_admin', 'block_admin'].includes(row.role)
        && !protectedStates.has(stateCode(row)) && norm(row.email) === legacyEmailFor(row));
    const replacing = new Set(targets.map(row => norm(row.email)));
    const taken = new Set(existing.filter(row => !replacing.has(norm(row.email))).map(row => norm(row.email)));
    return targets.sort((a, b) => key(a).localeCompare(key(b))).map(row => ({
        ...row, previousEmail: row.email, email: allocateEmail(row, taken),
    }));
}
function plan(existing = []) {
    const covered = new Set(existing.map(key));
    const emailOwners = new Set(existing.map(r => norm(r.email)));
    const missing = [];
    const add = row => {
        const id = key(row);
        if (covered.has(id)) return;
        const email = allocateEmail(row, emailOwners);
        covered.add(id); emailOwners.add(email);
        missing.push({ ...row, email, fullName: `${row.block || row.district || row.state} ${row.role.replace('_admin', '')[0].toUpperCase()}${row.role.replace('_admin', '').slice(1)} Admin`, notificationEmail: 'member@activ.org.in' });
    };
    for (const s of directory.states) {
        add({ role: 'state_admin', state: s.state, district: '', block: '' });
        for (const d of s.districts) {
            add({ role: 'district_admin', state: s.state, district: d.district, block: '' });
            for (const block of d.block) add({ role: 'block_admin', state: s.state, district: d.district, block });
        }
    }
    return missing;
}
module.exports = { plan, key, emailFor, legacyEmailFor, shortLoginPlan };
