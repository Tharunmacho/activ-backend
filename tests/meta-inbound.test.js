// No live database, provider credentials or actual WhatsApp recipients.
const assert = require('assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const axios = require('axios');
const config = require('../src/config');
const dataLayout = require('../src/config/dataLayout');
const bot = require('../src/modules/notifications/botbeeWebhook.service');
const inbound = require('../src/modules/notifications/metaInbound.service');
const notification = require('../src/modules/notifications/notification.service');
const delivery = require('../src/modules/notifications/deliveryStatus.service');
const Member = require('../src/modules/members/memberdetails.model');
const Application = require('../src/modules/applications/application.model');

const sent = [];
const logs = [];
const rows = new Map();
const collection = {
    createIndex: async () => 'expiresAt',
    insertOne: async row => {
        if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        rows.set(row._id, row);
    },
    updateOne: async (filter, change) => Object.assign(rows.get(filter._id), change.$set)
};
dataLayout.collection = key => { assert.equal(key, 'whatsappInbound'); return collection; };
Member.find = () => ({ lean: async () => [] });
Application.find = () => ({ sort: () => ({ lean: async () => [] }) });
notification.log = async row => { logs.push(row); };
let statuses = 0;
delivery.applyFromWebhook = async () => { statuses++; };
config.metaCloud = { ...config.metaCloud, isConfigured: true, accessToken: 'test-token',
    phoneNumberId: 'our-number-id', appSecret: 'test-secret', webhookVerifyToken: 'test-verify' };
axios.post = async (url, body) => {
    assert.match(url, /\/our-number-id\/messages$/);
    assert.equal(body.type, 'text');
    assert.equal(body.text.preview_url, false);
    sent.push(body);
    return { status: 200, data: { messages: [{ id: `out-${sent.length}` }] } };
};
const timestamp = () => String(Math.floor(Date.now() / 1000));
const message = (id, text = 'membership') => ({ id, from: '919999999999', type: 'text', timestamp: timestamp(), text: { body: text } });
const envelope = messages => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: 'our-number-id' }, messages } }] }] });
const signed = body => crypto.createHmac('sha256', config.metaCloud.appSecret).update(body).digest('hex');
const app = express();
app.use(express.json({ verify: (req, res, raw) => { req.rawBody = raw; } }));
app.use(require('../src/modules/notifications/metaWebhook.routes'));
const post = body => {
    const raw = JSON.stringify(body);
    return request(app).post('/webhook').set('Content-Type', 'application/json')
        .set('x-hub-signature-256', `sha256=${signed(raw)}`).send(raw);
};

async function main() {
    assert.equal((await request(app).get('/webhook').query({ 'hub.mode': 'subscribe',
        'hub.verify_token': 'test-verify', 'hub.challenge': '123' })).text, '123');
    assert.equal((await request(app).post('/webhook').send(envelope([message('forged')]))).status, 401);
    assert.equal(sent.length, 0);
    const payload = envelope([message('first'), message('second', 'hello')]);
    const [a, b] = await Promise.all([post(payload), post(payload)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.headers['x-activ-bot-version'], 'conversational-v3');
    assert.equal(sent.length, 2, 'concurrent duplicate deliveries send one reply per actual message');
    assert.match(sent[0].text.body, /\/register/);
    assert.match(sent[1].text.body, /Welcome to ACTIV/);
    assert.doesNotMatch(sent[1].text.body, /did not recognise|Wrong format|10,000/);
    assert.equal(sent[0].context.message_id, 'first');
    assert.equal(logs[0].provider, 'meta');
    assert.equal(logs[0].data.inboundMessageId, 'first');
    assert.equal(rows.size, 2);
    assert.ok([...rows.values()].every(row => row.status === 'replied'));
    const old = message('old'); old.timestamp = String(Math.floor(Date.now()/1000) - 86401);
    const wrong = envelope([message('other-number')]); wrong.entry[0].changes[0].value.metadata.phone_number_id = 'different';
    assert.equal(inbound.messagesFrom(wrong).length, 0);
    assert.equal(inbound.messagesFrom(envelope([old])).length, 0);
    const button = { ...message('button'), type: 'interactive', text: undefined,
        interactive: { button_reply: { id: 'legacy-flow-id', title: 'My Membership Status' } } };
    assert.equal((await post(envelope([button]))).status, 200);
    assert.equal(sent.length, 3);
    assert.match(sent[2].text.body, /\/register/);
    await post({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
        value: { metadata: { phone_number_id: 'our-number-id' }, statuses: [{ id: 'out-1', status: 'delivered' }] } }] }] });
    assert.equal(sent.length, 3, 'delivery status callbacks never send a bot reply');
    assert.ok(statuses >= 4);
    const secret = config.metaCloud.appSecret; config.metaCloud.appSecret = '';
    assert.equal((await request(app).post('/webhook').send(envelope([message('unsigned')]))).status, 503);
    assert.equal(sent.length, 3); config.metaCloud.appSecret = secret;
    const multi = envelope([message('entry-1')]);
    multi.entry.push(envelope([message('entry-2')]).entry[0]);
    assert.equal(inbound.messagesFrom(multi).length, 2);
    const many = ('📅 Event detail '.repeat(900));
    const chunks = bot.replyChunks(many);
    assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.length <= 4096));
    assert.equal(chunks.join(' '), many.trim());
    for (const text of ['event registration','event payment','my booking status','tickets']) assert.equal(bot.parseCommand(text), 'EVENTS');
    const incomplete = await bot.composeReply({ from: '919999999999', text: 'membership' }, { member: { fullName: 'Test' }, application: null });
    assert.match(incomplete.reply, /not been submitted/);
    const pending = await bot.composeReply({ from: '919999999999', text: 'pay membership' }, { member: { fullName: 'Test' }, application: { status: 'Pending' } });
    assert.match(pending.reply, /No payment is due yet/);
    const duplicate = await bot.composeReply({ from: '919999999999', text: 'membership' }, { ambiguous: true });
    assert.match(duplicate.reply, /member@activ.org.in/);
    const beforeChat = sent.length;
    const normal = envelope([message('normal-human-chat', 'Ok sir I will complete all the things by today tomorrow if u are free means will guide u sir will place the app in play store so once u check and say sir')]);
    assert.equal((await post(normal)).status, 200);
    assert.equal(sent.length, beforeChat, 'ordinary human conversation must not send an automated reply');
    assert.equal(rows.get('our-number-id:normal-human-chat').status, 'ignored');
    assert.equal((await post(normal)).status, 200);
    assert.equal(sent.length, beforeChat, 'ignored chats also stay quiet on webhook retries');
    console.log('Signed inbound routing, batched messages, duplicate protection, session window, old buttons and account journeys passed.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
