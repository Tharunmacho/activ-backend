// Isolated native-collection fixtures: no MongoDB connection and no message/provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ObjectId } = require('mongoose').Types;
const { createService } = require('../src/modules/admin/archivedRecordDeletion.service');
const actor = { role: 'super_admin', userId: new ObjectId().toString(), email: 'admin@example.test' };
const now = new Date('2026-10-15T15:00:00Z');
const old = new Date('2026-10-01T00:00:00Z');
const later = new Date('2026-10-15T16:00:00Z');
const confirm = id => ({ recordId: String(id), confirmation: 'DELETE' });
const get = (row, field) => field.split('.').reduce((value, part) => value?.[part], row);
const equal = (a, b) => b == null ? a == null : a instanceof Date || b instanceof Date ? +new Date(a) === +new Date(b) : String(a) === String(b);
function matches(row, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (key === '$or') return expected.some(part => matches(row, part));
        if (key === '$and') return expected.every(part => matches(row, part));
        const actual = get(row, key);
        if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
            return Object.entries(expected).every(([op, value]) => {
                if (op === '$in') return value.some(item => equal(actual, item));
                if (op === '$ne') return !equal(actual, value);
                if (op === '$gt') return actual != null && +new Date(actual) > +new Date(value);
                throw Error('Unsupported fixture operator: ' + op);
            });
        }
        return equal(actual, expected);
    });
}
function fixture() {
    const data = Object.fromEntries(['MemberDetails', 'PaymentOrder', 'Event', 'EventBooking', 'EventRegistration', 'EventCheckin', 'LifecycleOutbox', 'ContentBroadcast', 'Notification', 'NotificationLog'].map(name => [name, []]));
    const writes = [], audits = [];
    let failure = '', beforeClaim;
    const collections = name => ({
        findOne: async filter => data[name].find(row => matches(row, filter)) || null,
        find: filter => ({ toArray: async () => data[name].filter(row => matches(row, filter)) }),
        updateOne: async (filter, update) => {
            if (beforeClaim) { const callback = beforeClaim; beforeClaim = undefined; callback(); }
            const row = data[name].find(value => matches(value, filter));
            if (row) Object.assign(row, update.$set);
            return { matchedCount: row ? 1 : 0 };
        },
        deleteMany: async filter => {
            writes.push({ name, filter });
            if (failure === name) { failure = ''; throw Error('Simulated dependent write failure'); }
            const selected = data[name].filter(row => matches(row, filter));
            data[name] = data[name].filter(row => !selected.includes(row));
            return { deletedCount: selected.length };
        },
        deleteOne: async filter => {
            writes.push({ name, filter });
            const row = data[name].find(value => matches(value, filter));
            if (row) data[name] = data[name].filter(value => value !== row);
            return { deletedCount: row ? 1 : 0 };
        },
    });
    return { data, writes, audits, fail: name => { failure = name; }, race: callback => { beforeClaim = callback; }, service: createService({ collections, audit: async entry => audits.push(entry), now: () => now }) };
}
const payment = (extra = {}) => ({ _id: new ObjectId(), memberId: new ObjectId(), orderId: 'ORDER-' + new ObjectId(), orderType: 'membership', email: 'old@example.test', status: 'paid', ...extra });
const addEvent = (f, overrides = {}) => {
    const event = { _id: new ObjectId(), archivedAt: old, title: 'Private old programme', ...overrides };
    const booking = { _id: new ObjectId(), eventId: event._id, bookingRef: 'BOOK-' + new ObjectId(), payment: { status: 'paid' }, bookedBy: { name: 'Private booker', email: 'booker@example.test' } };
    const order = payment({ orderType: 'event_booking', eventId: String(event._id), bookingRef: booking.bookingRef });
    f.data.Event.push(event); f.data.EventBooking.push(booking); f.data.PaymentOrder.push(order);
    f.data.EventRegistration.push({ _id: new ObjectId(), eventId: event._id, userId: String(order.memberId) });
    f.data.EventCheckin.push({ _id: new ObjectId(), eventId: event._id, bookingId: booking._id });
    f.data.MemberDetails.push({ _id: order.memberId, email: order.email });
    f.data.Notification.push({ _id: new ObjectId(), data: { eventId: String(event._id) } });
    f.data.NotificationLog.push({ _id: new ObjectId(), eventId: String(event._id) });
    f.data.LifecycleOutbox.push({ _id: new ObjectId(), status: 'pending', payload: { data: { bookingRef: booking.bookingRef } } });
    f.data.ContentBroadcast.push({ _id: new ObjectId(), kind: 'event', sourceId: event._id });
    return { event, booking, order };
};
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log('PASS ' + name); }

async function main() {
    await test('both actions require super-admin, valid ID and matching explicit confirmation before reads/writes', async () => {
        const f = fixture(), id = String(new ObjectId());
        for (const method of ['deleteMembershipPayment', 'deleteEventHistory']) {
            for (const role of ['member', 'events_admin', 'state_admin', undefined]) {
                await assert.rejects(f.service[method](id, confirm(id), { role }), error => error.statusCode === 403);
            }
            await assert.rejects(f.service[method]('bad-id', confirm('bad-id'), actor), error => error.statusCode === 400);
            for (const body of [{}, { recordId: id, confirmation: true }, { recordId: String(new ObjectId()), confirmation: 'DELETE' }]) {
                await assert.rejects(f.service[method](id, body, actor), error => error.statusCode === 400);
            }
        }
        assert.equal(f.writes.length, 0);
    });
    await test('orphan payment deletion is exact and preserves same-email live accounts, unrelated orders and notifications', async () => {
        const f = fixture(), archived = payment(), other = payment({ email: archived.email });
        f.data.PaymentOrder.push(archived, other);
        f.data.MemberDetails.push({ _id: other.memberId, email: archived.email });
        f.data.Notification.push({ data: { orderId: archived.orderId } }, { data: { orderId: other.orderId } });
        f.data.NotificationLog.push({ data: { lifecycleData: { orderId: archived.orderId } } });
        f.data.LifecycleOutbox.push({ payload: { orderId: archived.orderId } }, { payload: { data: { orderId: other.orderId } } });
        const result = await f.service.deleteMembershipPayment(String(archived._id), confirm(archived._id), actor);
        assert.equal(result.deleted, true); assert.equal(result.removed.PaymentOrder, 1);
        assert.deepEqual(f.data.PaymentOrder, [other]); assert.equal(f.data.MemberDetails.length, 1);
        assert.equal(f.data.Notification.length, 1); assert.equal(f.data.LifecycleOutbox.length, 1);
        assert.equal(f.audits[0].action, 'membership.archived_payment_deleted');
        assert(!JSON.stringify(f.audits).includes(archived.email));
    });
    await test('existing, blocked, soft-deleted and legacy-linked account payments are protected', async () => {
        for (const state of [{}, { isActive: false }, { deletedAt: old }, { legacy: true }]) {
            const f = fixture(), order = payment(); f.data.PaymentOrder.push(order);
            f.data.MemberDetails.push(state.legacy ? { _id: new ObjectId(), userId: String(order.memberId) } : { _id: order.memberId, ...state });
            await assert.rejects(f.service.deleteMembershipPayment(String(order._id), confirm(order._id), actor), /existing account/);
            assert.equal(f.writes.length, 0);
        }
    });
    await test('wrong payment type, missing ownership and settlement in flight are protected', async () => {
        for (const extra of [{ orderType: 'donation' }, { memberId: null }, { settlementStartedAt: now }, { status: 'created', expiresAt: later }, { status: 'created' }]) {
            const f = fixture(), order = payment(extra); f.data.PaymentOrder.push(order);
            await assert.rejects(f.service.deleteMembershipPayment(String(order._id), confirm(order._id), actor), error => error.statusCode === 409);
            assert.equal(f.writes.length, 0);
        }
    });
    await test('membership worker lease and a concurrent payment settlement block deletion', async () => {
        const f = fixture(), order = payment({ status: 'created', expiresAt: old }); f.data.PaymentOrder.push(order);
        f.data.LifecycleOutbox.push({ payload: { orderId: order.orderId }, status: 'processing', leaseUntil: later });
        await assert.rejects(f.service.deleteMembershipPayment(String(order._id), confirm(order._id), actor), /notification is still processing/);
        assert.equal(f.writes.length, 0);
        f.data.LifecycleOutbox[0].status = 'done';
        f.race(() => { order.settlementStartedAt = now; });
        await assert.rejects(f.service.deleteMembershipPayment(String(order._id), confirm(order._id), actor), /processing started/);
        assert.equal(f.writes.length, 0); assert.equal(f.data.PaymentOrder.length, 1);
    });
    await test('payment dependency failure retains root and retry completes', async () => {
        const f = fixture(), order = payment(); f.data.PaymentOrder.push(order); f.fail('NotificationLog');
        await assert.rejects(f.service.deleteMembershipPayment(String(order._id), confirm(order._id), actor), /dependent write failure/);
        assert.equal(f.data.PaymentOrder.length, 1); assert.equal(f.audits.length, 0);
        assert.equal(f.data.PaymentOrder[0].status, 'paid', 'A failed cascade must retain the original payment outcome');
        assert.equal((await f.service.deleteMembershipPayment(String(order._id), confirm(order._id), actor)).deleted, true);
    });
    await test('current, draft and past-but-unarchived events cannot be permanently deleted', async () => {
        for (const extra of [{ status: 'published', startAt: later }, { status: 'draft' }, { status: 'published', startAt: old, endAt: old }]) {
            const f = fixture(), { event } = addEvent(f, { ...extra, archivedAt: null });
            await assert.rejects(f.service.deleteEventHistory(String(event._id), confirm(event._id), actor), /Archive the event/);
            assert.equal(f.writes.length, 0);
        }
    });
    await test('archived event cascade removes all exact history and keeps other events/accounts/payment types', async () => {
        const f = fixture(), target = addEvent(f), other = addEvent(f, { archivedAt: null });
        const legacyOrder = payment({ orderType: 'event_booking', bookingRef: target.booking.bookingRef });
        const conflictingOrder = payment({ orderType: 'event_booking', eventId: String(other.event._id), bookingRef: target.booking.bookingRef });
        const membershipOrder = payment({ eventId: String(target.event._id) });
        f.data.PaymentOrder.push(legacyOrder, conflictingOrder, membershipOrder);
        f.data.LifecycleOutbox.push({ payload: { orderId: legacyOrder.orderId } });
        const result = await f.service.deleteEventHistory(String(target.event._id), confirm(target.event._id), actor);
        assert.equal(result.removed.Event, 1); assert.equal(result.removed.EventBooking, 1); assert.equal(result.removed.PaymentOrder, 2);
        assert.deepEqual(f.data.Event, [other.event]); assert.deepEqual(f.data.EventBooking, [other.booking]);
        for (const name of ['EventRegistration', 'EventCheckin', 'Notification', 'NotificationLog', 'ContentBroadcast', 'LifecycleOutbox']) assert.equal(f.data[name].length, 1, name);
        assert.equal(f.data.MemberDetails.length, 2); assert(f.data.PaymentOrder.includes(conflictingOrder)); assert(f.data.PaymentOrder.includes(membershipOrder));
        assert.equal(f.audits[0].action, 'event.archived_history_deleted');
        assert(!JSON.stringify(f.audits).includes('Private'));
        assert.deepEqual(f.writes.slice(-2).map(write => write.name), ['EventBooking', 'Event']);
    });
    await test('missing-event orphan history is deleted without creating or touching any event', async () => {
        const f = fixture(), { event } = addEvent(f); f.data.Event = [];
        const result = await f.service.deleteEventHistory(String(event._id), confirm(event._id), actor);
        assert.equal(result.removed.Event, 0); assert.equal(f.data.EventBooking.length, 0); assert.equal(f.data.PaymentOrder.length, 0);
        assert.equal(f.data.MemberDetails.length, 1);
        await assert.rejects(f.service.deleteEventHistory(String(event._id), confirm(event._id), actor), error => error.statusCode === 404);
    });
    await test('open event checkouts, active settlement and notification workers block destructive writes', async () => {
        for (const kind of ['checkout', 'hold', 'settlement', 'outbox', 'broadcast']) {
            const f = fixture(), { event, order, booking } = addEvent(f);
            if (kind === 'checkout') Object.assign(order, { status: 'created', expiresAt: later });
            if (kind === 'hold') Object.assign(booking, { expiresAt: later, payment: { status: 'pending' } });
            if (kind === 'settlement') order.settlementStartedAt = now;
            if (kind === 'outbox') Object.assign(f.data.LifecycleOutbox[0], { status: 'processing', leaseUntil: later });
            if (kind === 'broadcast') Object.assign(f.data.ContentBroadcast[0], { status: 'processing', leaseUntil: later });
            await assert.rejects(f.service.deleteEventHistory(String(event._id), confirm(event._id), actor), error => error.statusCode === 409);
            assert.equal(f.writes.length, 0, kind);
        }
    });
    await test('event dependent failure retains archived root and booking references for safe retry', async () => {
        const f = fixture(), { event, booking } = addEvent(f); f.fail('PaymentOrder');
        await assert.rejects(f.service.deleteEventHistory(String(event._id), confirm(event._id), actor), /dependent write failure/);
        assert.deepEqual(f.data.Event, [event]); assert.deepEqual(f.data.EventBooking, [booking]); assert.equal(f.audits.length, 0);
        assert.equal((await f.service.deleteEventHistory(String(event._id), confirm(event._id), actor)).deleted, true);
        assert.equal(f.data.Event.length, 0); assert.equal(f.data.EventBooking.length, 0);
    });
    await test('delete routes are super-admin gated and history literal precedes booking reference route', async () => {
        const events = fs.readFileSync(path.join(__dirname, '../src/modules/events/event.routes.js'), 'utf8');
        const admin = fs.readFileSync(path.join(__dirname, '../src/modules/admin/admin.routes.js'), 'utf8');
        assert(events.includes("router.delete('/:id/bookings/history', requireRole('super_admin'), controller.deleteArchivedBookingHistory)"));
        assert(events.indexOf("router.delete('/:id/bookings/history'") < events.indexOf("router.delete('/:id/bookings/:ref'"));
        assert(admin.includes("router.delete('/super/membership/payments/:paymentId/archived', requireRole('super_admin'), membershipDashboard.removeArchivedPayment)"));
    });
    console.log(`${passed} archived deletion tests passed; no database connection or production deletion.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
