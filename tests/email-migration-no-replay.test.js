// In-memory delivery records and stub senders only. No credentials, DB or network.
const assert = require('node:assert/strict');
require('dotenv').config = () => ({ parsed: {} });
Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'false', PUSH_ENABLED: 'false', EMAIL_CONFIG_FILE: '',
    EMAIL_HOST: 'old-relay.example.test', EMAIL_USER: 'old@example.test', EMAIL_PASS: 'old-fixture-only',
    MEMBER_EMAIL_TRANSPORT: 'shared' });
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const loggerPath = require.resolve('../src/config/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info() {}, warn() {}, error() {}, debug() {} } };
const Log = require('../src/modules/notifications/notificationLog.model');
const service = require('../src/modules/notifications/notification.service');
const guard = require('../src/modules/notifications/deliveryGuard');
const config = require('../src/config');
const outbox = require('../src/modules/notifications/lifecycleOutbox');
let current, sends = 0, groups = 0;
let providerOutcome = { success: true, messageId: 'fixture-accepted', smtpRecipientStatus: 'accepted' };
const makeRow = (extra = {}) => ({ _id: new mongoose.Types.ObjectId(), event: 'CUSTOM', channel: 'email',
    recipient: 'recipient@example.test', subject: 'Original fixture notice', provider: 'smtp',
    status: 'failed', deliveryStatus: 'failed', lastError: '535 authentication refused',
    createdAt: new Date(), attempts: 1, data: { emailHtml: '<p>Original fixture notice</p>' },
    save: async () => {}, markModified() {}, ...extra });
Log.findById = async id => String(id) === String(current?._id) ? current : null;
Log.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [current] });
Log.updateOne = async (filter, update) => {
    assert.equal(String(filter._id), String(current._id));
    // The only non-retryClaim write is the guard's atomic retry-budget claim.
    const expected = filter.$or ? 0 : filter['autoRetry.count'];
    assert.notEqual(expected, undefined);
    if (Number(current.autoRetry?.count || 0) !== expected) return { matchedCount: 0 };
    current.autoRetry = { count: expected + update.$inc['autoRetry.count'], lastAt: update.$set['autoRetry.lastAt'] };
    return { matchedCount: 1 };
};
require('./fixtures/retryClaimStore')(Log, () => current);
require('../src/modules/notifications/email.service').sendEmail = async payload => {
    assert.equal(payload.to, 'recipient@example.test');
    sends++;
    await new Promise(resolve => setImmediate(resolve));
    return providerOutcome;
};
require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async () => {
    throw Error('An uncertain historical WhatsApp send must not reach its provider.');
};
const rotate = () => {
    config.email.host = 'new-relay.example.test'; config.email.user = 'new@example.test';
    config.email.pass = 'new-fixture-only'; config.email.port = 465; config.email.secure = true;
    Object.assign(process.env, { MEMBER_EMAIL_TRANSPORT: 'separate', MEMBER_EMAIL_HOST: 'new-relay.example.test',
        MEMBER_EMAIL_USER: 'member@example.test', MEMBER_EMAIL_PASS: 'new-member-fixture-only' });
};
const check = async (name, body) => { await body(); groups++; console.log(`PASS ${name}`); };

(async () => {
    await check('SMTP rotation cannot change an existing lifecycle intent identity', async () => {
        const recipient = { id: 'fixture-member', email: 'recipient@example.test' };
        const payload = { data: { orderId: 'fixture-order' } };
        const before = outbox.keyFor('PAYMENT_SUCCESS', recipient, payload);
        rotate();
        assert.equal(outbox.keyFor('PAYMENT_SUCCESS', recipient, payload), before);
    });

    await check('unflagged historical timeouts and broken connections block both direct retry modes', async () => {
        for (const channel of ['email', 'whatsapp']) {
            for (const error of ['SMTP timeout waiting for server reply', 'ETIMEDOUT', 'write EPIPE', 'ECONNRESET', 'ESOCKET',
                'socket hang up', 'connection closed', 'Delivery outcome is unconfirmed']) {
                for (const field of ['lastError', 'failureReason']) {
                    current = makeRow({ channel, lastError: '', [field]: error, data: {} });
                    const before = sends;
                    assert.equal((await service.retryLog(current._id)).skipped, true, `${channel} default ${error}`);
                    assert.equal((await service.retryLog(current._id, { strict: true })).skipped, true, `${channel} strict ${error}`);
                    assert.equal(sends, before);
                    assert.equal(current.attempts, 1, 'a blocked retry is not a provider attempt');
                }
            }
        }
    });

    await check('automatic and bulk recovery never replay legacy uncertain email after rotation', async () => {
        for (const auto of [true, false]) {
            for (const lastError of ['SMTP timeout waiting for server reply', 'ETIMEDOUT', 'write EPIPE']) {
                current = makeRow({ lastError, data: {} });
                rotate();
                const before = sends;
                const result = await guard.retryFailed({ auto });
                assert.equal(result.skipped, 1); assert.equal(result.retried, 0);
                assert.equal(sends, before);
            }
        }
    });

    await check('known acceptance and explicit uncertain SMTP evidence always block replay', async () => {
        for (const extra of [
            { status: 'sent', deliveryStatus: 'accepted' },
            { status: 'sent', deliveryStatus: undefined },
            { status: 'failed', deliveryStatus: 'accepted' },
            { status: 'sent', deliveryStatus: 'failed' },
            { deliveryStatus: 'sent' },
            { deliveryStatus: 'delivered' }, { deliveryStatus: 'read' },
            { data: { smtpRecipientStatus: 'accepted' } }, { data: { smtpRecipientStatus: 'partial' } },
            { data: { smtpRecipientStatus: 'unknown' } }, { data: { outcomeUnknown: true } },
        ]) {
            current = makeRow(extra);
            const before = sends;
            assert((await service.retryLog(current._id)).skipped);
            assert.equal((await guard.retryFailed({ auto: true })).retried, 0);
            assert.equal(sends, before);
        }
    });

    await check('definite authentication and temporary SMTP refusals remain retryable once', async () => {
        for (const automatic of [false, true]) {
            for (const lastError of ['535 authentication refused', '450 Service temporarily unavailable']) {
                current = makeRow({ lastError, data: { emailHtml: '<p>Original fixture notice</p>', smtpRecipientStatus: 'rejected' } });
                const before = sends;
                const result = automatic ? await guard.retryFailed({ auto: true }) : await service.retryLog(current._id);
                assert(automatic ? result.sent === 1 : result.outcome.success);
                assert.equal(sends, before + 1);
                rotate();
                assert((await service.retryLog(current._id)).skipped);
                assert.equal(sends, before + 1, 'provider migration never replays the accepted retry');
            }
        }
    });

    await check('concurrent retries share one durable claim after credentials recover', async () => {
        current = makeRow();
        const before = sends;
        const results = await Promise.all([service.retryLog(current._id), service.retryLog(current._id)]);
        assert.equal(results.filter(result => result.outcome?.success).length, 1);
        assert.equal(sends, before + 1);
    });

    await check('acceptance discovered after the atomic claim blocks SMTP and releases the unused claim', async () => {
        current = makeRow();
        const originalFindById = Log.findById;
        let reads = 0;
        Log.findById = async id => {
            if (++reads === 2) current.status = 'sent';
            return originalFindById(id);
        };
        const before = sends;
        try {
            assert((await service.retryLog(current._id)).skipped);
            assert.equal(sends, before);
            assert(!current.retryClaim?.token);
        } finally { Log.findById = originalFindById; }
    });

    await check('uncertain result on a permitted retry stays held across later rotation', async () => {
        current = makeRow();
        providerOutcome = { success: false, outcomeUnknown: true, smtpRecipientStatus: 'unknown', error: 'SMTP timeout' };
        const before = sends;
        assert.equal((await service.retryLog(current._id)).outcome.outcomeUnknown, true);
        assert(current.retryClaim?.token);
        rotate();
        assert((await service.retryLog(current._id)).skipped);
        assert.equal((await guard.retryFailed({ auto: true })).retried, 0);
        assert.equal(sends, before + 1);
    });
    console.log(`${groups} migration/no-replay groups passed; all sends were isolated fixtures.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
