// Isolated workflow fixtures. No database connection, email, WhatsApp or HTTP.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const changes = require('../src/modules/events/eventChanges.service');
const Booking = require('../src/modules/events/eventbooking.model');
const Registration = require('../src/modules/events/eventregistration.model');
const Event = require('../src/modules/events/event.model');
const notifications = require('../src/modules/notifications/notification.service');
const bookings = require('../src/modules/events/eventbooking.service');
const audit = require('../src/modules/audit/audit.service');
const clone = value => structuredClone(value);
const id = () => new mongoose.Types.ObjectId().toString();
const now = Date.now();
const event = { _id: id(), title: 'ACTIV workshop', status: 'published',
    startAt: new Date(now + 86400000 * 3), endAt: new Date(now + 86400000 * 3 + 3600000),
    updatedAt: new Date(now - 3600000), venue: 'Community hall', mode: 'offline', days: [] };
const updated = { ...event, startAt: new Date(now + 86400000 * 4),
    endAt: new Date(now + 86400000 * 4 + 3600000), updatedAt: new Date(now) };
const past = { ...event, startAt: new Date(now - 86400000 * 2), endAt: new Date(now - 86400000) };
const claimCalls = [];
const bookingMessages = [];
const legacyMessages = [];
const query = value => ({ lean: async () => value, select() { return this; }, sort() { return this; } });
const field = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(value => matches(row, value));
    const actual = field(row, key);
    if (expected == null) return actual == null;
    if (expected && typeof expected === 'object') {
        if ('$in' in expected) return expected.$in.includes(actual);
        if ('$ne' in expected) return Array.isArray(actual) ? !actual.includes(expected.$ne) : actual !== expected.$ne;
    }
    return String(actual) === String(expected);
});
let bookingRows = [], legacyRows = [];
for (const [Model, rows] of [[Booking, () => bookingRows], [Registration, () => legacyRows]]) {
    const update = (filter, patch) => {
        const row = rows().find(value => matches(value, filter));
        claimCalls.push({ filter: clone(filter), patch: clone(patch) });
        if (!row) return null;
        if (patch.$addToSet) for (const [key, value] of Object.entries(patch.$addToSet)) {
            row[key] ||= [];
            if (!row[key].includes(value)) row[key].push(value);
        }
        for (const [key, value] of Object.entries(patch.$set || {})) {
            const parts = key.split('.');
            const final = parts.pop();
            let target = row;
            for (const part of parts) { target[part] ||= {}; target = target[part]; }
            target[final] = value;
        }
        return clone(row);
    };
    Model.findOneAndUpdate = (filter, patch) => query(update(filter, patch));
    Model.updateOne = async (filter, patch) => ({ modifiedCount: update(filter, patch) ? 1 : 0 });
    Model.deleteMany = async () => { throw new Error('Changes must never delete event history'); };
}
bookings.announce = async (row, kind, extra) => { bookingMessages.push({ row, kind, extra }); return { success: true }; };
notifications.dispatchLifecycleEvent = async (type, recipient, payload) => {
    legacyMessages.push({ type, recipient, payload }); return { channels: { email: { success: true }, whatsapp: { success: true } } };
};
audit.record = async () => {};
const makeBooking = (status, payment, extra = {}) => ({ _id: id(), eventId: event._id, status, payment: { status: payment },
    bookingRef: `REF-${status}-${payment}`, bookedBy: { email: 'booker@example.test', phone: '+919000000001' }, ...extra });
const makeLegacy = (status, payment, extra = {}) => ({ _id: id(), userId: id(), eventId: event._id, status,
    payment: { status: payment }, registeredAt: new Date(now - 1000), memberName: 'Test attendee',
    email: 'attendee@example.test', phone: '+919000000002', ...extra });

async function main() {
    assert.equal(changes.describeChange(event, { ...event, description: 'New copy', bannerUrl: '/another.png', registrationFee: 200 }), null);
    assert.equal(changes.describeChange(event, { ...event, venue: ' Community hall ', startAt: event.startAt.toISOString() }), null);
    assert.equal(changes.describeChange({ ...event, status: 'draft' }, updated), null);
    assert.equal(changes.describeChange(event, { ...updated, status: 'draft' }), null);
    assert.equal(changes.describeChange(past, { ...past, archivedAt: new Date() }), null);
    assert.equal(changes.describeChange(past, updated), null, 'old history is not mass-notified after editing');
    assert.equal(changes.describeChange(event, updated).kind, 'updated');
    assert.match(changes.describeChange(event, { ...event, days: [{ date: event.startAt, startTime: '09:30', endTime: '11:00' }] }).changeSummary, /date or time/);
    const joinChange = changes.describeChange(event, { ...event, mode: 'online', onlineUrl: 'https://example.test/private-join' });
    assert.match(joinChange.changeSummary, /format/);
    assert(!joinChange.changeSummary.includes('private-join'), 'summary never leaks the joining URL to waitlisted people');

    bookingRows = [makeBooking('active', 'paid'), makeBooking('active', 'not_required'), makeBooking('waitlist', 'not_required'),
        makeBooking('active', 'pending'), makeBooking('expired', 'failed'), makeBooking('cancelled', 'paid'),
        makeBooking('active', 'paid', { deletedAt: new Date() })];
    legacyRows = [makeLegacy('registered', 'paid'), makeLegacy('registered', 'not_required'), makeLegacy('waitlist', 'not_required'),
        makeLegacy('registered', 'pending'), makeLegacy('cancelled', 'paid')];
    const historyBefore = JSON.stringify([...bookingRows, ...legacyRows].map(({ eventChangesSent, ...row }) => row));
    const first = await changes.notifyEventChange(event, updated);
    assert.equal(first.notified, 6);
    assert.equal(bookingMessages.length, 3);
    assert.equal(legacyMessages.length, 3);
    assert(bookingMessages.every(value => value.kind === 'updated' && value.extra.eventSnapshot === updated));
    assert(legacyMessages.every(value => value.type === 'EVENT_UPDATED' && value.payload.contactEmail === 'events@activ.org.in'));
    assert.equal((await changes.notifyEventChange(event, updated)).notified, 0, 'same saved revision sends once');
    assert.equal(JSON.stringify([...bookingRows, ...legacyRows].map(({ eventChangesSent, ...row }) => row)), historyBefore,
        'claims leave payment state, receipts, attendee details and history untouched');

    const archived = { ...updated, archivedAt: new Date(now + 1000), status: 'draft', updatedAt: new Date(now + 1000) };
    assert.equal((await changes.notifyEventChange(updated, archived)).notified, 6);
    assert.equal(bookingMessages.at(-1).kind, 'event_cancelled');
    assert.equal(bookingMessages.at(-1).extra.cancelledScope, 'event');
    assert(!/refund.*(processed|sent|completed)/i.test(bookingMessages.at(-1).extra.reason));
    assert.equal((await changes.notifyEventChange(updated, archived)).notified, 0, 'repeat archive notification is deduplicated');

    legacyRows = [makeLegacy('registered', 'pending'), makeLegacy('waitlist', 'not_required'), makeLegacy('registered', 'paid')];
    legacyMessages.length = 0;
    assert.equal((await changes.announceRegistration(legacyRows[0], event)).skipped, true);
    await changes.announceRegistration(legacyRows[1], event);
    await changes.announceRegistration(legacyRows[2], event);
    assert.deepEqual(legacyMessages.map(value => value.type), ['EVENT_BOOKING_WAITLISTED', 'EVENT_REGISTERED']);
    await changes.announceRegistration(legacyRows[2], event);
    assert.equal(legacyMessages.length, 2, 'same registration confirmation is not repeated');
    const online = { ...event, mode: 'online', onlineUrl: 'https://example.test/secret-join' };
    assert.equal(changes.registrationContext(legacyRows[1], online).registerUrl, '');
    assert.equal(changes.registrationContext(legacyRows[2], online).registerUrl, online.onlineUrl);
    legacyRows[2].status = 'cancelled'; legacyRows[2].cancelledAt = new Date();
    await changes.announceRegistration(legacyRows[2], event, 'cancelled', { reason: 'Cancelled by member' });
    assert.equal(legacyMessages.at(-1).type, 'EVENT_CANCELLED');
    assert.equal(legacyMessages.at(-1).payload.cancelledScope, 'registration');
    assert.equal((await changes.announceRegistration(legacyRows[2], event, 'confirmed')).skipped, true);

    // Exercise the actual older API service, not just its message renderer.
    const legacyService = require('../src/modules/events/event.service');
    let liveEvent = { ...event, id: event._id, registrationEnabled: true, registrationFee: 100,
        capacity: 10, registeredCount: 0 };
    legacyService.getEvent = async () => liveEvent;
    Event.findById = () => query(liveEvent);
    Registration.findOne = filter => query(legacyRows.find(row => matches(row, filter)) || null);
    Registration.findById = rowId => query(legacyRows.find(row => row._id === String(rowId)) || null);
    Registration.create = async data => {
        const row = { _id: id(), ...clone(data) }; legacyRows.push(row);
        return { ...row, toObject: () => clone(row) };
    };
    Registration.countDocuments = async filter => legacyRows.filter(row => matches(row, filter)).length;
    require('../src/modules/common/memberContext').resolveMemberContext = async () => ({ isPaid: false });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    legacyRows = []; legacyMessages.length = 0;
    const firstMember = { id: id(), fullName: 'First attendee', email: 'first@example.test', phoneNumber: '+919000000003' };
    const held = await legacyService.register(event._id, firstMember, {});
    await settle();
    assert.equal(held.payment.status, 'pending');
    assert.equal(legacyMessages.length, 0, 'paid event registration cannot announce confirmation before payment');
    assert.equal(legacyRows[0].phone, firstMember.phoneNumber);
    await legacyService.payRegistration(event._id, firstMember, {});
    await settle();
    assert.equal(legacyMessages.at(-1).type, 'EVENT_REGISTERED');
    const countAfterPayment = legacyMessages.length;
    assert.equal((await legacyService.payRegistration(event._id, firstMember, {})).alreadyPaid, true);
    await settle();
    assert.equal(legacyMessages.length, countAfterPayment);

    liveEvent = { ...liveEvent, capacity: 1, registeredCount: 1 };
    const waitingMember = { id: id(), fullName: 'Waitlisted attendee', email: 'waiting@example.test', phoneNumber: '+919000000004' };
    const waitlisted = await legacyService.register(event._id, waitingMember, {});
    await settle();
    assert.equal(waitlisted.status, 'waitlist');
    assert.equal(legacyMessages.at(-1).type, 'EVENT_BOOKING_WAITLISTED');
    await legacyService.cancelRegistration(event._id, firstMember);
    await settle();
    assert(legacyMessages.some(value => value.type === 'EVENT_CANCELLED' && value.payload.cancelledScope === 'registration'));
    const promoted = legacyRows.find(row => row.userId === waitingMember.id);
    assert.equal(promoted.status, 'registered');
    assert.equal(promoted.payment.status, 'pending', 'waitlist promotion does not give a paid event away');
    assert.equal(promoted.payment.amount, 100);
    assert.equal(legacyMessages.at(-1).type, 'EVENT_UPDATED');
    assert.equal(legacyMessages.at(-1).payload.bookingStatus, 'pending');
    assert.match(legacyMessages.at(-1).payload.changeSummary, /payment/);
    const countAfterCancel = legacyMessages.length;
    await legacyService.cancelRegistration(event._id, firstMember);
    await settle();
    assert.equal(legacyMessages.length, countAfterCancel, 'repeat cancel cannot promote or notify another person');

    const savedAnnounce = changes.announceChange;
    const archiveCalls = [];
    changes.announceChange = (before, after) => { archiveCalls.push({ before, after }); return Promise.resolve(); };
    let alreadyArchived = false;
    Event.findOneAndUpdate = (filter, patch, options) => {
        assert.equal(options.new, false, 'archive captures its real previous state atomically');
        assert.equal(patch.$set.registrationEnabled, false);
        const result = alreadyArchived ? null : clone(event);
        alreadyArchived = true;
        return query(result);
    };
    Event.findById = () => query({ _id: event._id, archivedAt: new Date() });
    const archiveEvent = require('../src/modules/events/archiveEvent');
    assert.equal((await archiveEvent(event._id, { role: 'super_admin' })).historyRetained, true);
    assert.equal((await archiveEvent(event._id, { role: 'super_admin' })).archived, true);
    assert.equal(archiveCalls.length, 1, 'repeat archive endpoint does not notify twice');
    assert.equal(archiveCalls[0].before.archivedAt, undefined);
    assert(archiveCalls[0].after.archivedAt);
    changes.announceChange = savedAnnounce;
    assert(claimCalls.every(call => !call.patch.$unset), 'no recipient or history fields removed');
    console.log('PASS: event revisions, future withdrawals, eligible recipients, repeated/concurrent-safe row claims, legacy paid/waitlisted/cancelled wording and unchanged booking/payment history.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
