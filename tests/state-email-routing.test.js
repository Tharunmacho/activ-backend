// Service-level fixtures only: no database connection or outbound email.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const repository = require('../src/modules/admin/admin.repository');
const routing = require('../src/modules/admin/adminNotificationEmail');
const { emailFor, legacyEmailFor } = require('../src/modules/admin/nationalAdminPlan');
const geography = require('../src/modules/regions/data/india-geography.json');
const notifications = require('../src/modules/notifications/notification.service');
const context = require('../src/modules/notifications/membershipContext');
const contacts = require('../src/modules/notifications/regionalContacts.service');
const adminService = require('../src/modules/admin/admin.service');
const superAdmin = require('../src/modules/admin/superadmin.service');
const applications = require('../src/modules/applications/application.service');
const rows = new Map();
const alerts = [];
let freshReads = 0;
let writes = 0;
const actor = { role: 'super_admin', email: 'super@example.test' };

const hitFor = doc => ({ doc, objectId: doc._id, source: 'stateadmins', sourceKey: 'adminsdb:stateadmins',
    handle: { updateOne: async (_filter, update) => {
        writes += 1;
        Object.assign(doc, update.$set);
        for (const field of Object.keys(update.$unset || {})) delete doc[field];
        return { modifiedCount: 1 };
    } }
});
const store = data => {
    const doc = { ...repository.toTierDocument(data, 'STA-FIXTURE'), _id: new mongoose.Types.ObjectId() };
    rows.set(String(doc._id), doc);
    return repository.toAdminRow(doc, 'stateadmins');
};
repository.insert = async data => store(data);
repository.findRawById = async id => rows.has(String(id)) ? hitFor(rows.get(String(id))) : null;
repository.findRawByEmail = async email => {
    const row = [...rows.values()].find(doc => doc.email === email);
    return row ? hitFor(row) : null;
};
repository.emailExists = async (email, exceptId) => [...rows.values()].some(doc => doc.email === email && String(doc._id) !== exceptId);
repository.findActive = async (options = {}) => {
    if (!options.fresh) return []; // Simulate another worker's old cached roster.
    freshReads += 1;
    return [...rows.values()].map(doc => repository.toAdminRow(doc, 'stateadmins')).filter(row => row.active);
};
require('../src/modules/common/passwordHash').hash = async () => 'fixture-password-hash';
require('../src/modules/admin/admin.regions').resolveRegion = async (_role, data) => ({
    state: data.state, district: data.district || '', block: data.block || '', warnings: [], created: []
});
require('../src/modules/audit/audit.service').record = async () => {};
require('../src/modules/auth/auth.model').findOneAndUpdate = async () => null;
adminService.getAdminProfile = async user => user;
context.forApplication = async app => ({ region: { state: app.state, district: '', block: '' }, regionLabel: app.state });
context.recipientForApplication = async () => ({ email: 'applicant@example.test' });
notifications.dispatchLifecycleEvent = async () => {};
notifications.dispatchInBackground = async (...args) => { alerts.push(args); };

async function assertDelivery(state, email) {
    alerts.length = 0;
    const beforeReads = freshReads;
    await applications.announceSubmission({ _id: 'fixture-application', state, fullName: 'Fixture applicant' });
    assert.equal(alerts.length, 1, `${state}: exactly its active scoped admin receives the alert`);
    assert.equal(alerts[0][0], 'ADMIN_NEW_APPLICATION');
    assert.equal(alerts[0][1].email, email, `${state}: current notification destination`);
    assert(freshReads > beforeReads, `${state}: bypasses stale roster cache`);
    assert.equal(alerts[0][2].reviewPath, '/state-admin/approvals');
}

async function main() {
    for (const [index, state] of geography.states.entries()) {
        rows.clear();
        const name = state.state;
        store({ role: 'state_admin', state: name === 'Tamil Nadu' ? 'Karnataka' : 'Tamil Nadu', email: 'other-state@example.test' });
        store({ role: 'state_admin', email: 'unscoped@example.test' });
        store({ role: 'state_admin', state: name, email: 'inactive@example.test', active: false });
        let admin = await superAdmin.createAdmin({ role: 'state_admin', state: name, fullName: 'Fixture admin',
            email: `new-${index}@example.test`, password: 'fixture-password' }, actor);
        assert.equal(admin.notificationEmailSource, 'account');
        await assertDelivery(name, admin.email);

        admin = await superAdmin.updateAdmin(admin.id, { email: `edited-${index}@example.test` }, actor);
        await assertDelivery(name, admin.email);
        admin = await superAdmin.updateAdmin(admin.id, { notificationEmail: ` Inbox-${index}@example.test ` }, actor);
        assert.equal(admin.notificationEmailSource, 'custom');
        admin = await superAdmin.updateAdmin(admin.id, { email: `login-${index}@example.test` }, actor);
        await assertDelivery(name, `inbox-${index}@example.test`);

        // Clearing a distinct destination activates an already-created mailbox
        // even when its sign-in address itself has not changed.
        admin = await superAdmin.updateAdmin(admin.id, { notificationEmail: '' }, actor);
        await assertDelivery(name, admin.email);

        rows.delete(admin.id);
        const imported = { role: 'state_admin', state: name, fullName: 'Imported state admin',
            notificationEmail: 'member@activ.org.in', createdVia: 'super_admin_ui' };
        imported.email = index % 2 ? emailFor(imported) : legacyEmailFor(imported);
        admin = store(imported);
        assert.equal(admin.notificationEmailSource, 'provisioning_fallback');
        admin = await superAdmin.updateAdmin(admin.id, { fullName: 'Updated name only' }, actor);
        await assertDelivery(name, 'member@activ.org.in');
        admin = await superAdmin.updateAdmin(admin.id, { email: `created-mailbox-${index}@example.test` }, actor);
        assert.equal(admin.notificationEmail, '');
        assert.equal(admin.notificationEmailSource, 'account');
        await assertDelivery(name, admin.email);
    }

    rows.clear();
    const regional = { role: 'state_admin', state: 'Kerala', fullName: 'Fixture', email: 'prstkl@activ.org.in',
        notificationEmail: 'member@activ.org.in', createdVia: 'super_admin_ui' };
    const imported = store(regional);
    const beforeInvalid = writes;
    await assert.rejects(superAdmin.updateAdmin(imported.id, { notificationEmail: 'invalid address' }, actor), error => error.statusCode === 400);
    await assert.rejects(superAdmin.createAdmin({ role: 'state_admin', state: 'Kerala', fullName: 'Fixture',
        email: 'valid@example.test', password: 'fixture-password', notificationEmail: 'bad' }, actor), error => error.statusCode === 400);
    assert.equal(writes, beforeInvalid, 'invalid addresses never reach persistence');
    await adminService.updateAdminProfile({ role: 'state_admin', email: regional.email }, { email: 'self-edited@example.test' });
    await assertDelivery('Kerala', 'self-edited@example.test');

    const intentionalOffice = { ...regional, notificationEmailSource: 'custom' };
    assert.deepEqual(routing.forWrite(intentionalOffice, { email: 'another@example.test' }), {
        notificationEmail: 'member@activ.org.in', notificationEmailSource: 'custom'
    }, 'an explicitly chosen office destination survives a login email edit');
    assert.equal(routing.sourceFor({ ...regional, email: 'chosen-by-admin@example.test' }), 'custom');
    const explicitSameInbox = { email: 'fixed-inbox@example.test', notificationEmail: 'fixed-inbox@example.test', notificationEmailSource: 'custom' };
    for (const change of [{ fullName: 'Edited name' }, { email: 'new-login@example.test' }]) {
        assert.deepEqual(routing.forWrite(explicitSameInbox, change), {
            notificationEmail: 'fixed-inbox@example.test', notificationEmailSource: 'custom'
        }, 'an explicit fixed inbox remains fixed even if it originally matched the login');
    }
    assert.deepEqual(routing.forWrite({ email: 'old@example.test', notificationEmail: 'old@example.test' }, { email: 'new@example.test' }), {
        notificationEmail: '', notificationEmailSource: 'account'
    }, 'legacy untagged addresses that followed the account continue to follow it');
    assert.equal(routing.destinationFor({ email: 'guessed-block@example.test' }, { allowAccountEmail: false }), '');
    assert.equal(routing.destinationFor({ email: 'valid@example.test', notificationEmail: 'malformed' }), '');

    // Contact details use the same configured destination; never invent an
    // address for an unstaffed region or expose a generated login as its inbox.
    repository.findActive = async () => [repository.toAdminRow({ ...regional, notificationEmailSource: 'provisioning_fallback' })];
    assert.equal((await contacts.resolveForRegion({ state: 'Kerala' })).replyTo, 'member@activ.org.in');
    const unstaffed = await contacts.resolveForRegion({ state: 'Maharashtra' });
    assert.equal(unstaffed.contacts.state.email, '');
    assert.equal(unstaffed.nearest, null);
    console.log(`PASS: all ${geography.states.length} states/UTs create, edit, activate and route to current inboxes; custom overrides, imported fallback, self edits, recipient scope and fresh reads verified. No messages sent.`);
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
