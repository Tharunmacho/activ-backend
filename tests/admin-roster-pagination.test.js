// Fixture-only regression coverage: no database, accounts or messages changed.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const rosterPage = require('../src/modules/admin/adminRosterPage');
const regionalRoles = ['state_admin', 'district_admin', 'block_admin'];
const superScope = { role: 'super_admin', state: '', district: '' };
const rows = Array.from({ length: 8184 }, (_, i) => ({
    id: String(i).padStart(8, '0'), fullName: `Regional ${String(i).padStart(5, '0')}`,
    email: `fixture-${i}@example.test`, active: true,
    role: regionalRoles[i % 3], state: i % 2 ? 'Tamil Nadu' : 'Kerala',
    district: i % 2 ? 'Chennai' : 'Kollam', block: `Block ${i % 10}`
}));
const staff = ['cms_admin', 'events_admin', 'attendance_admin'].map((role, i) => ({
    id: `staff-${i}`, fullName: `Staff ${i}`, email: `staff-${i}@example.test`, role,
    roleLabel: ['CMS Administrator', 'Events Administrator', 'Attendance Administrator'][i], active: true
}));
const roster = [...rows, ...staff, { id: 'super', fullName: 'Super', role: 'super_admin', active: true }];
const select = (filters = {}, scope = superScope, allowed = regionalRoles) => rosterPage(roster, filters, scope, allowed);

async function main() {
    const started = performance.now();
    const first = select({ kind: 'regional', page: 1, limit: 25 });
    assert.equal(first.admins.length, 25);
    assert.equal(first.total, 8184);
    assert.deepEqual(first.counts, { all: 8184, state_admin: 2728, district_admin: 2728, block_admin: 2728, staff: 0 });
    assert.deepEqual(first.pagination, { page: 1, limit: 25, total: 8184, pages: 328 });
    const second = select({ kind: 'regional', page: 2, limit: 25 });
    assert.equal(second.admins[0].id, rows[25].id);
    assert(!second.admins.some(row => first.admins.some(a => a.id === row.id)));
    assert.equal(select({ page: 1, limit: 50000 }).admins.length, 100, 'bounded even with a hostile requested limit');
    assert.equal(select({ page: -1, limit: 'invalid' }).admins.length, 25);
    assert.equal(select({ kind: 'regional', page: 99999, limit: 25 }).pagination.page, 328);
    assert.equal(select({ kind: 'regional', page: 99999, limit: 25 }).admins.length, 9);
    assert.equal(select({ kind: 'regional', q: 'regional 08183', page: 1 }).admins[0].id, rows[8183].id, 'search includes last stored row, not only loaded page');
    assert.equal(select({ kind: 'regional', q: 'regional 08183', page: 1 }).counts.all, 8184, 'tab counts retain their geographic scope while search narrows the result total');
    assert.equal(select({ state: ' tamil nadu ', district: 'CHENNAI', block: 'Block 1', page: 1 }).total, 819);
    assert.equal(select({ kind: 'regional', role: 'district_admin', q: 'REGIONAL', page: 1 }).total, 2728);
    assert.equal(select({ kind: 'regional', role: 'district_admin', q: 'REGIONAL', page: 1 }).counts.block_admin, 2728, 'tabs count matches across every role');
    assert.equal(select({ role: 'staff', page: 1 }).admins.length, 3);
    assert.equal(select({ role: 'staff', q: 'CMS Administrator', page: 1 }).admins[0].role, 'cms_admin');
    assert.equal(select({ role: 'invalid', page: 1 }).total, 0);
    assert.equal(select({ q: 'unmatched', page: 1 }).pagination.pages, 1);
    assert.equal(select({ kind: 'regional' }).admins.length, 8184, 'existing unpaginated clients remain compatible');
    assert.equal(select().admins.length, 8188, 'legacy all includes every existing role');
    const region = first.admins[0];
    assert.equal(region.coAdmins, rows.filter(row => row.role === region.role && row.state === region.state && row.district === region.district && row.block === region.block).length - 1, 'queue sharing includes other pages');

    const stateScope = { role: 'state_admin', state: 'Tamil Nadu', district: '' };
    const state = select({ page: 1, limit: 100 }, stateScope, ['district_admin', 'block_admin']);
    assert(state.admins.every(row => row.state === 'Tamil Nadu' && row.role !== 'state_admin'));
    assert.equal(state.counts.staff, 0);
    assert.equal(select({ state: 'Kerala', page: 1 }, stateScope, ['district_admin', 'block_admin']).total, 0, 'client filters cannot broaden state scope');
    const districtScope = { role: 'district_admin', state: 'Tamil Nadu', district: 'Chennai' };
    assert(select({ page: 1 }, districtScope, ['block_admin']).admins.every(row => row.role === 'block_admin' && row.district === 'Chennai'));
    for (const scope of [{ role: 'member' }, { role: 'cms_admin' }, { role: 'block_admin' }, { role: 'state_admin', state: '' }, { role: 'district_admin', state: 'Tamil Nadu', district: '' }]) {
        assert.equal(select({ page: 1, role: 'staff' }, scope).total, 0, 'unprivileged or unscoped caller cannot read roster');
    }
    const updated = roster.map(row => row.id === '00008183' ? { ...row, fullName: 'Updated fixture' } : row);
    assert.equal(rosterPage(updated, { q: 'Updated fixture', page: 1 }, superScope, regionalRoles).total, 1, 'a replaced repository snapshot rebuilds the index');
    for (let i = 0; i < 100; i++) select({ kind: 'regional', page: i + 1, limit: 25, q: 'regional' });
    const encoded = Buffer.byteLength(JSON.stringify(first));
    assert(encoded < Buffer.byteLength(JSON.stringify(select({ kind: 'regional' }))) / 100, 'page payload is at least 100x smaller than full roster');

    const mongoose = require('mongoose');
    mongoose.set('bufferCommands', false);
    const service = require('../src/modules/admin/superadmin.service');
    let reads = 0;
    service.allAdminRows = async () => { reads++; return roster; };
    const result = await service.listAdmins({ kind: 'regional', page: 1, limit: 25 }, { role: 'super_admin' });
    assert.equal(reads, 1, 'service reads the roster once, not again per queue or page');
    assert.equal(result.admins.length, 25);
    const adminService = require('../src/modules/admin/admin.service');
    adminService.resolveAdminScope = async () => ({ stateName: 'Tamil Nadu', districtName: 'Chennai' });
    const stateResult = await service.listAdmins({ kind: 'regional', page: 1, state: 'Kerala' }, { role: 'state_admin' });
    assert.equal(stateResult.total, 0, 'service applies the resolved actor scope before requested filters');
    const beforeDeniedRead = reads;
    const denied = await service.listAdmins({ page: 1, role: 'staff' }, { role: 'cms_admin' });
    assert.equal(denied.total, 0);
    assert.equal(reads, beforeDeniedRead, 'unprivileged requests do not scan the roster');
    adminService.resolveAdminScope = async () => ({ stateName: '', districtName: '' });
    assert.equal((await service.listAdmins({ page: 1 }, { role: 'state_admin' })).total, 0, 'an empty resolved scope fails closed');
    console.log(`PASS: admin roster pagination, full-roster search, tab counts, exact regions, staff roles, queue counts, scope isolation, legacy clients and snapshot refresh. 100 fixture page reads completed; first response ${encoded} bytes; elapsed ${Math.round(performance.now() - started)} ms.`);
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
