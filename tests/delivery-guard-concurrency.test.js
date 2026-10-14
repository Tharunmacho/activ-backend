// Isolated delivery guard races; retryLog is stubbed and never contacts a provider.
const assert = require('assert/strict');
const NotificationLog = require('../src/modules/notifications/notificationLog.model');
const notificationService = require('../src/modules/notifications/notification.service');
const guardPath = require.resolve('../src/modules/notifications/deliveryGuard');
const guardA = require(guardPath);
delete require.cache[guardPath];
const guardB = require(guardPath); // Separate worker-local sweep lock, shared fixture DB.
let sent = 0, claims = 0, findCalls = 0, findError = false, claimError = false, forceLostClaim = false;
const row = { _id: 'message-one', event: 'PAYMENT_REQUIRED', channel: 'whatsapp',
    status: 'failed', deliveryStatus: 'failed', lastError: 'ETIMEDOUT', createdAt: new Date() };
let current;
const clone = value => structuredClone(value);
const reset = () => { current = clone(row); sent = 0; claims = 0; findCalls = 0;
    findError = false; claimError = false; forceLostClaim = false; };
NotificationLog.find = () => {
    findCalls++;
    const snapshot = clone(current);
    return { sort() { return this; }, limit() { return this; }, lean: async () => {
        if (findError) throw Error('Fixture read failed');
        return [snapshot];
    } };
};
NotificationLog.updateOne = async (filter, update) => {
    claims++;
    if (claimError) throw Error('Fixture claim failed');
    const expected = filter.$or ? 0 : filter['autoRetry.count'];
    assert.notEqual(expected, undefined, 'each provider attempt requires an expected-count claim');
    if (forceLostClaim || Number(current.autoRetry?.count || 0) !== expected) return { matchedCount: 0, modifiedCount: 0 };
    current.autoRetry = { count: expected + update.$inc['autoRetry.count'], lastAt: update.$set['autoRetry.lastAt'] };
    return { matchedCount: 1, modifiedCount: 1 };
};
notificationService.retryLog = async () => { sent++; return { outcome: { success: true } }; };
async function main() {
    reset();
    const [first, duplicate] = await Promise.all([guardA.retryFailed({ auto: true }), guardA.retryFailed({ auto: true })]);
    assert.equal(first.sent, 1);
    assert.equal(duplicate.alreadyRunning, true);
    assert.equal(sent, 1);
    assert.equal(findCalls, 1, 'overlapping automatic sweeps in one process do not query twice');

    reset();
    const pair = await Promise.all([guardA.retryFailed({ auto: true }), guardB.retryFailed({ auto: true })]);
    assert.equal(sent, 1, 'two workers cannot both claim the same retry count');
    assert.equal(claims, 2);
    assert.equal(pair.reduce((sum, result) => sum + result.skipped, 0), 1);
    assert.equal(current.autoRetry.count, 1);

    reset(); claimError = true;
    assert.equal((await guardA.retryFailed({ auto: true })).skipped, 1);
    assert.equal(sent, 0, 'unconfirmed database claim fails closed');
    reset(); forceLostClaim = true;
    assert.equal((await guardA.retryFailed({ auto: true })).skipped, 1);
    assert.equal(sent, 0, 'matchedCount zero prevents provider call');

    reset(); findError = true;
    await assert.rejects(guardA.retryFailed({ auto: true }), /Fixture read failed/);
    findError = false;
    assert.equal((await guardA.retryFailed({ auto: true })).sent, 1, 'sweep lock releases even when lookup fails');

    reset();
    current.autoRetry = { count: 3, lastAt: new Date() };
    assert.equal((await guardA.retryFailed({ auto: true })).skipped, 1);
    assert.equal(sent, 0);
    assert.equal((await guardA.retryFailed({ auto: false })).sent, 1, 'explicit manual retry keeps its existing no-budget behavior');
    assert.equal(current.autoRetry.count, 4);
    console.log('Delivery guard concurrency checks passed: process overlap, cross-worker atomic claim, claim/read failures and manual retry behavior.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
