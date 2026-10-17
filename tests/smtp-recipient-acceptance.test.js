// SMTP, audit persistence and queue calls are stubbed. No server or provider is contacted.
const assert = require('node:assert/strict');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false', NOTIFICATION_WORKER_ENABLED: 'false',
    EMAIL_HOST: 'smtp.example.test', EMAIL_USER: 'relay@example.test', EMAIL_PASS: 'fixture-only',
    MEMBER_EMAIL_TRANSPORT: 'shared', EMAIL_ARCHIVE_COPY: 'archive@example.test' });
const loggerPath = require.resolve('../src/config/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info() {}, warn() {}, error() {}, debug() {} } };
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const nodemailer = require('nodemailer');
let smtpInfo;
let smtpError;
const sent = [];
nodemailer.createTransport = () => ({ sendMail: async message => {
    sent.push(message);
    if (smtpError) throw smtpError;
    return smtpInfo;
} });
const config = require('../src/config');
const email = require('../src/modules/notifications/email.service');
const mailer = require('../src/core/utils/mailer');
const service = require('../src/modules/notifications/notification.service');
const Log = require('../src/modules/notifications/notificationLog.model');
const guard = require('../src/modules/notifications/deliveryGuard');
const outbox = require('../src/modules/notifications/lifecycleOutbox');
const association = require('../src/modules/notifications/associationUpdateDelivery');
const { smtpRecipientResult } = require('../src/core/utils/smtpRecipientResult');
const recorded = [];
const originals = { create: Log.create, findById: Log.findById };
Log.create = async entry => { const row = { ...entry, _id: new mongoose.Types.ObjectId() }; recorded.push(row); return row; };
const target = 'member@example.test';
const archive = 'archive@example.test';
const accepted = { messageId: 'fixture-accepted', accepted: [target], rejected: [archive] };
const rejected = { messageId: 'fixture-archive-only', accepted: [archive], rejected: [target],
    rejectedErrors: [{ recipient: target, responseCode: 550, response: '550 No such mailbox' }] };
const noMetadata = { messageId: 'fixture-unconfirmed' };
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }

(async () => {
    await check('SMTP acceptance is for the intended address, preserving display names, casing, IDN domains and lists', async () => {
        assert.equal(smtpRecipientResult('Member Name <MEMBER@Example.Test>', accepted).success, true);
        assert.equal(smtpRecipientResult(target, rejected).success, false);
        assert.equal(smtpRecipientResult(target, { ...accepted, accepted: [{ address: 'MEMBER@example.test' }] }).success, true);
        assert.equal(smtpRecipientResult('Member <member@bücher.example>', { accepted: ['member@xn--bcher-kva.example'] }).success, true);
        assert.equal(smtpRecipientResult(`${target}; Other <other@example.test>`, { accepted: [target, 'OTHER@example.test'], rejected: [archive] }).success, true);
        assert.equal(smtpRecipientResult(`${target}, MEMBER@example.test`, accepted).success, true);
        assert.equal(smtpRecipientResult(target, { accepted: [target], rejected: [target] }).smtpRecipientStatus, 'unknown');
        for (const info of [undefined, null, {}, noMetadata, { accepted: [archive], rejected: [] }, { accepted: target }]) {
            const outcome = smtpRecipientResult(target, info);
            assert.equal(outcome.success, false); assert.equal(outcome.smtpRecipientStatus, 'unknown');
            assert.equal(outcome.outcomeUnknown, true); assert.equal(outcome.autoRetryDisabled, true);
        }
    });

    await check('both senders reject archive-only acceptance and retain existing SMTP addresses, copies and message IDs', async () => {
        smtpInfo = rejected;
        const lifecycle = await email.sendEmail({ to: target, subject: 'Fixture', html: '<p>Hello</p>' });
        const utility = await mailer.send({ to: target, subject: 'Fixture', html: '<p>Hello</p>', log: { event: 'DONATION_RECEIPT' } });
        assert.equal(lifecycle.success, false); assert.equal(utility.sent, false);
        assert.equal(lifecycle.smtpRecipientStatus, 'rejected'); assert.equal(utility.smtpRecipientStatus, 'rejected');
        assert.equal(lifecycle.messageId, rejected.messageId);
        assert.match(lifecycle.error, /550 No such mailbox/);
        assert.equal(recorded.at(-1).status, 'failed'); assert.equal(recorded.at(-1).deliveryStatus, 'failed');
        assert.equal(recorded.at(-1).providerMessageId, rejected.messageId);
        assert.equal(recorded.at(-1).data.outcomeUnknown, undefined);
        for (const message of sent.slice(-2)) {
            assert.equal(message.to, target); assert.equal(message.bcc, archive);
            assert.equal(message.cc, undefined); assert.equal(message.html, '<p>Hello</p>');
        }
    });

    await check('both senders succeed when the recipient is accepted and archive copy is rejected', async () => {
        smtpInfo = accepted; config.email.archiveMode = 'cc';
        assert.equal((await email.sendEmail({ to: target, subject: 'Fixture', text: 'Hello' })).success, true);
        assert.equal((await mailer.send({ to: target, subject: 'Fixture', text: 'Hello', log: { event: 'DONATION_RECEIPT' } })).sent, true);
        assert.equal(recorded.at(-1).deliveryStatus, 'accepted');
        for (const message of sent.slice(-2)) { assert.equal(message.cc, archive); assert.equal(message.bcc, undefined); }
        config.email.archiveMode = 'bcc';
    });

    await check('private authentication codes are sent only to their intended recipient and never copied or logged', async () => {
        smtpInfo = accepted;
        const result = await mailer.send({ to: target, subject: 'Sign-in verification', text: 'Private code 123456', privateRecipientOnly: true,
            log: { event: 'SOCIAL_EMAIL_VERIFICATION', data: { provider: 'facebook' } } });
        assert.equal(result.sent, true);
        assert.equal(sent.at(-1).to, target); assert.equal(sent.at(-1).cc, undefined); assert.equal(sent.at(-1).bcc, undefined);
        assert(!JSON.stringify(recorded.at(-1)).includes('123456'));
    });

    await check('partial/missing metadata is reviewable and is never marked accepted or automatically replayed', async () => {
        for (const [to, info, status] of [[target, noMetadata, 'unknown'],
            [`${target}, other@example.test`, { accepted: [target], rejected: ['other@example.test'] }, 'partial']]) {
            smtpInfo = info;
            const direct = await email.sendEmail({ to, subject: 'Fixture', text: 'Hello' });
            assert.equal(direct.success, false); assert.equal(direct.smtpRecipientStatus, status);
            assert.equal(outbox.uncertain(direct), true);
            const utility = await mailer.send({ to, subject: 'Fixture', text: 'Hello', log: { event: 'DONATION_RECEIPT' } });
            assert.equal(utility.sent, false); assert.equal(utility.outcomeUnknown, true);
            assert.equal(recorded.at(-1).data.autoRetryDisabled, true);
            assert.equal(recorded.at(-1).data.smtpRecipientStatus, status);
            assert.equal(guard.isHealable(recorded.at(-1)), false);

            const lifecycle = await service._deliverLifecycleEvent('ACCOUNT_REGISTERED', { name: 'Fixture', email: to }, { onlyChannel: 'email' });
            assert.equal(lifecycle.channels.email.success, false);
            const log = recorded.at(-1);
            assert.equal(log.deliveryStatus, 'failed'); assert.equal(log.data.outcomeUnknown, true);
            assert.equal(log.data.autoRetryDisabled, true); assert.equal(log.data.smtpRecipientStatus, status);
            Log.findById = async () => log;
            const before = sent.length;
            assert.equal((await service.retryLog(String(log._id))).skipped, true);
            assert.equal((await association.retryLog({ ...log, event: 'ASSOCIATION_UPDATE' })).skipped, true);
            assert.equal(sent.length, before, 'review guards never send another email');
        }
    });

    await check('a generic retry persists uncertain SMTP evidence and blocks its next replay', async () => {
        const row = { _id: new mongoose.Types.ObjectId(), event: 'CUSTOM', channel: 'email', recipient: target,
            subject: 'Fixture', status: 'failed', deliveryStatus: 'failed', data: { emailHtml: '<p>Hello</p>' },
            save: async () => {}, markModified: () => {} };
        Log.findById = async () => row;
        smtpInfo = noMetadata;
        const outcome = await service.retryLog(String(row._id));
        assert.equal(outcome.outcome.success, false); assert.equal(row.data.outcomeUnknown, true);
        assert.equal(row.data.autoRetryDisabled, true); assert.equal(row.data.smtpRecipientStatus, 'unknown');
        const before = sent.length;
        assert.equal((await service.retryLog(String(row._id))).skipped, true);
        assert.equal(sent.length, before);
    });

    await check('confirmed temporary rejection retains retry eligibility; unknown metadata does not invent a failure code', async () => {
        const temporary = smtpRecipientResult(target, { accepted: [archive], rejected: [target],
            rejectedErrors: [{ recipient: target, responseCode: 450, response: '450 recipient rejected temporarily' }] });
        assert.equal(temporary.smtpRecipientStatus, 'rejected'); assert.equal(temporary.outcomeUnknown, undefined);
        assert.equal(guard.isHealable({ lastError: temporary.error }), true);
        assert.match(temporary.smtpResponse, /450 recipient rejected/);
        assert.equal(guard.isHealable({ lastError: smtpRecipientResult(target, rejected).error }), false);
    });

    await check('transport errors and explicit unconfigured/mock paths retain their previous contracts', async () => {
        smtpError = new Error('535 Invalid login');
        assert.match((await email.sendEmail({ to: target, subject: 'Fixture' })).error, /535/);
        assert.match((await mailer.send({ to: target, subject: 'Fixture' })).error, /535/);
        smtpError = null;
        const transport = email.getTransporter;
        email.getTransporter = () => null;
        const before = sent.length;
        const mock = await email.sendEmail({ to: target, subject: 'Fixture' });
        assert.equal(mock.success, true); assert.equal(mock.mock, true); assert.equal(mock.outcomeUnknown, undefined);
        assert.equal(sent.length, before);
        email.getTransporter = transport;
    });
    console.log(`${checks} focused SMTP checks passed; no database or external messages.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Log.create = originals.create; Log.findById = originals.findById;
    mongoose.disconnect().finally(() => process.exit(process.exitCode || 0));
});
