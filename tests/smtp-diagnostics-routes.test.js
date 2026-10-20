// Real HTTP routes and JWT/role gates. All providers and persistence are fixtures.
// No environment file, database, or external email service is used.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
require('dotenv').config = () => ({ parsed: {} });
const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '../src', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
const key = 'smtp-diagnostics-fixture-only';
const sends = [], logs = [], verified = [], rendered = [];
let outcome = { success: true, messageId: 'fixture-message', smtpRecipientStatus: 'accepted' };
stub('config', { jwt: { secret: key }, metaCloud: { apiVersion: 'fixture', phoneNumberId: 'fixture' }, botbee: {} });
stub('config/publicUrl', { publicApiBase: () => 'https://api.example.test', instamojoWebhookUrl: () => 'https://api.example.test/payment' });
stub('modules/notifications/notification.service', { log: async row => { logs.push(row); return row; } });
stub('modules/notifications/regionalContacts.service', {});
stub('modules/notifications/whatsappTemplate', { providerName: () => 'meta', isConfigured: () => false });
stub('modules/notifications/emailAccounts', {
    accountStatus: category => ({ category, configured: true, host: `${category}.example.test`, port: 465,
        secure: true, from: `${category}@example.test`, transport: 'separate' }),
    accountFor: category => ({ host: `${category}.example.test`, defaultFrom: `${category}@example.test`,
        user: 'private-smtp-login-fixture', password: 'private-smtp-password-fixture' }),
});
stub('modules/notifications/email.service', {
    verifyConnection: async category => { verified.push(category); return { ok: category === 'events', configured: true,
        ...(category === 'membership' ? { error: '535 fixture authentication rejected' } : {}) }; },
    buildHtmlTemplate: payload => { rendered.push(payload.category); return '<p>Fixture message</p>'; },
    sendEmail: async payload => { sends.push(payload); return { ...outcome, sender: `${payload.category}@example.test` }; },
});
const app = express();
app.use(express.json());
app.use('/notifications', require('../src/modules/notifications/notification.routes'));
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
const auth = role => `Bearer ${jwt.sign({ userId: 'fixture-admin', role }, key)}`;
const test = body => request(app).post('/notifications/test-send').set('Authorization', auth('super_admin')).send(body);

(async () => {
    await request(app).get('/notifications/delivery-status?verifyEmail=1').expect(401);
    await request(app).get('/notifications/delivery-status?verifyEmail=1').set('Authorization', auth('events_admin')).expect(403);
    await request(app).post('/notifications/test-send').send({ channel: 'email', to: 'admin@example.test' }).expect(401);
    await request(app).post('/notifications/test-send').set('Authorization', auth('events_admin'))
        .send({ channel: 'email', to: 'admin@example.test', category: 'events' }).expect(403);
    assert.equal(sends.length + verified.length, 0, 'unauthorized requests cannot contact a provider');

    await request(app).get('/notifications/delivery-status').set('Authorization', auth('super_admin')).expect(200);
    assert.equal(verified.length, 0, 'ordinary page load does not authenticate');
    const status = (await request(app).get('/notifications/delivery-status?verifyEmail=1')
        .set('Authorization', auth('super_admin')).expect(200)).body.data.email;
    assert.deepEqual(verified, ['events', 'membership']);
    assert.equal(status.verification.ok, false);
    assert.equal(status.accounts[0].verification.ok, true);
    assert.equal(status.accounts[1].verification.ok, false);
    assert.equal(status.user, null);
    assert(!JSON.stringify(status).includes('private-smtp-'), 'login names and passwords stay out of diagnostics');
    assert.equal(sends.length, 0, 'checking login sends no messages');
    assert.equal(logs.length, 0, 'checking login creates no delivery rows');

    for (const category of [undefined, 'membership', 'events']) {
        const expected = category || 'membership';
        const response = await test({ channel: 'email', to: 'admin@example.test', ...(category === undefined ? {} : { category }) }).expect(200);
        assert.equal(sends.at(-1).category, expected);
        assert.equal(rendered.at(-1), expected, 'template contacts match the selected sender');
        assert.equal(logs.at(-1).data.emailCategory, expected);
        assert.equal(logs.at(-1).provider, 'smtp');
        assert.equal(logs.at(-1).deliveryStatus, 'accepted');
        assert.equal(logs.at(-1).providerMessageId, 'fixture-message');
        assert.match(response.body.message, /accepted by SMTP/);
    }
    for (const category of ['', null, 'shared', 'event', ['events'], { value: 'events' }]) {
        await test({ channel: 'email', to: 'admin@example.test', category }).expect(400);
    }
    assert.equal(sends.length, 3, 'invalid sender categories never send');

    outcome = { success: true, mock: true, messageId: 'mock-fixture' };
    const mock = await test({ channel: 'email', to: 'admin@example.test', category: 'events' }).expect(200);
    assert.match(mock.body.message, /nothing was sent/);
    assert.equal(logs.at(-1).mock, true);
    assert.equal(logs.at(-1).deliveryStatus, undefined, 'unconfigured mail is never labelled SMTP accepted');

    outcome = { success: false, error: '535 fixture authentication rejected' };
    await test({ channel: 'email', to: 'admin@example.test', category: 'membership' }).expect(200);
    assert.equal(logs.at(-1).status, 'failed');
    assert.equal(logs.at(-1).deliveryStatus, 'failed');
    outcome = { success: false, error: 'Unconfirmed fixture outcome', smtpRecipientStatus: 'unknown', outcomeUnknown: true };
    await test({ channel: 'email', to: 'admin@example.test', category: 'events' }).expect(200);
    assert.equal(logs.at(-1).data.outcomeUnknown, true);
    assert.equal(logs.at(-1).data.autoRetryDisabled, true);
    console.log('PASS SMTP diagnostic routes: real authentication/role gates, handshake without sending, separate sender selection, compatible default, validation, accepted/failed/mock/uncertain audit results. No external provider or database calls.');
})().catch(error => { console.error(error); process.exitCode = 1; });
