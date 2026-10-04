/* National registration, review routing and messaging; isolated fixtures only. */
const assert = require('assert/strict');
const cachePath = require.resolve('../src/core/cache/cacheClient');
require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true, exports: {
    get: async () => null, set: async () => {}, del: async () => {}, deletePattern: async () => {}
} };
const geography = require('../src/modules/regions/geography');
const source = require('../src/modules/regions/data/india-geography.json');
const repository = require('../src/modules/admin/admin.repository');
const regions = require('../src/modules/regions/region.service');
const contacts = require('../src/modules/notifications/regionalContacts.service');
const templates = require('../src/modules/notifications/notificationTemplates');
const notifications = require('../src/modules/notifications/notification.service');
const context = require('../src/modules/notifications/membershipContext');
const applications = require('../src/modules/applications/application.service');
const Application = require('../src/modules/applications/application.model');
const members = require('../src/modules/members/memberdetails.model');
const personal = require('../src/modules/members/personalinfo1.model');
const superAdmin = require('../src/modules/admin/superadmin.service');
const controllers = require('../src/modules/regions/region.controller');
const { categoryForEvent, accountFor } = require('../src/modules/notifications/emailAccounts');
const config = require('../src/config');

let passed = 0;
const test = async (name, run) => { await run(); passed += 1; console.log(`PASS ${name}`); };
const roster = [
    { role: 'state_admin', state: 'Tamil Nadu', email: 'state@example.test', active: true },
    { role: 'district_admin', state: 'Tamil Nadu', district: 'Ariyalur', email: 'district@example.test', active: true },
    { role: 'block_admin', state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai', email: 'block@example.test', active: true },
    { role: 'super_admin', email: 'office@example.test', active: true }
];
let active = roster;
repository.findActive = async () => active;
const call = (handler, query = {}) => new Promise((resolve, reject) => handler({ query }, { json: resolve }, reject));
const fixtureRegion = { state: 'Bihar', district: 'Patna', block: geography.listBlocks('Bihar', 'Patna')[0] };

(async () => {
    await test('LGD snapshot contains 36 states/UTs, 784 districts and 7,323 unique blocks', () => {
        assert.deepEqual(source.source.counts, { states: 36, districts: 784, developmentBlocks: 7323 });
        assert.equal(source.states.length, 36);
        assert.equal(source.states.flatMap(s => s.districts).length, 784);
        assert.equal(new Set(source.states.map(s => s.code)).size, 36);
        assert.equal(new Set(source.states.flatMap(s => s.districts).map(d => d.code)).size, 784);
        assert.ok(source.states.every(s => s.districts.length));
    });
    await test('every source district and block is offered under its exact parent', async () => {
        const tree = await regions.getLocationTree();
        for (const state of source.states) {
            const found = tree.find(s => s.name === state.state);
            assert.ok(found, state.state);
            for (const district of state.districts) {
                const child = found.districts.find(d => d.name === district.district);
                assert.ok(child, `${state.state}/${district.district}`);
                assert.deepEqual(child.blocks.map(b => b.name).sort(), district.block.slice().sort());
                assert.ok(!child.blocks.some(b => /^(nan|null|undefined)$/i.test(b.name)));
            }
        }
    });
    await test('public default and all trees expose national locations without admin identities', async () => {
        for (const query of [{}, { include: 'all' }]) {
            const result = await call(controllers.getTree, query);
            assert.equal(result.data.states.length, 36);
            assert.equal(result.data.source.snapshot, '03Oct2026');
            assert.ok(!JSON.stringify(result).includes('@example.test'));
        }
        const state = await call(controllers.getDistricts, { state: 'Bihar' });
        assert.equal(state.data.districts.length, geography.listDistricts('Bihar').length);
        const district = await call(controllers.getBlocks, fixtureRegion);
        assert.deepEqual(district.data.blocks.map(b => b.name), geography.listBlocks('Bihar', 'Patna'));
    });
    await test('an unstaffed national location validates and is reviewed by Super Admin', async () => {
        const result = await regions.validateRegion(fixtureRegion);
        assert.equal(result.ok, true);
        assert.equal(result.reviewBy, 'super_admin');
        assert.deepEqual(result.region, fixtureRegion);
        assert.deepEqual(result.coverage, { state: 0, district: 0, block: 0 });
    });
    await test('districts and blocks from another parent are rejected', async () => {
        assert.equal((await regions.validateRegion({ state: 'Bihar', district: 'Ariyalur' })).ok, false);
        assert.equal((await regions.validateRegion({ ...fixtureRegion, block: 'Sendurai' })).ok, false);
        assert.equal((await regions.validateRegion({ state: 'Tamil Nadu', block: 'Sendurai' })).ok, false);
        assert.equal((await regions.validateRegion({ state: 'Fake state' })).ok, false);
    });
    await test('existing staffing and canonical spellings remain intact', async () => {
        const result = await regions.validateRegion({ state: ' TAMIL NADU ', district: 'ariyalur', block: 'sendurai' });
        assert.equal(result.ok, true);
        assert.equal(result.reviewBy, 'regional_admins');
        assert.deepEqual(result.coverage, { state: 1, district: 1, block: 1 });
        assert.deepEqual(result.region, { state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai' });
        assert.equal((await regions.getTree()).length, 1, 'staffing reports still count real admins only');
    });
    await test('custom regions already staffed are retained alongside national data', async () => {
        active = [...roster, { role: 'block_admin', state: 'Tamil Nadu', district: 'Custom district', block: 'Custom block' }];
        const result = await regions.validateRegion({ state: 'Tamil Nadu', district: 'Custom district', block: 'Custom block' });
        assert.equal(result.ok, true);
        assert.equal(result.coverage.block, 1);
        active = roster;
    });
    await test('district-only urban registration never invents a block', async () => {
        const state = source.states.find(s => s.districts.some(d => !d.block.length));
        const district = state.districts.find(d => !d.block.length);
        const region = { state: state.state, district: district.district, block: '' };
        assert.equal((await regions.validateRegion(region)).ok, true);
        assert.equal(geography.requiresBlock(region.state, region.district), false);
        const base = { fullName: 'Fixture only', name: 'Fixture only', email: 'fixture@example.test', phoneNumber: '9000000000', userId: '507f1f77bcf86cd799439011', ...region };
        assert.ok(!new members(base).validateSync()?.errors.block);
        assert.ok(!new personal(base).validateSync()?.errors.block);
        const missing = { ...base, state: 'Tamil Nadu', district: 'Ariyalur' };
        assert.ok(new members(missing).validateSync()?.errors.block);
        assert.ok(new personal(missing).validateSync()?.errors.block);
    });
    await test('new regions use a real office reply address; staffed regions retain their inbox', async () => {
        const unstaffed = await contacts.resolveForRegion(fixtureRegion);
        assert.equal(unstaffed.nearest, null);
        assert.equal(unstaffed.replyTo, config.email.supportAddress);
        const staffed = await contacts.resolveForRegion({ state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai' });
        assert.equal(staffed.replyTo, 'district@example.test');
    });
    await test('all states share membership email and WhatsApp templates with their own region facts', () => {
        for (const state of source.states) {
            const district = state.districts[0];
            const region = { state: state.state, district: district.district, block: district.block[0] || '' };
            const ctx = { name: 'Fixture', region, applicantName: 'Fixture', applicantEmail: 'fixture@example.test', applicantRegion: Object.values(region).join(', ') };
            for (const event of ['ACCOUNT_REGISTERED', 'APPLICATION_SUBMITTED', 'ADMIN_NEW_APPLICATION']) {
                const rendered = templates.render(event, ctx);
                assert.ok(rendered.email.subject);
                assert.ok(JSON.stringify(rendered.email).includes(state.state));
                assert.ok(rendered.whatsapp.text.includes(state.state));
                assert.equal(categoryForEvent(event), 'membership');
            }
        }
        assert.equal(accountFor('membership').useRegionalFrom, false);
    });
    await test('submission alerts use existing templates and notify the office when no state reviewer exists', async () => {
        const alerts = [];
        const receipts = [];
        context.forApplication = async app => ({ region: { state: app.state, district: app.district, block: app.block }, regionLabel: app.state });
        notifications.dispatchLifecycleEvent = async (...args) => { receipts.push(args); };
        notifications.dispatchInBackground = (...args) => { alerts.push(args); };
        await applications.announceSubmission({ _id: 'fixture', userId: 'fixture', fullName: 'Fixture', email: 'fixture@example.test', ...fixtureRegion });
        assert.equal(receipts[0][0], 'APPLICATION_SUBMITTED');
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0][0], 'ADMIN_NEW_APPLICATION');
        assert.equal(alerts[0][1].email, 'office@example.test');
        assert.equal(alerts[0][2].reviewPath, '/super-admin/membership-registrations');
        alerts.length = 0;
        await applications.announceSubmission({ _id: 'fixture', userId: 'fixture', state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai' });
        assert.equal(alerts.length, 3);
        assert.ok(!alerts.some(a => a[1].email === 'office@example.test'));
    });
    await test('Super Admin directory includes an application in an unstaffed national region', async () => {
        const app = { ...fixtureRegion, status: 'Pending' };
        const query = { select: () => query, limit: () => query, lean: async () => [app] };
        Application.find = () => query;
        Application.distinct = async field => [app[field]];
        superAdmin.allAdminRows = async () => roster;
        const result = await superAdmin.computeDirectory({ level: 'state' }, { role: 'super_admin' });
        const bihar = result.regions.find(r => r.name === 'Bihar');
        assert.equal(bihar.applications, 1);
        assert.equal(bihar.pending, 1);
        assert.equal(bihar.admins, 0);
    });
    await test('an empty admin roster still allows every national state but rejects typos', async () => {
        active = [];
        assert.equal((await regions.getLocationTree()).length, 36);
        assert.equal((await regions.validateRegion(fixtureRegion)).ok, true);
        assert.equal((await regions.validateRegion({ state: 'Typo' })).ok, false);
    });
    console.log(`\n${passed} national-region checks passed; no database writes or messages sent.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
