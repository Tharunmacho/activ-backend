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
let rows = [], scans = [], claims = [], sent = [], beforeClaim = null, beforeFlip = null, inFlight = 0, maxInFlight = 0;
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
    assert.equal(options.new, true, 'dispatch uses the row returned by the successful claim');
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
notifications.dispatchInBackground = () => { throw new Error('Reminder sweep must await dispatch'); };
notifications.dispatchLifecycleEvent = async (type, recipient, payload) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    sent.push({ type, recipient, payload });
    inFlight--;
    return { channels: { email: { success: true }, whatsapp: { success: true } } };
};
const member = (number, extra = {}) => ({ _id: id(number), fullName: `Fixture ${number}`,
    email: `fixture${number}@example.test`, phoneNumber: '+919000000000',
    membershipStatus: 'active', membershipType: 'annual',
    membershipActivatedAt: new Date('2025-11-01T00:00:00+05:30'),
    membershipExpiresAt: new Date('2026-11-01T00:00:00+05:30'),
    renewalReminders: [], ...extra });
const reset = () => { rows = []; scans = []; claims = []; sent = []; beforeClaim = null; beforeFlip = null; maxInFlight = 0; };

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
    assert.equal(inFlight, 0, 'sendWindowReminders waits for delivery attempt/log completion');
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
    assert.equal(sent[0].recipient.id, id(4));
    assert.equal(sent[0].recipient.name, 'Current contact name');
    assert(claims.every(filter => filter.membershipStatus === 'active' && filter.membershipExpiresAt
        && filter.membershipActivatedAt && filter.renewalReminderEnabled.$ne === false));
    assert.equal(rows[0].renewalReminders.length, 0, 'opt-out after scan is not consumed or sent');
    assert.equal(rows[1].renewalReminders.length, 0, 'renewal after scan cannot receive old reminder');
    assert.equal(rows[2].renewalReminders.length, 0, 'lifetime conversion after scan cannot receive old reminder');

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
    assert.equal(scans.length, 3);
    assert.equal(await service.sendMonthlyExpired(now), 0);

    reset();
    rows = [member(1, { ...expired, membershipStatus: 'expired' }), member(2, { ...expired, membershipStatus: 'expired' })];
    beforeClaim = filter => {
        const row = rows.find(value => value._id === filter._id);
        if (filter._id === id(1)) row.renewalReminderEnabled = false;
        else { row.membershipStatus = 'active'; row.membershipExpiresAt = new Date('2027-09-01T00:00:00+05:30'); }
    };
    assert.equal(await service.sendMonthlyExpired(now), 0, 'expired monthly claims also recheck opt-out and renewal');
    assert.equal(sent.length, 0);

    reset();
    rows = [member(1, { membershipExpiresAt: new Date(now.getTime() - DAY) })];
    assert.equal(await service.sendDue(now), 1, 'expiry-day window and monthly sweep do not both notify newly expired member');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.data.window, 0);
    assert.equal(rows[0].membershipStatus, 'expired');
    console.log('PASS: paginated pre-expiry/expiry/monthly scans, second-page delivery, opt-out/renewal/lifetime races, fresh contact data, awaited dispatch, deduplication and unchanged reminder windows.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
