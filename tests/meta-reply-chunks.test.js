// Exercise the real reply loop using local stubs only; no DB, HTTP or sends.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const bot = require('../src/modules/notifications/botbeeWebhook.service');
const meta = require('../src/modules/notifications/metaCloud.service');
const notifications = require('../src/modules/notifications/notification.service');
const conversation = require('../src/modules/notifications/conversationReply');
const Member = require('../src/modules/members/memberdetails.model');
const Application = require('../src/modules/applications/application.model');
Member.find = () => ({ lean: async () => [] });
Application.find = () => ({ sort: () => ({ lean: async () => [] }) });
const reply = ['A'.repeat(3000), 'B'.repeat(3000), 'C'.repeat(3000)].join('\n\n');
const chunks = bot.replyChunks(reply);
assert.equal(chunks.length, 3);
conversation.plansReply = async () => reply;
const inboundAt = new Date(Date.now() - 60 * 60 * 1000);
const incomingId = 'fixture-inbound-message';
const recipient = '919999999999';
const envelope = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: 'fixture-number' }, messages: [{ id: incomingId, from: recipient,
        type: 'text', timestamp: String(Math.floor(inboundAt.getTime() / 1000)), text: { body: 'membership fees' } }]
} }] }] };
let calls = [], logs = [], order = [], failPart = 0;
const reset = failure => { calls = []; logs = []; order = []; failPart = failure; };
meta.sendTextMessage = async (to, text, options) => {
    const part = calls.length + 1;
    calls.push({ to, text, options }); order.push(`send:${part}`);
    assert.equal(order[0], 'checkpoint', 'No provider call may precede the receipt checkpoint');
    return part === failPart
        ? { success: false, to, provider: 'meta', error: 'Meta temporarily unavailable' }
        : { success: true, to, provider: 'meta', messageId: `accepted-${part}` };
};
notifications.log = async row => {
    logs.push(structuredClone(row)); order.push(`log:${row.data.part}`);
    return { _id: `log-${logs.length}`, ...row };
};
const run = (extra = {}) => bot.handleInbound(envelope, { provider: 'meta', inboundAt,
    beforeReplySend: async () => { order.push('checkpoint'); }, ...extra });
const checkLogs = () => {
    assert.equal(logs.length, 3, 'All parts, including the unsent tail, must be persisted');
    assert.deepEqual(logs.map(row => row.data.text), chunks, 'No text is lost between attempted and deferred parts');
    for (let i = 0; i < logs.length; i++) {
        const row = logs[i];
        assert.equal(row.event, 'BOT_REPLY');
        assert.equal(row.provider, 'meta');
        assert.equal(row.recipient, recipient);
        assert.equal(row.data.part, i + 1);
        assert.equal(row.data.parts, 3);
        assert.equal(row.data.inboundMessageId, incomingId);
        assert.equal(row.data.inboundAt, inboundAt.toISOString(), 'The original session timestamp must survive retries');
    }
    for (const call of calls) assert.equal(call.options.replyTo, incomingId);
};

async function main() {
    reset(0);
    const success = await run();
    checkLogs();
    assert.equal(success.sent.success, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(success.sent.messageIds, ['accepted-1', 'accepted-2', 'accepted-3']);
    assert(logs.every(row => row.status === 'sent' && row.deliveryStatus === 'accepted'
        && row.data.replyAttempted === true && row.data.replyDeferred === false));
    assert.deepEqual(order, ['checkpoint', 'send:1', 'log:1', 'send:2', 'log:2', 'send:3', 'log:3']);

    reset(1);
    const firstFailure = await run();
    checkLogs();
    assert.equal(calls.length, 1, 'Provider calls stop at the first failed part');
    assert.equal(firstFailure.sent.success, false);
    assert.deepEqual(firstFailure.sent.messageIds, []);
    assert.deepEqual(logs.map(row => row.data.replyAttempted), [true, false, false]);
    assert.deepEqual(logs.map(row => row.data.replyDeferred), [false, true, true]);
    assert(logs.every(row => row.status === 'failed' && row.deliveryStatus === 'failed'));
    assert(logs.slice(1).every(row => /temporarily failed/.test(row.lastError) && !row.providerMessageId));
    assert.equal(firstFailure.sent.error, 'Meta temporarily unavailable', 'Return the actual failed attempt, not the deferred tail');
    assert.deepEqual(order, ['checkpoint', 'send:1', 'log:1', 'log:2', 'log:3']);

    reset(2);
    const secondFailure = await run();
    checkLogs();
    assert.equal(calls.length, 2);
    assert.equal(secondFailure.sent.success, false);
    assert.deepEqual(secondFailure.sent.messageIds, ['accepted-1']);
    assert.deepEqual(logs.map(row => row.status), ['sent', 'failed', 'failed']);
    assert.deepEqual(logs.map(row => row.data.replyDeferred), [false, false, true]);
    assert.equal(logs[0].providerMessageId, 'accepted-1', 'The successful prefix remains independently identifiable');

    reset(3);
    const lastFailure = await run();
    checkLogs();
    assert.equal(calls.length, 3);
    assert.equal(lastFailure.sent.success, false);
    assert.deepEqual(lastFailure.sent.messageIds, ['accepted-1', 'accepted-2']);
    assert(logs.every(row => row.data.replyAttempted && !row.data.replyDeferred));

    reset(0);
    await assert.rejects(run({ beforeReplySend: async () => { throw new Error('Preparation lease replaced'); } }), /lease replaced/);
    assert.equal(calls.length, 0, 'Losing the send checkpoint forbids all provider calls');
    assert.equal(logs.length, 0, 'A stale worker must not enqueue duplicate deferred chunks');
    console.log('PASS real Meta reply loop: three-part success, failure at every part, persisted tail, original session timestamp and send fencing.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
