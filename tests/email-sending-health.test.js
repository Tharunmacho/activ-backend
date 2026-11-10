const assert = require('node:assert/strict');
const modelId = require.resolve('../src/modules/notifications/notificationLog.model');
const queries = [];
let answers = [];
let shared = false;
let rotated = false;
const accountsId = require.resolve('../src/modules/notifications/emailAccounts');
require.cache[accountsId] = { id: accountsId, filename: accountsId, loaded: true, exports: {
    accountFor: category => ({ host: 'smtp.example.test', port: 465, secure: true,
        user: shared ? 'shared-fixture' : category, password: rotated && category === 'events' ? 'rotated-fixture' : 'password-fixture',
        isConfigured: true, transport: shared ? 'shared' : 'separate' }),
} };
require.cache[modelId] = { id: modelId, filename: modelId, loaded: true, exports: {
    findOne(query) {
        queries.push(query);
        return { sort() { return this; }, select(fields) { assert.equal(fields, 'createdAt'); return this; },
            maxTimeMS(ms) { assert.equal(ms, 5000); return this; }, lean: async () => answers.shift() };
    },
} };
const { emailSendingHealth, SENDING_RESTRICTED } = require('../src/modules/notifications/emailSendingHealth');
(async () => {
    const rejected = new Date('2026-11-09T10:00:00Z');
    answers = [null];
    assert.deepEqual(await emailSendingHealth('events'), { sendingBlocked: false });
    answers = [{ createdAt: rejected }, null];
    const blocked = await emailSendingHealth('membership');
    assert.equal(blocked.sendingBlocked, true);
    assert.match(blocked.error, /SMTP login alone does not confirm recovery/);
    assert.equal(blocked.lastRejectedAt, rejected);
    assert.deepEqual(queries.at(-1).createdAt, { $gt: rejected }, 'only a newer acceptance resolves a pause');
    assert.equal(queries.at(-1).status, 'sent');
    assert.deepEqual(queries.at(-1).mock, { $ne: true }, 'mock sends never clear a provider restriction');
    assert.deepEqual(queries.at(-1).deliveryStatus, { $in: ['accepted', 'delivered', 'read'] });
    assert.deepEqual(queries.at(-1).$and[0].$or[0], { 'data.emailCategory': 'membership' }, 'custom diagnostic tests use their explicit sender');
    assert.ok(queries.at(-1).$and[0].$or[1].event.$not.test('EVENT_BOOKING_CONFIRMED'), 'membership fallback excludes event mail');
    answers = [{ createdAt: rejected }, { createdAt: new Date(rejected.getTime() + 1) }];
    assert.deepEqual(await emailSendingHealth('events'), { sendingBlocked: false });
    for (const message of ['554 Sending paused for this account', 'Sending is disabled', 'Account is suspended']) {
        assert.ok(SENDING_RESTRICTED.test(message));
    }
    assert.ok(!SENDING_RESTRICTED.test('550 mailbox unavailable'));
    shared = true;
    answers = [{ createdAt: rejected }, { createdAt: new Date(rejected.getTime() + 1) }];
    assert.equal((await emailSendingHealth('membership')).sendingBlocked, false);
    const fingerprint = queries.at(-1).$and[0].$or[1]['data.smtpAccountFingerprint'];
    assert.match(fingerprint, /^[a-f0-9]{64}$/, 'shared recovery requires exact credential-scoped evidence');
    assert.ok(!fingerprint.includes('password-fixture'));
    rotated = true;
    answers = [{ createdAt: rejected }, null];
    assert.equal((await emailSendingHealth('membership')).sendingBlocked, true);
    assert.equal(queries.at(-1).$and[0].$or[0]['data.emailCategory'], 'membership', 'different current credentials cannot clear another sender');
    console.log('PASS: provider sending restrictions survive successful login and clear only after newer real acceptance; categories and private diagnostics remain isolated.');
})().catch(error => { console.error(error); process.exitCode = 1; });
