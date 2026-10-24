// Runs the real API against a disposable loopback MongoDB, never the configured DB.
// Install backend dev dependencies, then run: npm run test:event-module
// MONGOMS_DOWNLOAD_DIR optionally reuses a local MongoDB binary cache.
const assert = require('node:assert/strict');
const path = require('node:path');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-event-test-only-secret';
process.env.PAYMENT_MODE = 'mock';
process.env.PAYMENT_SIGNING_SECRET = 'local-event-test-only-signature';
process.env.EVENT_PASS_SECRET = 'local-event-test-only-passes';
const DAY = 86400000;
let mongod, server;

async function main() {
    mongod = await MongoMemoryServer.create({
        binary: { downloadDir: process.env.MONGOMS_DOWNLOAD_DIR || path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') },
        instance: { ip: '127.0.0.1' },
    });
    const uri = mongod.getUri();
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'writes require the disposable loopback database');
    process.env.MONGODB_URI = uri;
    await mongoose.connect(uri, { autoIndex: false });
    const Event = require('../src/modules/events/event.model');
    const Booking = require('../src/modules/events/eventbooking.model');
    const Registration = require('../src/modules/events/eventregistration.model');
    const Checkin = require('../src/modules/events/eventcheckin.model');
    const Payment = require('../src/modules/payment/paymentorder.model');
    const Member = require('../src/modules/members/memberdetails.model');
    const bookingService = require('../src/modules/events/eventbooking.service');
    // Announcements are the only external side effect of these booking actions.
    const notifications = [];
    bookingService.announce = (row, status) => { notifications.push({ ref: row.bookingRef, status }); };
    // Archive notifications claim delivery metadata asynchronously. Test that
    // dispatch separately; keep this retention snapshot independent of its
    // eventChangesSent/updatedAt writes and all provider side effects.
    const eventChanges = [];
    require('../src/modules/events/eventChanges.service').announceChange = (before, after) => {
        eventChanges.push({ before, after });
        return Promise.resolve();
    };
    require('../src/config/logger').silent = true;
    const app = require('../src/app');
    server = await new Promise(resolve => { const http = app.listen(0, '127.0.0.1', () => resolve(http)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/v1';
    const members = {};
    for (const kind of ['unpaid', 'paid']) {
        const _id = new mongoose.Types.ObjectId();
        await Member.collection.insertOne({ _id, fullName: kind + ' member', email: kind + '@example.test',
            membershipStatus: kind === 'paid' ? 'active' : 'approved', state: 'Tamil Nadu', district: 'Chennai', role: 'member' });
        // Deliberately false token claims: the DB must decide eligibility.
        members[kind] = { id: String(_id), token: jwt.sign({ userId: String(_id), role: 'member', isPaid: kind === 'unpaid' }, process.env.JWT_SECRET) };
    }
    const admin = jwt.sign({ role: 'super_admin' }, process.env.JWT_SECRET);
    let checks = 0;
    async function request(route, { token = admin, method = 'GET', body, status = 200 } = {}) {
        const response = await fetch(base + route, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
        });
        const result = await response.json();
        assert.equal(response.status, status, method + ' ' + route + ': ' + JSON.stringify(result));
        checks++;
        return result.data;
    }
    async function event(title, extra = {}) {
        return Event.create({ title, status: 'published', audience: 'all', channel: 'public', reachEveryone: true,
            startAt: new Date(Date.now() + DAY * 2), endAt: new Date(Date.now() + DAY * 3),
            registrationEnabled: true, capacity: 30, registrationFee: 0, ...extra });
    }
    const free = await event('Free event');
    const paid = await event('Discounted event', { registrationFee: 1000, memberFee: 600 });
    const restricted = await event('Paid members only', { audience: 'paid' });
    const targeted = await event('Different region', { reachEveryone: false, targets: [{ state: 'Karnataka', district: 'Bengaluru' }] });
    const ended = await event('Completed event', { startAt: new Date(Date.now() - DAY * 2), endAt: new Date(Date.now() - DAY) });
    const multiday = await event('Ongoing multi-day event', { startAt: new Date(Date.now() - DAY), endAt: null,
        days: [{ date: new Date(Date.now() + DAY) }], registrationDeadline: new Date(Date.now() + DAY) });
    const cmsRemoved = await event('CMS removal');
    const missing = await event('Historical hard deletion', { registrationFee: 250 });
    const person = n => ({ name: 'Test contact ' + n, email: 'contact' + n + '@example.test', phone: '9000000' + String(n).padStart(3, '0'), noOfPersons: 1 });
    const booked = {};

    // Public screens cannot expose completed events, even using old links or
    // authenticated admin credentials with the explicit public scope.
    for (const token of ['', admin, members.unpaid.token, members.paid.token]) {
        for (const period of ['upcoming', 'past', 'all']) {
            const feed = await request('/cms/events?scope=public&period=' + period, { token });
            assert(feed.some(e => e.id === String(free._id)), 'public programme still shows current events');
            assert(feed.some(e => e.id === String(multiday._id)), 'ongoing events remain visible');
            assert(!feed.some(e => e.id === String(ended._id)), 'public programme never includes past events');
        }
        await request('/cms/events/' + ended._id + '?scope=public', { token, status: 404 });
    }
    const editorPast = await request('/cms/events?period=past');
    assert(editorPast.some(e => e.id === String(ended._id)), 'authenticated editor can still manage history');
    await request('/cms/events/' + ended._id);

    for (const kind of ['unpaid', 'paid']) {
        const token = members[kind].token;
        const { events: list } = await request('/events?period=upcoming', { token });
        assert(list.some(e => e.id === String(free._id)), kind + ' dashboard lists free event');
        assert.equal(list.some(e => e.id === String(restricted._id)), kind === 'paid');
        assert(!list.some(e => e.id === String(targeted._id)), 'region targeting is applied');
        assert(!list.some(e => e.id === String(ended._id)), 'completed events leave upcoming');
        assert(list.some(e => e.id === String(multiday._id)), 'ongoing multi-day events remain current');
        const page = await request('/event-bookings/event/' + paid._id, { token });
        assert.equal(page.amount, kind === 'paid' ? 600 : 1000);
        const n = kind === 'paid' ? 2 : 1;
        booked[kind] = await request('/event-bookings/event/' + paid._id, { token, method: 'POST', status: 201,
            body: { ...person(n), noOfPersons: 2, participants: [person(n), person(n + 100)], amount: 1, totalAmount: 1 } });
        assert.equal(booked[kind].totalAmount, page.amount * 2, 'posted amounts never override server pricing');
        const saved = await Booking.findOne({ bookingRef: booked[kind].bookingRef }).lean();
        assert.equal(saved.userId, members[kind].id, 'member booking belongs to signed-in account');
        assert.equal(booked[kind].isGuest, false);
        const auth = await request('/event-bookings/' + booked[kind].bookingRef + '/authorize', { method: 'POST', body: {} });
        const receipt = await request('/event-bookings/' + booked[kind].bookingRef + '/pay', { method: 'POST', body: auth });
        assert.equal(receipt.payment.status, 'paid', 'mock-signed payment confirms the stored booking');
        const freeBooking = await request('/event-bookings/event/' + free._id, { token, method: 'POST', status: 201, body: person(n) });
        assert.equal(freeBooking.payment.status, 'not_required');
        const mine = await request('/events/my-registrations', { token });
        assert(JSON.stringify(mine).includes(booked[kind].bookingRef), 'member history includes its public booking flow');
        await request('/event-bookings/event/' + ended._id, { token, method: 'POST', body: person(n), status: 400 });
    }
    const deniedFilter = await request('/events?audience=paid', { token: members.unpaid.token });
    assert.equal(deniedFilter.events.length, 0, 'query filters cannot grant paid membership');
    await request('/event-bookings/event/' + restricted._id, { token: members.unpaid.token, status: 403 });
    await request('/event-bookings/event/' + restricted._id, { token: '', status: 404 });
    await request('/event-bookings/event/' + targeted._id, { token: members.paid.token, status: 404 });

    const firstFreeBooking = await Booking.findOne({ eventId: free._id, userId: members.unpaid.id }).lean();
    const freeBookingCount = await Booking.countDocuments({ eventId: free._id });
    const repeated = await request('/event-bookings/event/' + free._id,
        { token: members.unpaid.token, method: 'POST', body: person(1), status: 201 });
    assert.equal(repeated.duplicate, true, 'an immediate identical retry returns the existing booking');
    assert.equal(repeated.bookingRef, firstFreeBooking.bookingRef);
    assert.equal(await Booking.countDocuments({ eventId: free._id }), freeBookingCount, 'retry never reserves another seat');
    await Booking.collection.updateOne({ _id: firstFreeBooking._id }, { $set: { createdAt: new Date(Date.now() - 31000) } });
    await request('/event-bookings/event/' + free._id, { token: members.unpaid.token, method: 'POST', body: person(1), status: 409 });
    await Event.updateOne({ _id: free._id }, { $set: { capacity: 2 } });
    const waiting = await request('/event-bookings/event/' + free._id, { token: '', method: 'POST', status: 201, body: person(5) });
    assert.equal(waiting.status, 'waitlist');
    assert.equal(waiting.payment.status, 'not_required', 'a full event cannot charge its waitlist');
    const cancelled = await Booking.findOne({ eventId: free._id, userId: members.unpaid.id }).lean();
    await request('/events/' + free._id + '/bookings/' + cancelled.bookingRef + '/cancel', { method: 'POST', body: { reason: 'Local cancellation check' } });
    const afterCancel = await Booking.findOne({ bookingRef: cancelled.bookingRef }).lean();
    assert.equal(afterCancel.status, 'cancelled');
    assert.deepEqual(afterCancel.bookedBy, cancelled.bookedBy, 'cancellation retains contact details');
    assert.equal(await bookingService.countSeats(free._id), 1, 'cancellation frees only its occupied seat');
    await Event.updateOne({ _id: free._id }, { $set: { registrationDeadline: new Date(Date.now() - 1000) } });
    const closed = await request('/event-bookings/event/' + free._id, { token: members.paid.token });
    assert.equal(closed.closed, true, 'both clients receive the server deadline decision');
    await request('/event-bookings/event/' + free._id, { token: members.paid.token, method: 'POST', body: person(6), status: 400 });

    const cmsBooking = await request('/event-bookings/event/' + cmsRemoved._id, { token: '', method: 'POST', status: 201, body: person(3) });
    const missingBooking = await request('/event-bookings/event/' + missing._id, { token: members.unpaid.token, method: 'POST', status: 201, body: person(4) });
    const stored = await Booking.findOne({ bookingRef: booked.paid.bookingRef }).lean();
    await Registration.collection.insertOne({ eventId: paid._id, userId: members.paid.id, memberName: 'Legacy registrant',
        email: 'legacy@example.test', phone: '9000000099', status: 'registered', payment: { status: 'paid', amount: 600 } });
    await Checkin.collection.insertOne({ eventId: paid._id, bookingId: stored._id, participantIndex: 0, attendeeEmail: stored.bookedBy.email });
    await Payment.collection.insertOne({ orderId: 'local-receipt', eventId: paid._id, bookingRef: stored.bookingRef, amount: 1200, status: 'paid', orderType: 'event_booking' });
    const snapshot = async () => Promise.all([Booking, Registration, Checkin, Payment].map(model =>
        model.collection.find({}).sort({ _id: 1 }).toArray().then(rows => JSON.stringify(rows))));
    const before = await snapshot();
    let overview = await request('/events/bookings/overview');
    assert.equal(overview.events.find(e => e.id === String(paid._id)).historyCategory, 'current');
    await Event.updateOne({ _id: paid._id }, { $set: { endAt: new Date(Date.now() - 1000) } });
    overview = await request('/events/bookings/overview');
    assert.equal(overview.events.find(e => e.id === String(paid._id)).historyCategory, 'past', 'completion changes history category automatically');
    await request('/cms/events/' + paid._id + '?scope=public', { token: '', status: 404 });
    assert.deepEqual(await snapshot(), before, 'completion does not change stored booking details');
    await request('/events/' + paid._id, { method: 'DELETE' });
    await request('/cms/events/' + cmsRemoved._id, { method: 'DELETE' });
    await request('/events/' + paid._id, { method: 'DELETE' }); // idempotent
    await request('/events/' + paid._id + '/bookings/' + stored.bookingRef, { method: 'DELETE', status: 409 });
    assert.deepEqual(await snapshot(), before, 'both deletion routes leave bookings, payments, registration and attendance byte-for-byte unchanged');
    assert.equal(eventChanges.length, 2, 'both event deletion routes still dispatch cancellation updates once');
    // Simulate a record deleted by a legacy release, in this disposable DB only.
    await Event.collection.deleteOne({ _id: missing._id });
    overview = await request('/events/bookings/overview');
    for (const item of [paid, cmsRemoved, missing]) {
        assert.equal(overview.events.find(e => e.id === String(item._id)).historyCategory, 'deleted');
        const rows = await request('/events/' + item._id + '/bookings');
        assert(rows.bookings.length > 0);
        assert(rows.bookings.every(row => row.bookedBy.email.endsWith('@example.test')));
        const report = await request('/events/' + item._id + '/bookings/export?format=xlsx&encoding=base64');
        assert(report.base64.startsWith('UEs'), 'retained details still export as Excel');
        await request('/events/' + item._id, { token: members.paid.token, status: 404 });
        await request('/cms/events/' + item._id, { token: '', status: 404 });
        await request('/event-bookings/event/' + item._id, { token: members.unpaid.token, status: 404 });
    }
    assert.equal(overview.historyTotals.deleted.events, 3);
    assert.equal(overview.historyTotals.past.events, 1);
    assert.equal(overview.historyTotals.current.events, 4);
    assert.equal(overview.events.find(e => e.id === String(missing._id)).bookingHistoryOnly, true);
    await request('/payment/create-request', { token: '', method: 'POST', status: 409,
        body: { orderType: 'event_booking', bookingRef: missingBooking.bookingRef } });
    const retained = await request('/events/' + cmsRemoved._id + '/bookings/' + cmsBooking.bookingRef);
    assert.equal(retained.bookedBy.email, 'contact3@example.test');
    assert.deepEqual(await snapshot(), before, 'history reads and exports cannot mutate records');
    assert.equal(await Event.countDocuments({ _id: missing._id }), 0, 'history never recreates deleted events');
    assert(notifications.length > 0, 'booking notices were captured locally');
    const completeEvent = await event('All participants required', { capacity: 60, maxPerBooking: 10 });
    for (const [offset, token] of [[300, ''], [400, members.unpaid.token], [500, members.paid.token]]) {
        const beforeCount = await Booking.countDocuments({ eventId: completeEvent._id });
        const beforePayments = await Payment.countDocuments();
        await request('/event-bookings/event/' + completeEvent._id, { token, method: 'POST', status: 400,
            body: { ...person(offset), noOfPersons: 10, participants: [person(offset)] } });
        assert.equal(await Booking.countDocuments({ eventId: completeEvent._id }), beforeCount);
        assert.equal(await Payment.countDocuments(), beforePayments, 'missing attendees never start payment');
        const completed = await request('/event-bookings/event/' + completeEvent._id, { token, method: 'POST', status: 201,
            body: { ...person(offset), noOfPersons: 10, participants: [{}, ...Array.from({ length: 9 }, (_, i) => person(offset + i + 1))] } });
        assert.equal(completed.participants.length, 10);
        assert(completed.participants.every(p => p.name && p.email && p.phone));
        assert.equal(completed.participants[0].email, person(offset).email);
    }
    const fullExport = await request('/events/' + completeEvent._id + '/bookings/export?format=xlsx&encoding=base64');
    const workbook = new (require('exceljs').Workbook)();
    await workbook.xlsx.load(Buffer.from(fullExport.base64, 'base64'));
    const people = workbook.getWorksheet('Participants');
    const { HEADER_ROW } = require('../src/core/utils/spreadsheet');
    assert.equal(people.rowCount - HEADER_ROW, 30, 'three complete ten-person bookings export exactly thirty contacts');
    for (let i = HEADER_ROW + 1; i <= people.rowCount; i++) {
        for (const column of [4, 5, 6]) assert(people.getRow(i).getCell(column).value, 'name, phone and email must be present');
    }
    console.log('PASS: ' + checks + ' real API requests; paid/unpaid eligibility and prices, free/paid checkout, member history, date transitions, both delete routes, unchanged retained records, exports and missing-event payment protection.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
    // The application owns background cache timers; the disposable test is done.
    process.exit(process.exitCode || 0);
});
