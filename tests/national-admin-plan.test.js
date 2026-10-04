const assert = require('node:assert/strict');
const { plan, key, emailFor, legacyEmailFor, shortLoginPlan } = require('../src/modules/admin/nationalAdminPlan');
const source = require('../src/modules/regions/data/india-geography.json');
const existing = [{ id: 'keep', role: 'state_admin', state: 'Tamil Nadu', email: 'existing@example.test', passwordHash: 'keep-this-hash' }];
const before = JSON.stringify(existing);
const missing = plan(existing);
assert.equal(JSON.stringify(existing), before, 'existing credentials remain untouched');
assert(!missing.some(a => key(a) === key(existing[0])));
assert.equal(new Set(missing.map(a => a.email)).size, missing.length, 'every login address is unique across duplicate region names');
assert(missing.every(a => a.notificationEmail === 'member@activ.org.in'));
const covered = new Set([...existing, ...missing].map(key));
for (const s of source.states) {
    assert(covered.has(key({ role: 'state_admin', state: s.state })));
    for (const d of s.districts) {
        assert(covered.has(key({ role: 'district_admin', state: s.state, district: d.district })));
        for (const block of d.block) assert(covered.has(key({ role: 'block_admin', state: s.state, district: d.district, block })));
    }
}
assert.equal(plan([...existing, ...missing]).length, 0, 'reruns create no duplicate account');
assert.equal(emailFor({ role: 'state_admin', state: 'Kerala' }), 'prstkl@activ.org.in');
assert.equal(emailFor({ role: 'district_admin', state: 'Kerala', district: 'Ernakulam' }), 'ernkld@activ.org.in');
const old = missing.map((row, i) => ({ ...row, id: String(i), email: legacyEmailFor(row), passwordHash: `unchanged-${i}` }));
const occupied = { id: 'custom', role: 'district_admin', state: 'Kerala', district: 'Ernakulam', email: 'ernkld@activ.org.in' };
const oldBefore = JSON.stringify(old);
const changes = shortLoginPlan([...old, occupied]);
assert.equal(JSON.stringify(old), oldBefore, 'planning never alters current accounts');
assert(changes.every(row => !['Tamil Nadu', 'Karnataka', 'Puducherry'].includes(row.state)), 'the established three states keep their addresses');
assert(changes.every(row => row.email.split('@')[0].length <= 34), 'new local parts remain short');
assert.equal(new Set([...changes.map(row => row.email), occupied.email]).size, changes.length + 1, 'custom addresses and repeated names never collide');
assert(changes.every(row => row.passwordHash === old.find(a => a.id === row.id).passwordHash), 'passwords are retained');
assert.equal(changes.find(row => row.role === 'district_admin' && row.state === 'Kerala' && row.district === 'Ernakulam').email, 'ernkld2@activ.org.in');
const byId = new Map(changes.map(row => [row.id, row]));
const migrated = old.map(row => byId.get(row.id) || row);
assert.equal(shortLoginPlan([...migrated, occupied]).length, 0, 'migration is idempotent');
console.log('Nationwide admin plan: every official region, parent-scoped unique logins, existing credentials and idempotent reruns passed.');
