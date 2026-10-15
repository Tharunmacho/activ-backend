// No database, SMTP, WhatsApp or scheduler starts: all models/providers are fixtures.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Member = require('../src/modules/members/memberdetails.model');
const notifications = require('../src/modules/notifications/notification.service');
const service = require('../src/modules/notifications/membershipRenewal.service');
const state = require('../src/modules/members/membershipState');
const logger = require('../src/config/logger');
logger.silent = true;
const now = new Date('2026-10-16T10:00:00+05:30');
const DAY = 86400000;
const id = number => number.toString(16).padStart(24, '0');
const clone = value => structuredClone(value);
let rows = [], scans = [], claims = [], sent = [], manualSent = [], beforeClaim = null, beforeFlip = null,
    queueFailure = '', inFlight = 0, maxInFlight = 0;
const compare = (actual, expected) => {
    if (expected == null) return actual == null;
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        return Object.entries(expected).every(([operator, value]) => {
            if (operator === '$in') return value.includes(actual);
            if (operator === '$ne') return Array.isArray(actual) ? !actual.includes(value) : actual !== value;
            if (actual == null) return false;
            const left = actual instanceof Date ? actual.getTime() : actual;
            const right = value instanceof Date ? value.getTime() : value;
            if (operator === '$gt') return left > right;
            if (operator === '$gte') return left >= right;
            if (operator === '$lte') return left <= right;
            throw new Error(`Unknown matcher operator ${operator}`);
        });
    }
    if (actual instanceof Date || expected instanceof Date) return new Date(actual).getTime() === new Date(expected).getTime();
    return actual === expected;
};
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => key === '$or'
    ? value.some(clause => matches(row, clause)) : compare(row[key], value));
const patchRow = (row, patch) => {
    Object.assign(row, clone(patch.$set || {}));
    for (const [key, value] of Object.entries(patch.$addToSet || {})) {
        row[key] ||= [];
        if (!row[key].includes(value)) row[key].push(value);
    }
};
Member.find = filter => {
    let limit;
    return {
        sort(order) { assert.deepEqual(order, { _id: 1 }); return this; },
        limit(size) { assert(size > 0 && size <= 1000); limit = size; return this; },
        async lean() {
            assert(limit, 'every scan is bounded');
            scans.push(clone(filter));
            return rows.filter(row => matches(row, filter)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, limit).map(clone);
        },
    };
};
Member.findOneAndUpdate = (filter, patch, options) => ({ async lean() {
    assert.equal(options.new, true);
    assert(sent.some(item => item.recipient.id === filter._id), 'durable enqueue precedes consuming the reminder key');
    claims.push(clone(filter));
    if (beforeClaim) beforeClaim(filter, patch);
    const row = rows.find(value => matches(value, filter));
    if (!row) return null;
    patchRow(row, patch); return clone(row);
} });
Member.updateOne = async (filter, patch) => {
    if (beforeFlip) beforeFlip(filter, patch);
    const row = rows.find(value => matches(value, filter));
    if (!row) return { modifiedCount: 0 };
    patchRow(row, patch); return { modifiedCount: 1 };
};
notifications.dispatchInBackground = async (type, recipient, payload) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    if (queueFailure === 'throw') throw Error('fixture enqueue failure');
    if (queueFailure) return { queued: false, error: 'fixture enqueue failure' };
    sent.push({ type, recipient, payload });
    return { queued: true, outboxId: `fixture-${sent.length}` };
};
notifications.dispatchLifecycleEvent = async (type, recipient, payload) => {
    inFlight++;
    await new Promise(resolve => setImmediate(resolve));
    manualSent.push({ type, recipient, payload });
    inFlight--;
    return { channels: { email: { success: true }, whatsapp: { success: true } } };
};
Member.findById = memberId => ({ lean: async() => rows.find(row => row._id === memberId) });
const retryGuard = require('../src/modules/notifications/retryEligibility');
const currentQueueReasons = () => Promise.all(sent.map(item => retryGuard.reasonToSkip({
    event: item.type, user: item.recipient.id, createdAt: now, data: { lifecycleData: item.payload.data }
})));
const member = (number, extra = {}) => ({ _id: id(number), fullName: `Fixture ${number}`,
    email: `fixture${number}@example.test`, phoneNumber: '+919000000000',
    membershipStatus: 'active', membershipType: 'annual',
    membershipActivatedAt: new Date('2025-11-01T00:00:00+05:30'),
    membershipExpiresAt: new Date('2026-11-01T00:00:00+05:30'),
    renewalReminders: [], ...extra });
const reset = () => { rows = []; scans = []; claims = []; sent = []; manualSent = []; beforeClaim = null;
    beforeFlip = null; queueFailure = ''; maxInFlight = 0; };

async function main() {
    const expires = state.periodEnd(member(1));
    const key30 = `${expires.toISOString().slice(0, 10)}:30`;
    rows = Array.from({ length: 500 }, (_, index) => member(index + 1, { renewalReminders: [key30] }));
    rows.push(member(501), member(502, { renewalReminderEnabled: false }), member(503, { isActive: false }));
    assert.equal(await service.sendWindowReminders(now), 1);
    assert.equal(sent[0].recipient.id, id(501), 'eligible member on page two is reached');
    assert.equal(scans.length, 2);
    assert.equal(scans[1]._id.$gt, id(500));
    assert.equal(maxInFlight, 1);
    assert.equal(inFlight, 0, 'sendWindowReminders waits for durable enqueue');
    assert.equal(manualSent.length, 0, 'automatic sweeps do not wait on provider delivery');
    assert.equal(sent[0].payload.data.renewalReminderKey, key30);
    assert.equal(await service.sendWindowReminders(now), 0, 'restart/repeated sweep does not repeat a claim');

    reset();
    rows = [member(1), member(2), member(3), member(4)];
    beforeClaim = filter => {
        const row = rows.find(value => value._id === filter._id);
        if (filter._id === id(1)) row.renewalReminderEnabled = false;
        if (filter._id === id(2)) row.membershipExpiresAt = new Date('2027-11-01T00:00:00+05:30');
        if (filter._id === id(3)) row.membershipType = 'lifetime';
        if (filter._id === id(4)) row.fullName = 'Current contact name';
    };
    assert.equal(await service.sendWindowReminders(now), 1);
    assert.equal(sent.length, 4, 'intent is saved before the conditional claim');
    const reasons = await currentQueueReasons();
    assert(reasons.slice(0, 3).every(Boolean), 'outbox eligibility skips a subsequent opt-out, renewal or lifetime grant');
    assert.equal(reasons[3], '', 'the unchanged period remains deliverable');
    assert(claims.every(filter => filter.membershipStatus === 'active' && filter.membershipExpiresAt
        && filter.membershipActivatedAt && filter.renewalReminderEnabled.$ne === false));
    assert.equal(rows[0].renewalReminders.length, 0, 'opt-out after scan is not claimed');
    assert.equal(rows[1].renewalReminders.length, 0, 'renewal after scan is not claimed');
    assert.equal(rows[2].renewalReminders.length, 0, 'lifetime conversion after scan is not claimed');

    reset();
    const expired = { membershipExpiresAt: new Date('2026-09-01T00:00:00+05:30') };
    rows = Array.from({ length: 1007 }, (_, index) => member(index + 1, expired));
    const flipped = await service.flipExpired(now);
    assert.equal(flipped.length, 1007, 'expiry flip includes all pages, not just first 1000');
    assert.equal(rows.filter(row => row.membershipStatus === 'expired').length, 1007);
    assert.equal(scans.length, 3);
    assert.equal(sent.length, 0, 'status flip does not invent another message');

    reset();
    rows = [member(1, expired), member(2, { membershipExpiresAt: null, membershipActivatedAt: new Date('2025-09-01T00:00:00+05:30') })];
    beforeFlip = filter => {
        const row = rows.find(value => value._id === filter._id);
        if (filter._id === id(1)) row.membershipExpiresAt = new Date('2027-09-01T00:00:00+05:30');
        if (filter._id === id(2)) row.membershipActivatedAt = new Date('2026-10-01T00:00:00+05:30');
    };
    assert.equal((await service.flipExpired(now)).length, 0, 'renewed stored/fallback periods cannot be expired by stale scan');
    assert(rows.every(row => row.membershipStatus === 'active'));

    reset();
    const monthlyKey = state.halfMonthKey(now);
    rows = Array.from({ length: 1000 }, (_, index) => member(index + 1,
        { ...expired, membershipStatus: 'expired', renewalReminders: [monthlyKey] }));
    rows.push(member(1001, { ...expired, membershipStatus: 'expired' }));
    assert.equal(await service.sendMonthlyExpired(now), 1);
    assert.equal(sent[0].recipient.id, id(1001), 'already-reminded expired rows cannot starve later pages');
    assert.equal(sent[0].payload.data.monthly, monthlyKey);
    assert.equal(sent[0].payload.data.renewalReminderKey, `${monthlyKey}:${state.periodEnd(rows[1000]).toISOString()}`);
    assert.equal(scans.length, 3);
    assert.equal(await service.sendMonthlyExpired(now), 0);

    reset();
    rows = [member(1, { membershipStatus: 'expired', membershipExpiresAt: null, membershipActivatedAt: null }),
        member(2, { ...expired, membershipStatus: 'expired' })];
    assert.equal(await service.sendMonthlyExpired(now), 1, 'unknown legacy period does not abort later monthly reminders');
    assert.deepEqual(sent.map(item => item.recipient.id), [id(2)]);
    assert.equal(rows[0].renewalReminders.length, 0, 'unverified period is neither queued nor claimed');

    reset();
    rows = [member(1, { ...expired, membershipStatus: 'expired' }), member(2, { ...expired, membershipStatus: 'expired' })];
    beforeClaim = filter => {
        const row = rows.find(value => value._id === filter._id);
        if (filter._id === id(1)) row.renewalReminderEnabled = false;
        else { row.membershipStatus = 'active'; row.membershipExpiresAt = new Date('2027-09-01T00:00:00+05:30'); }
    };
    assert.equal(await service.sendMonthlyExpired(now), 0, 'expired monthly claims also recheck opt-out and renewal');
    assert.equal(sent.length, 2, 'both intents are durable before the state changes');
    assert((await currentQueueReasons()).every(Boolean), 'changed monthly reminders are not delivered');

    reset();
    rows = [member(1, { membershipExpiresAt: new Date(now.getTime() - DAY) })];
    assert.equal(await service.sendDue(now), 1, 'expiry-day window and monthly sweep do not both notify newly expired member');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.data.window, 0);
    assert.equal(rows[0].membershipStatus, 'expired');

    reset();
    rows = [member(1, { membershipExpiresAt: null }),
        member(2, { membershipExpiresAt: null, membershipActivatedAt: new Date('2025-10-20T00:00:00+05:30') }),
        member(3, { membershipExpiresAt: null, membershipActivatedAt: new Date('2025-12-01T00:00:00+05:30') }),
        member(4, { membershipExpiresAt: null, membershipType: 'lifetime' }),
        member(5, { membershipExpiresAt: null, membershipTier: 'platinum' })];
    assert.equal(await service.sendWindowReminders(now), 2, 'legacy annual members get advance reminders before lapse');
    assert.deepEqual(sent.map(row => row.payload.data.window), [30, 7]);
    assert(rows.every(row => row.membershipExpiresAt === null), 'the reminder does not rewrite paid validity');
    assert.equal(await service.sendWindowReminders(now), 0, 'legacy reminders retain period deduplication');

    reset();
    rows = [member(1, { membershipExpiresAt: null })];
    beforeClaim = () => { rows[0].membershipActivatedAt = new Date('2026-10-01T00:00:00+05:30'); };
    assert.equal(await service.sendWindowReminders(now), 0, 'concurrent renewal of a legacy period invalidates the claim');

    for (const failure of ['result', 'throw']) {
        reset(); rows = [member(1)]; queueFailure = failure;
        assert.equal(await service.sendWindowReminders(now), 0);
        assert.equal(claims.length, 0, 'enqueue failure cannot consume a reminder key');
        assert.equal(rows[0].renewalReminders.length, 0);
        queueFailure = '';
        assert.equal(await service.sendWindowReminders(now), 1, 'next sweep can recover an enqueue failure');
    }
    reset(); rows = [member(1, { ...expired, membershipStatus: 'expired' })]; queueFailure = 'result';
    assert.equal(await service.sendMonthlyExpired(now), 0);
    assert.equal(claims.length, 0, 'monthly enqueue failure also leaves its key available');

    reset(); rows = [member(1)];
    beforeClaim = () => { throw Error('fixture crash after enqueue'); };
    await assert.rejects(service.sendWindowReminders(now), /crash after enqueue/);
    assert.equal(rows[0].renewalReminders.length, 0);
    const persistedKey = sent[0].payload.data.renewalReminderKey;
    beforeClaim = null;
    assert.equal(await service.sendWindowReminders(new Date(+now + 86400000)), 1);
    assert.equal(sent[1].payload.data.renewalReminderKey, persistedKey, 'restart uses the same queue identity despite changed daysLeft');

    reset(); rows = [member(1)];
    await service.dispatchRenewal(rows[0], now);
    assert.equal(sent.length, 0, 'manual reminder retains the direct awaited API');
    assert.equal(manualSent.length, 1);
    assert.equal(inFlight, 0, 'manual reminder waits for channel outcome');
    console.log('PASS: paginated renewal scans, durable enqueue before claim, failed/crashed enqueue recovery, stable reminder identity, current-state race guards and awaited manual dispatch.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
