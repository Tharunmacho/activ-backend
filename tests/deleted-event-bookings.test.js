// Isolated history fixtures: no database connection, writes or notifications.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
require('../src/modules/admin/admin.repository').findActive = async () => [];
const Event = require('../src/modules/events/event.model');
const Booking = require('../src/modules/events/eventbooking.model');
const Registration = require('../src/modules/events/eventregistration.model');
const service = require('../src/modules/events/eventbooking.service');
const deletedId = new mongoose.Types.ObjectId();
const snapshot = { _id: deletedId, title: 'Deleted workshop', startAt: new Date('2026-10-04'), venue: 'Online' };
const booking = { _id: new mongoose.Types.ObjectId(), eventId: deletedId, bookingRef: 'ACTIVB-HISTORY-1', eventTitle: snapshot.title, eventStartAt: snapshot.startAt, status: 'active', noOfPersons: 1, totalAmount: 500, payment: { status: 'paid', mode: 'online' }, bookedBy: { name: 'History Contact', email: 'history@example.test', phone: '+919876543210' }, participants: [{ name: 'Attendee', email: 'attendee@example.test', phone: '+919000000000' }] };
const query = value => ({ sort() { return this; }, select() { return this; }, limit() { return this; }, skip() { return this; }, lean: async () => value });
let currentEvents = [];
Event.find = filter => {
    if (filter.$or) assert(filter.$or.some(clause => clause._id?.$in.some(id => String(id) === String(deletedId))), 'events with bookings remain eligible even when unpublished');
    return query(currentEvents);
};
Event.findById = () => query(null);
Event.collection.findOne = async () => null;
const failWrite = () => { throw new Error('History retrieval must never write or restore events'); };
for (const model of [Event, Booking, Registration]) {
    for (const method of ['create', 'insertMany', 'updateOne', 'deleteMany', 'findOneAndUpdate']) model[method] = failWrite;
    for (const method of ['insertOne', 'updateOne', 'deleteMany', 'replaceOne']) model.collection[method] = failWrite;
}
Booking.collection.aggregate = pipeline => {
    assert.equal(pipeline.find(stage => stage.$lookup).$lookup.from, Event.collection.name);
    assert.deepEqual(pipeline.find(stage => stage.$match?.event).$match.event, { $eq: [] });
    return { toArray: async () => [snapshot] };
};
Booking.find = () => query([booking]);
Booking.countDocuments = async () => 1;
Booking.aggregate = async pipeline => pipeline[0]?.$match?.eventId?.$in
    ? [{ _id: deletedId, bookings: 1, seats: 1, collected: 500, paidBookings: 1 }]
    : [{ _id: { pay: 'paid', live: true, admissible: true }, bookings: 1, seats: 1, amount: 500 }];
Booking.collection.find = () => ({ sort() { return this; }, toArray: async () => [booking] });
Registration.aggregate = async () => [];
Booking.distinct = async () => [deletedId];
Registration.distinct = async () => [];
service.sweepExpiredHolds = async () => {};

async function main() {
    const before = JSON.stringify(booking);
    const overview = await service.bookingOverview();
    assert.equal(overview.events.length, 1, 'history appears even when no event documents exist');
    assert.equal(overview.events[0].title, snapshot.title);
    assert.equal(overview.events[0].bookingHistoryOnly, true);
    assert.equal(overview.events[0].registrationEnabled, false);
    assert.equal(overview.events[0].historyCategory, 'deleted');
    assert.equal(overview.historyTotals.deleted.bookings, 1);
    assert.equal(overview.historyTotals.current.events, 0);
    assert.equal(overview.totals.bookings, 1);
    assert.equal(overview.totals.collected, 500);
    const list = await service.listBookings(String(deletedId));
    assert.equal(list.bookings[0].bookedBy.phone, booking.bookedBy.phone);
    assert.equal(list.bookings[0].participants[0].email, booking.participants[0].email);
    assert.equal((await service.listAttendees(String(deletedId))).attendees[0].name, 'Attendee');
    const csv = await service.exportBookingsCsv(String(deletedId));
    assert(csv.csv.includes('history@example.test'));
    const report = await service.exportBookingsXlsx(String(deletedId));
    assert(report, 'Excel works without the deleted event');
    assert.equal(JSON.stringify(booking), before);
    await assert.rejects(require('../src/modules/events/event.service').getEvent(String(deletedId), { role: 'super_admin', isAdmin: true }), /not found/i, 'deleted event stays deleted even for admin event management');
    currentEvents = [
        { _id: new mongoose.Types.ObjectId(), title: 'Current event', status: 'published', startAt: new Date(Date.now() + 86400000) },
        { _id: new mongoose.Types.ObjectId(), title: 'Past event', status: 'published', endAt: new Date(Date.now() - 86400000) },
    ];
    const grouped = await service.bookingOverview();
    assert.equal(grouped.events.length, 3, 'current, past and deleted history coexist');
    for (const category of ['current', 'past', 'deleted']) assert.equal(grouped.historyTotals[category].events, 1);
    assert.equal(grouped.historyTotals.deleted.collected, 500);
    assert.equal(JSON.stringify(booking), before, 'classification never modifies bookings');
    console.log('PASS: deleted-event booking list, contact details, attendees, CSV/XLSX exports, totals and no event/booking writes.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
