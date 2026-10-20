// Both SMTP verifications, the log store and retry delivery are offline fixtures.
const assert = require('node:assert/strict');
const path = require('node:path');
const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '../src', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
const logs = [], verified = [], claimed = [], retried = [];
let outcomes;
stub('config/logger', {
    error: (...args) => logs.push(args), info: (...args) => logs.push(args), warn() {},
});
stub('modules/notifications/email.service', {
    verifyConnection: async category => {
        verified.push(category);
        if (outcomes[category] instanceof Error) throw outcomes[category];
        return outcomes[category];
    },
});
stub('modules/notifications/emailAccounts', {
    categoryForEvent: event => event === 'EVENT_BOOKING_REMINDER' ? 'events' : 'membership',
});
const now = new Date();
const rows = [
    { _id: 'event-failure', event: 'EVENT_BOOKING_REMINDER', channel: 'email', status: 'failed', deliveryStatus: 'failed', lastError: 'ETIMEDOUT', createdAt: now },
    { _id: 'member-failure', event: 'MEMBERSHIP_RENEWAL_DUE', channel: 'email', status: 'failed', deliveryStatus: 'failed', lastError: 'EAUTH', createdAt: now },
    { _id: 'custom-failure', event: 'CUSTOM', channel: 'email', status: 'failed', lastError: 'ECONNRESET', createdAt: now },
    { _id: 'already-accepted', event: 'EVENT_BOOKING_REMINDER', channel: 'email', status: 'sent', deliveryStatus: 'accepted', lastError: 'old timeout', createdAt: now },
];
stub('modules/notifications/notificationLog.model', {
    find: query => {
        assert.deepEqual(query.$or, [{ deliveryStatus: 'failed' }, { deliveryStatus: { $exists: false }, status: 'failed' }],
            'health changes must preserve the failed-only retry query');
        assert.deepEqual(query.resentAs, { $exists: false });
        return { sort() { return this; }, limit() { return this; },
            lean: async () => rows.filter(row => row.deliveryStatus === 'failed' || (!row.deliveryStatus && row.status === 'failed')) };
    },
    updateOne: async filter => { claimed.push(filter._id); return { matchedCount: 1 }; },
});
stub('modules/notifications/notification.service', {
    retryLog: async id => { retried.push(id); return { outcome: { success: true } }; },
});
const guard = require('../src/modules/notifications/deliveryGuard');

async function main() {
    const initial = guard.getHealth().email;
    assert.equal(initial.ok, null);
    assert.equal(initial.configured, null);
    assert.equal(initial.accounts.length, 2);
    outcomes = {
        events: { ok: false, configured: true, error: '535 authentication rejected', password: 'must-not-be-exposed' },
        membership: { ok: true, configured: true, auth: { pass: 'must-not-be-exposed' } },
    };
    const first = await guard.checkEmail();
    assert.deepEqual(verified, ['events', 'membership'], 'both accounts are authenticated independently');
    assert.equal(first.ok, false);
    assert.equal(first.configured, true);
    assert.ok(first.checkedAt instanceof Date);
    assert.match(first.error, /^Events: 535/);
    assert.equal(first.accounts[1].ok, true);
    assert.ok(!JSON.stringify(first).includes('must-not-be-exposed'), 'only health fields are exposed');
    first.accounts[1].ok = false;
    assert.equal(guard.getHealth().email.accounts[1].ok, true, 'public health snapshots cannot mutate internal routing');
    const mixed = await guard.retryFailed({ auto: true });
    assert.equal(mixed.checked, 3);
    assert.equal(mixed.waitingForEmail, 1);
    assert.equal(mixed.sent, 2);
    assert.deepEqual(retried, ['member-failure', 'custom-failure'], 'failed events authentication must not block membership retries');
    assert.deepEqual(claimed, retried, 'waiting event rows do not spend retry attempts');

    outcomes = { events: { ok: true, configured: true }, membership: { ok: false, configured: false, error: 'Membership SMTP not configured' } };
    const second = await guard.checkEmail();
    assert.equal(second.ok, false);
    assert.equal(second.configured, false);
    assert.match(second.error, /^Membership:/);
    claimed.length = 0; retried.length = 0;
    const reversed = await guard.retryFailed({ auto: false });
    assert.equal(reversed.waitingForEmail, 2);
    assert.equal(reversed.sent, 1);
    assert.deepEqual(retried, ['event-failure'], 'failed membership authentication must not block event retries');
    assert.deepEqual(claimed, retried);

    outcomes = { events: new Error('Fixture SMTP connection failed'), membership: { ok: true, configured: true } };
    verified.length = 0;
    const thrown = await guard.checkEmail();
    assert.deepEqual(verified, ['events', 'membership']);
    assert.equal(thrown.accounts[0].ok, false);
    assert.equal(thrown.accounts[1].ok, true, 'one verification exception cannot hide the other sender');
    assert.match(thrown.error, /Events: Fixture SMTP connection failed/);

    outcomes = { events: { ok: true, configured: true }, membership: { ok: true, configured: true } };
    const recovered = await guard.checkEmail();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.configured, true);
    assert.equal(recovered.error, '');
    assert.ok(recovered.accounts.every(account => account.ok && account.error === ''));
    assert.ok(logs.some(args => args[0].includes('Events email recovered')));
    assert.ok(logs.some(args => args[0].includes('Membership email recovered')));
    assert.ok(!retried.includes('already-accepted'));
    console.log('PASS: independent event/member SMTP health, isolated retry eligibility, safe legacy-compatible health, verification exceptions and recovery; no provider or database calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
