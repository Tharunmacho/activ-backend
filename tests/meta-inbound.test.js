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
const NotificationLog = require('../src/modules/notifications/notificationLog.model');
const delivery = require('../src/modules/notifications/deliveryStatus.service');
const Member = require('../src/modules/members/memberdetails.model');
const Application = require('../src/modules/applications/application.model');

const sent = [];
const logs = [];
const rows = new Map();
const valueAt = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => !!row && Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(clause => matches(row, clause));
    if (key === '$and') return expected.every(clause => matches(row, clause));
    const value = valueAt(row, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        return Object.entries(expected).every(([op, operand]) => {
            if (op === '$exists') return (value !== undefined) === operand;
            if (op === '$ne') return value !== operand;
            if (op === '$lt') return value < operand;
            if (op === '$lte') return value <= operand;
            throw new Error(`Unsupported test filter ${op}`);
        });
    }
    return value === expected;
});
const apply = (row, change) => {
    Object.assign(row, change.$set || {});
    for (const [key, amount] of Object.entries(change.$inc || {})) row[key] = (row[key] || 0) + amount;
    for (const key of Object.keys(change.$unset || {})) delete row[key];
    return row;
};
const collection = {
    createIndex: async () => 'expiresAt',
    insertOne: async row => {
        if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
        rows.set(row._id, row);
    },
    findOne: async filter => matches(rows.get(filter._id), filter) ? rows.get(filter._id) : null,
    findOneAndUpdate: async (filter, change) => matches(rows.get(filter._id), filter) ? apply(rows.get(filter._id), change) : null,
    updateOne: async (filter, change) => {
        if (!matches(rows.get(filter._id), filter)) return { matchedCount: 0 };
        apply(rows.get(filter._id), change);
        return { matchedCount: 1 };
    }
};
dataLayout.collection = key => { assert.equal(key, 'whatsappInbound'); return collection; };
Member.find = () => ({ lean: async () => [] });
Application.find = () => ({ sort: () => ({ lean: async () => [] }) });
notification.log = async row => { logs.push(row); };
NotificationLog.findOne = filter => ({ select: () => ({ lean: async () => logs.find(row => matches(row, filter)) || null }) });
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
    assert.ok([a, b].some(response => response.status === 200));
    assert.ok([a, b].every(response => [200, 500].includes(response.status)));
    assert.equal([a, b].find(response => response.status === 200).headers['x-activ-bot-version'], 'conversational-v4');
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
    await recoveryCases();
    console.log('Signed inbound routing, batched messages, duplicate protection, bounded preparation recovery, stale-worker fencing, accepted/partial-send protection, session window and account journeys passed.');
}

async function recoveryCases() {
    const realHandler = bot.handleInbound;
    const realUpdate = collection.updateOne;
    const makeReceipt = (id, extra = {}) => rows.set(`our-number-id:${id}`, {
        _id: `our-number-id:${id}`, status: 'processing', attempts: 1,
        receivedAt: new Date(Date.now() - inbound.LEASE_MS - 1000), ...extra
    });
    let calls = 0;
    bot.handleInbound = async (...args) => {
        if (++calls === 1) throw new Error('Temporary preparation failure');
        return realHandler(...args);
    };
    const recovery = envelope([message('recover-prepare', 'hi')]);
    const before = sent.length;
    assert.equal((await post(recovery)).status, 500);
    assert.equal(sent.length, before);
    assert.equal((await post(recovery)).status, 200);
    assert.equal(sent.length, before + 1, 'a failed preparation is retried once and replies');
    assert.equal(rows.get('our-number-id:recover-prepare').attempts, 2);
    await post(recovery);
    assert.equal(sent.length, before + 1, 'a recovered reply is not duplicated');
    bot.handleInbound = realHandler;

    makeReceipt('orphan');
    assert.equal((await post(envelope([message('orphan', 'hi')]))).status, 200);
    assert.equal(rows.get('our-number-id:orphan').status, 'replied', 'an abandoned old receipt can recover');

    const beforeLogged = sent.length;
    makeReceipt('accepted-legacy');
    logs.push({ event: 'BOT_REPLY', channel: 'whatsapp', provider: 'meta', status: 'sent',
        providerMessageId: 'already-accepted', data: { inboundMessageId: 'accepted-legacy', part: 1, parts: 2 } });
    assert.equal((await post(envelope([message('accepted-legacy', 'hi')]))).status, 200);
    assert.equal(sent.length, beforeLogged, 'accepted legacy chunks are not replayed after a lost receipt update');
    assert.deepEqual(rows.get('our-number-id:accepted-legacy').outboundMessageIds, ['already-accepted']);

    let failCompletion = true;
    collection.updateOne = async (filter, change) => {
        if (filter._id.endsWith(':lost-completion') && change.$set?.status === 'replied' && failCompletion) {
            failCompletion = false; throw new Error('Receipt database unavailable');
        }
        return realUpdate(filter, change);
    };
    const completed = envelope([message('lost-completion', 'hi')]);
    const beforeComplete = sent.length;
    assert.equal((await post(completed)).status, 500);
    assert.equal(sent.length, beforeComplete + 1);
    assert.equal((await post(completed)).status, 200);
    assert.equal(sent.length, beforeComplete + 1, 'receipt-save failure cannot resend an accepted reply');
    collection.updateOne = realUpdate;

    let partialCalls = 0;
    bot.handleInbound = async (body, options) => {
        partialCalls++;
        await options.beforeReplySend();
        return { handled: true, sent: { success: false, messageIds: ['accepted-part-one'], error: 'Part two temporarily failed' } };
    };
    const partial = envelope([message('partial')]);
    assert.equal((await post(partial)).status, 200);
    assert.equal((await post(partial)).status, 200);
    assert.equal(partialCalls, 1, 'partial replies are left to individual delivery retries');

    bot.handleInbound = async () => { throw new Error('Persistent preparation failure'); };
    const exhausted = envelope([message('exhausted')]);
    for (let attempt = 0; attempt < inbound.MAX_ATTEMPTS; attempt++) assert.equal((await post(exhausted)).status, 500);
    assert.equal((await post(exhausted)).status, 200);
    assert.equal(rows.get('our-number-id:exhausted').attempts, inbound.MAX_ATTEMPTS, 'preparation retries are bounded');
    makeReceipt('crashed-final-attempt', { attempts: inbound.MAX_ATTEMPTS });
    assert.equal((await post(envelope([message('crashed-final-attempt')]))).status, 200);
    assert.equal(rows.get('our-number-id:crashed-final-attempt').retryable, false, 'a crash cannot cause endless exhausted retries');

    // Let the original worker continue only after a replacement has claimed its
    // expired preparation. Only the replacement may cross the send checkpoint.
    let releaseOld, oldStarted;
    const started = new Promise(resolve => { oldStarted = resolve; });
    const gate = new Promise(resolve => { releaseOld = resolve; });
    let workers = 0, providerCalls = 0;
    bot.handleInbound = async (body, options) => {
        if (++workers === 1) { oldStarted(); await gate; }
        await options.beforeReplySend();
        providerCalls++;
        return { handled: true, sent: { success: true, messageIds: ['fenced-reply'] } };
    };
    const fencePayload = envelope([message('fenced')]);
    const original = inbound.handleWebhook(fencePayload).then(() => null, error => error);
    await started;
    rows.get('our-number-id:fenced').leaseUntil = new Date(Date.now() - 1000);
    await inbound.handleWebhook(fencePayload);
    releaseOld();
    assert.match((await original).message, /lease was replaced/);
    assert.equal(providerCalls, 1, 'the slow original worker cannot send after losing its lease');
    assert.equal(rows.get('our-number-id:fenced').status, 'replied', 'a stale worker cannot overwrite the successful receipt');
    bot.handleInbound = realHandler;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
