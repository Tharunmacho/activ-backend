// Authenticated HTTP endpoints and real provider selection; no real credentials,
// database connections or provider sends are loaded by this fixture.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '../src', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
const config = {
    jwt: { secret: 'offline-admin-delivery-jwt' },
    email: { host: 'smtp.example.test', user: 'member@example.test', password: 'fixture-smtp-secret', port: 587, secure: false, isConfigured: true, defaultFrom: 'ACTIV <member@example.test>', useRegionalFrom: false, supportAddress: 'member@activ.org.in' },
    metaCloud: {
        isConfigured: true, baseUrl: 'https://graph.example.test', apiVersion: 'v99.0', phoneNumberId: 'fixture-phone-id',
        accessToken: 'fixture-meta-access-secret', appSecret: 'fixture-meta-app-secret', webhookVerifyToken: 'fixture-meta-verify-secret'
    },
    botbee: {
        isConfigured: false, baseUrl: 'https://botbee.example.test', sendTemplatePath: '/send/template', sendTextPath: '/send/text',
        authStyle: 'x-api-key', webhookVerifyToken: 'fixture-botbee-verify-secret', apiToken: 'fixture-botbee-access-secret',
        templates: { status: 'configured_approved_membership_status' }
    }
};
Object.assign(process.env, { EMAIL_CONFIG_FILE: '', EMAIL_HOST: config.email.host, EMAIL_PORT: '587',
    EMAIL_SECURE: 'false', EMAIL_USER: config.email.user, EMAIL_PASS: config.email.password });
stub('config', config);
stub('config/logger', { info() {}, warn() {}, error() {} });
stub('config/publicUrl', {
    publicApiBase: () => 'https://activ.example.test/api/v1',
    instamojoWebhookUrl: () => 'https://activ.example.test/api/v1/payment/webhook'
});
stub('modules/members/memberdetails.model', { findById: () => ({ select: () => ({ lean: async () => ({ isActive: true }) }) }) });
stub('modules/notifications/regionalContacts.service', {});
const logs = [], sends = [], emails = [];
const verificationCalls = [];
let membershipVerificationOk = true;
stub('modules/notifications/notification.service', { log: async row => { logs.push(row); return row; } });
stub('modules/notifications/email.service', {
    isConfigured: () => true,
    verifyConnection: async category => { verificationCalls.push(category); return { ok: category !== 'membership' || membershipVerificationOk, configured: true }; },
    buildHtmlTemplate: payload => JSON.stringify(payload),
    sendEmail: async payload => { emails.push(payload); return { success: true, messageId: 'fixture-email-id' }; }
});
let providerFailure = false;
for (const [name, file] of [['meta', 'metaCloud.service'], ['botbee', 'botbee.service']]) {
    stub(`modules/notifications/${file}`, {
        isConfigured: () => config[name === 'meta' ? 'metaCloud' : 'botbee'].isConfigured,
        sendTextMessage: async () => { throw new Error('Admin tests must use an approved template, not session text'); },
        sendTemplateMessage: async (phone, template, params, language, fallback) => {
            sends.push({ provider: name, phone, template, params, language, fallback });
            if (providerFailure) return { success: false, to: phone, error: 'Fixture provider rejected template' };
            const mock = !config[name === 'meta' ? 'metaCloud' : 'botbee'].isConfigured;
            return { success: true, to: phone, template, messageId: `fixture-${name}-${sends.length}`, ...(mock ? { mock: true } : {}) };
        }
    });
}
const previousOwnNumber = process.env.WHATSAPP_OWN_NUMBER;
const mailboxEnvKeys = ['EVENT_EMAIL', 'MEMBER_EMAIL'].flatMap(prefix =>
    ['TRANSPORT', 'HOST', 'PORT', 'SECURE', 'USER', 'PASS'].map(field => `${prefix}_${field}`));
const previousMailboxEnv = Object.fromEntries(mailboxEnvKeys.map(key => [key, process.env[key]]));
for (const key of mailboxEnvKeys) delete process.env[key];
process.env.WHATSAPP_OWN_NUMBER = '919999999999';
const previousFetch = global.fetch;
let unexpectedNetwork = 0;
global.fetch = async () => { unexpectedNetwork++; throw new Error('Unexpected network request in an offline endpoint fixture'); };
const app = express();
app.use(express.json());
app.use('/notifications', require('../src/modules/notifications/notification.routes'));
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
const token = role => 'Bearer ' + jwt.sign({ role, userId: '507f1f77bcf86cd799439011' }, config.jwt.secret);
const getStatus = query => request(app).get('/notifications/delivery-status' + (query || '')).set('Authorization', token('super_admin'));
const testSend = body => request(app).post('/notifications/test-send').set('Authorization', token('super_admin')).send(body);
const recipient = '919000000001';

(async () => {
    // The actual JWT and role middleware stays in the request path.
    assert.equal((await request(app).get('/notifications/delivery-status')).status, 401);
    assert.equal((await request(app).post('/notifications/test-send').send({ channel: 'whatsapp', to: recipient })).status, 401);
    for (const role of ['member', 'events_admin', 'state_admin']) {
        assert.equal((await request(app).get('/notifications/delivery-status').set('Authorization', token(role))).status, 403);
        assert.equal((await request(app).post('/notifications/test-send').set('Authorization', token(role)).send({ channel: 'whatsapp', to: recipient })).status, 403);
    }
    assert.equal(sends.length, 0);
    assert.equal(logs.length, 0);

    let response = await getStatus('?verifyEmail=1');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.email.verification.ok, true);
    assert.deepEqual(verificationCalls, ['events', 'membership']);
    assert.deepEqual(response.body.data.email.accounts.map(({ category, from, host, configured, transport }) => ({ category, from, host, configured, transport })), [
        { category: 'events', from: 'events@activ.org.in', host: config.email.host, configured: true, transport: 'shared' },
        { category: 'membership', from: 'member@activ.org.in', host: config.email.host, configured: true, transport: 'shared' },
    ]);
    assert(!JSON.stringify(response.body).includes(config.email.password));
    process.env.EVENT_EMAIL_TRANSPORT = 'separate';
    process.env.EVENT_EMAIL_HOST = 'events-smtp.example.test';
    process.env.EVENT_EMAIL_USER = 'events-login@example.test';
    process.env.EVENT_EMAIL_PASS = 'fixture-events-smtp-secret';
    const eventStatus = (await getStatus()).body.data.email;
    assert.equal(eventStatus.accounts[0].transport, 'separate');
    assert.equal(eventStatus.accounts[0].host, 'events-smtp.example.test');
    assert.equal(eventStatus.host, 'events-smtp.example.test', 'Legacy fields must not show the unused shared relay');
    assert.equal(eventStatus.user, 'events-login@example.test');
    assert.equal(eventStatus.from, 'events@activ.org.in');
    assert(!JSON.stringify(eventStatus).includes(process.env.EVENT_EMAIL_PASS));
    delete process.env.EVENT_EMAIL_PASS;
    assert.equal((await getStatus()).body.data.email.configured, false);
    for (const key of mailboxEnvKeys.filter(key => key.startsWith('EVENT_EMAIL_'))) delete process.env[key];
    process.env.MEMBER_EMAIL_TRANSPORT = 'separate';
    process.env.MEMBER_EMAIL_HOST = 'membership-smtp.example.test';
    process.env.MEMBER_EMAIL_USER = 'separate-login@example.test';
    process.env.MEMBER_EMAIL_PASS = 'fixture-separate-smtp-secret';
    membershipVerificationOk = false;
    const separateStatus = (await getStatus('?verifyEmail=1')).body.data.email;
    assert.equal(separateStatus.accounts[1].host, 'membership-smtp.example.test');
    assert.equal(separateStatus.accounts[1].transport, 'separate');
    assert.equal(separateStatus.accounts[0].verification.ok, true);
    assert.equal(separateStatus.accounts[1].verification.ok, false);
    assert.equal(separateStatus.verification.ok, false, 'Successful events login must not hide a failed membership login');
    assert(!JSON.stringify(separateStatus).includes(process.env.MEMBER_EMAIL_PASS));
    delete process.env.MEMBER_EMAIL_PASS;
    const incompleteStatus = (await getStatus()).body.data.email;
    assert.equal(incompleteStatus.configured, false, 'Both senders must be configured for the aggregate ready badge');
    assert.equal(incompleteStatus.accounts[0].configured, true);
    assert.equal(incompleteStatus.accounts[1].configured, false);
    for (const key of mailboxEnvKeys) delete process.env[key];
    membershipVerificationOk = true;
    let wa = response.body.data.whatsapp;
    assert.equal(wa.configured, true, 'Meta alone is a configured WhatsApp provider');
    assert.equal(wa.provider, 'meta');
    assert.equal(wa.providerLabel, 'Meta WhatsApp Cloud API');
    assert.equal(wa.baseUrl, config.metaCloud.baseUrl);
    assert.equal(wa.templateEndpoint, '/v99.0/fixture-phone-id/messages');
    assert.equal(wa.textEndpoint, wa.templateEndpoint);
    assert.equal(wa.authStyle, 'bearer');
    assert.equal(wa.webhookUrl, 'https://activ.example.test/api/v1/notifications/meta/webhook');
    assert.equal(wa.webhookConfigured, true);
    assert.equal(wa.metaStatusWebhookUrl, wa.webhookUrl);
    assert.equal(wa.metaStatusWebhookConfigured, true);
    assert.equal(wa.metaSignatureConfigured, true);
    assert.equal(wa.botbeeWebhookUrl, 'https://activ.example.test/api/v1/notifications/botbee/webhook');
    assert.equal(wa.instamojoWebhookUrl, 'https://activ.example.test/api/v1/payment/webhook');
    for (const secret of [config.metaCloud.accessToken, config.metaCloud.appSecret, config.metaCloud.webhookVerifyToken, config.botbee.apiToken, config.botbee.webhookVerifyToken]) {
        assert(!JSON.stringify(response.body).includes(secret), 'Readiness response must not expose credential values');
    }
    config.metaCloud.appSecret = '';
    wa = (await getStatus()).body.data.whatsapp;
    assert.equal(wa.webhookConfigured, false, 'Meta inbound requires a signature secret as well as verification token');
    assert.equal(wa.metaStatusWebhookConfigured, true, 'Legacy verification-token flag is retained');
    config.metaCloud.appSecret = 'fixture-meta-app-secret';
    config.botbee.isConfigured = true;
    assert.equal((await getStatus()).body.data.whatsapp.provider, 'meta', 'Meta takes precedence when both providers exist');

    response = await testSend({ channel: 'whatsapp', to: recipient });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.success, true);
    assert.equal(response.body.data.provider, 'meta');
    let sent = sends.at(-1), log = logs.at(-1);
    assert.equal(sent.provider, 'meta');
    assert.equal(sent.template, config.botbee.templates.status);
    assert.equal(sent.params.length, 3);
    assert(sent.params.join(' ').includes('ACTIV TEST'));
    assert(sent.params.join(' ').includes('no account change'));
    assert(sent.params.join(' ').includes('member@activ.org.in'));
    assert(sent.params.join(' ').includes('events@activ.org.in'));
    assert(!sent.fallback, 'No session text is needed outside the 24-hour window');
    assert.equal(log.provider, 'meta');
    assert.equal(log.templateId, sent.template);
    assert.equal(log.deliveryStatus, 'accepted', 'API acceptance is not handset delivery');
    assert.equal(log.data.test, true);
    assert.deepEqual(log.data.params, sent.params, 'Retries retain the test parameters');
    assert.equal(log.providerMessageId, response.body.data.messageId);

    providerFailure = true;
    const beforeFailure = sends.length;
    response = await testSend({ channel: 'whatsapp', to: recipient });
    assert.equal(response.body.data.success, false);
    assert.equal(response.body.data.provider, 'meta');
    assert.equal(sends.length, beforeFailure + 1, 'Failed Meta test must not silently switch to BotBee');
    assert.equal(logs.at(-1).status, 'failed');
    assert.equal(logs.at(-1).deliveryStatus, 'failed');
    assert.equal(logs.at(-1).lastError, 'Fixture provider rejected template');
    providerFailure = false;

    config.metaCloud.isConfigured = false;
    wa = (await getStatus()).body.data.whatsapp;
    assert.equal(wa.provider, 'botbee');
    assert.equal(wa.providerLabel, 'BotBee');
    assert.equal(wa.configured, true);
    assert.equal(wa.baseUrl, config.botbee.baseUrl);
    assert.equal(wa.templateEndpoint, config.botbee.sendTemplatePath);
    assert.equal(wa.textEndpoint, config.botbee.sendTextPath);
    assert.equal(wa.authStyle, config.botbee.authStyle);
    assert.equal(wa.webhookUrl, wa.botbeeWebhookUrl);
    assert.equal(wa.webhookConfigured, true);
    response = await testSend({ channel: 'whatsapp', to: recipient });
    assert.equal(response.body.data.provider, 'botbee');
    assert.equal(sends.at(-1).template, config.botbee.templates.status, 'Legacy BotBee also uses templates for tests');

    config.botbee.isConfigured = false;
    assert.equal((await getStatus()).body.data.whatsapp.configured, false);
    response = await testSend({ channel: 'whatsapp', to: recipient });
    assert.equal(response.body.data.mock, true);
    assert(response.body.message.includes('nothing was sent'));
    assert.equal(logs.at(-1).deliveryStatus, undefined);

    const beforeInvalid = sends.length;
    for (const template of ['', 'none']) {
        config.botbee.templates.status = template;
        assert.equal((await testSend({ channel: 'whatsapp', to: recipient })).status, 400);
    }
    assert.equal((await testSend({ channel: 'whatsapp', to: '' })).status, 400);
    assert.equal((await testSend({ channel: 'push', to: recipient })).status, 400);
    assert.equal(sends.length, beforeInvalid);
    response = await testSend({ channel: 'email', to: 'admin@example.test' });
    assert.equal(response.status, 200);
    assert.equal(emails.length, 1);
    assert.equal(logs.at(-1).channel, 'email');
    assert.equal(unexpectedNetwork, 0);
    console.log('Admin notification endpoints passed: real auth/roles, Meta priority and readiness, legacy fields, template-only tests, contacts, callback/retry log data, failures, BotBee fallback selection, mocks and no credential disclosure.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    global.fetch = previousFetch;
    for (const key of mailboxEnvKeys) {
        if (previousMailboxEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousMailboxEnv[key];
    }
    if (previousOwnNumber === undefined) delete process.env.WHATSAPP_OWN_NUMBER;
    else process.env.WHATSAPP_OWN_NUMBER = previousOwnNumber;
});
