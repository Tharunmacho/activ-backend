// Real retry/service/worker paths with an isolated log store and provider stubs.
const assert = require('assert/strict');
const Log = require('../src/modules/notifications/notificationLog.model');
const meta = require('../src/modules/notifications/metaCloud.service');
const botbee = require('../src/modules/notifications/botbee.service');
const service = require('../src/modules/notifications/notification.service');
const { reasonToSkip } = require('../src/modules/notifications/retryEligibility');
const guard = require('../src/modules/notifications/deliveryGuard');
const rows = [];
let readFailure = false, sends = [], claims = 0;
const makeRow = (part = 1, extra = {}) => ({
    _id: String(part).padStart(24, '0'), event: 'BOT_REPLY', channel: 'whatsapp', provider: 'meta',
    recipient: '919999999999', status: 'failed', deliveryStatus: 'failed', lastError: 'ETIMEDOUT',
    createdAt: new Date(), data: { inboundMessageId: 'incoming-fixture', inboundAt: new Date().toISOString(),
        part, parts: 3, text: `Reply part ${part}`, replyDeferred: part > 1, ...extra },
    async save() { return this; }, markModified() {}
});
Log.findById = async id => rows.find(row => String(row._id) === String(id));
Log.find = filter => ({
    select() { return this; }, sort() { return this; }, limit() { return this; },
    async lean() {
        if (readFailure) throw Error('Fixture log read failed');
        if (filter.event === 'BOT_REPLY') return rows.filter(row => row.event === filter.event
            && row.provider === filter.provider && row.recipient === filter.recipient
            && row.data.inboundMessageId === filter['data.inboundMessageId']
            && row.data.part < filter['data.part'].$lt);
        return rows.filter(row => row.deliveryStatus === 'failed').map(row => ({ ...row }));
    }
});
Log.updateOne = async (filter, update) => {
    claims++;
    const row = rows.find(item => item._id === filter._id);
    const expected = filter.$or ? 0 : filter['autoRetry.count'];
    if (!row || Number(row.autoRetry?.count || 0) !== expected) return { matchedCount: 0 };
    row.autoRetry = { count: expected + update.$inc['autoRetry.count'], lastAt: update.$set['autoRetry.lastAt'] };
    return { matchedCount: 1 };
};
meta.sendTextMessage = async (...args) => {
    sends.push(args);
    return { success: true, messageId: `accepted-${sends.length}`, to: args[0], provider: 'meta' };
};
botbee.sendTextMessage = async () => { throw Error('Meta reply incorrectly routed to BotBee'); };
async function main() {
    const first = makeRow();
    rows.push(first, makeRow(2), makeRow(3));
    assert.equal(await reasonToSkip(first), '');
    for (const timestamp of [undefined, 'invalid', new Date(Date.now() - 86400001).toISOString(), new Date(Date.now() + 120000).toISOString()]) {
        assert.match(await reasonToSkip({ ...first, data: { ...first.data, inboundAt: timestamp } }), /unknown or expired/);
    }
    assert.equal(await reasonToSkip({ ...first, data: { ...first.data, inboundAt: Math.floor(Date.now() / 1000) } }), '');
    assert.match(await reasonToSkip({ ...first, data: { ...first.data, inboundMessageId: '' } }), /context/);
    assert.match(await reasonToSkip({ ...first, provider: '' }), /provider/);
    for (const deliveryStatus of ['accepted', 'sent', 'delivered', 'read']) {
        assert.match(await reasonToSkip({ ...first, deliveryStatus }), /already accepted/);
    }
    assert.match(await reasonToSkip(rows[1]), /earlier reply part/);
    assert.match(await reasonToSkip(rows[2]), /earlier reply part/);
    readFailure = true;
    assert.match(await reasonToSkip(rows[1]), /could not be checked/);
    readFailure = false;

    // A missing/failed first part leaves the deferred tail's attempt budget intact.
    first.lastError = '132000 invalid parameter';
    const waiting = await guard.retryFailed({ auto: true });
    assert.equal(waiting.retried, 0);
    assert.equal(claims, 0);
    assert.equal(sends.length, 0);
    assert.equal(rows[1].autoRetry, undefined);
    first.lastError = 'ETIMEDOUT';
    const recovered = await guard.retryFailed({ auto: true });
    assert.equal(recovered.sent, 3);
    assert.deepEqual(sends.map(args => args[1]), ['Reply part 1', 'Reply part 2', 'Reply part 3']);
    assert.ok(sends.every(args => args[2].replyTo === 'incoming-fixture'));
    assert.ok(rows.every(row => row.deliveryStatus === 'accepted' && row.data.replyAttempted && !row.data.replyDeferred));
    assert.ok(rows.every(row => row.autoRetry.count === 1));
    const duplicate = await service.retryLog(first._id);
    assert.equal(duplicate.skipped, true);
    assert.equal(sends.length, 3, 'accepted prefix is never replayed');

    // A failed asynchronous delivery may retry the affected part, with its own
    // text/context, but acceptance of unrelated conversations is not a prefix.
    rows[2].deliveryStatus = 'failed';
    rows[2].status = 'sent';
    rows[1].data.inboundMessageId = 'different-conversation';
    assert.match(await reasonToSkip(rows[2]), /earlier reply part/);
    rows[1].data.inboundMessageId = 'incoming-fixture';
    assert.equal((await service.retryLog(rows[2]._id)).outcome.success, true);
    assert.equal(sends.length, 4);
    assert.equal(sends[3][1], 'Reply part 3');
    rows[2].deliveryStatus = 'failed';
    rows[2].data.inboundAt = new Date(Date.now() - 86400001).toISOString();
    assert.equal((await service.retryLog(rows[2]._id)).skipped, true);
    assert.equal(sends.length, 4);
    console.log('Meta reply retry checks passed: original provider/context, service window, accepted-prefix protection, ordered recovery and unspent deferred budgets.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
