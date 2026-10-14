// Isolated fixtures: no database connection, email, WhatsApp or HTTP calls.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const changes = require('../src/modules/events/eventChanges.service');
const Booking = require('../src/modules/events/eventbooking.model');
const Registration = require('../src/modules/events/eventregistration.model');
const Event = require('../src/modules/events/event.model');
const Member = require('../src/modules/members/memberdetails.model');
const clone = value => structuredClone(value);
const id = () => new mongoose.Types.ObjectId().toString();
const now = Date.now();
const initialEvent = { _id: id(), status: 'published', title: 'ACTIV workshop',
    startAt: new Date(now + 86400000 * 3), endAt: new Date(now + 86400000 * 3 + 3600000),
    updatedAt: new Date(now - 1000), venue: 'Original hall', mode: 'offline', days: [] };
const savedEvent = { ...initialEvent, venue: 'New hall', updatedAt: new Date(now) };
const changeId = changes.eventChangeKey(initialEvent, savedEvent, { kind: 'updated' });
const snapshotKey = value => crypto.createHash('sha256').update(JSON.stringify(changes.attendanceDetails(value))).digest('hex');
const baseBooking = { _id: id(), eventId: initialEvent._id, bookingRef: 'EVT-TEST-001', userId: '',
    status: 'active', payment: { status: 'paid' }, eventChangesSent: [changeId],
    bookedBy: { name: 'Booker', email: 'booker@example.test', phone: '9000000001' },
    participants: [{ name: 'Attendee', email: 'attendee@example.test', phone: '9000000002' }] };
const baseMember = { _id: id(), isActive: true, membershipStatus: 'active' };
const baseRegistration = { _id: id(), eventId: initialEvent._id, userId: baseMember._id,
    memberName: 'Member', email: 'member@example.test', phone: '9000000003',
    status: 'registered', payment: { status: 'paid' }, registeredAt: new Date(now - 10000),
    eventChangesSent: [changeId] };
const baseData = { bookingRef: baseBooking.bookingRef, eventId: initialEvent._id,
    changeId, changeSnapshotKey: snapshotKey(savedEvent), bookingStatus: 'active' };
const baseLog = { event: 'EVENT_UPDATED', channel: 'email', recipient: baseBooking.bookedBy.email,
    bookingRef: baseBooking.bookingRef, eventId: initialEvent._id, data: { lifecycleData: baseData } };
let booking, registration, event, member, lookupFailure;
let checked = 0;
const query = read => ({ lean: async () => {
    if (lookupFailure) throw new Error('Offline lookup failure fixture');
    return clone(read());
} });
Booking.findOne = filter => query(() => booking?.bookingRef === filter.bookingRef ? booking : null);
Registration.findById = ref => query(() => String(registration?._id) === String(ref) ? registration : null);
Event.findById = ref => query(() => String(event?._id) === String(ref) ? event : null);
Member.findById = ref => query(() => String(member?._id) === String(ref) ? member : null);
const reset = () => {
    booking = clone(baseBooking); registration = clone(baseRegistration);
    event = clone(savedEvent); member = clone(baseMember); lookupFailure = false;
};
const logWith = (data = {}, row = {}) => ({ ...clone(baseLog), ...row,
    data: { lifecycleData: { ...clone(baseData), ...data } } });
const allowed = async row => {
    assert.equal(await changes.reasonToSkipChange(row), ''); checked += 1;
};
const skipped = async (row, reason) => {
    const result = await changes.reasonToSkipChange(row);
    assert(result, 'An obsolete or unverifiable message must be skipped');
    if (reason) assert.match(result, reason);
    checked += 1;
};
const legacyLog = (extra = {}, row = {}) => {
    const ctx = changes.registrationContext(registration, event, { changeId,
        changeSnapshotKey: snapshotKey(event), ...extra });
    return { ...clone(baseLog), recipient: registration.email, user: member?._id,
        bookingRef: '', data: { lifecycleData: ctx.data }, ...row };
};

async function main() {
    reset();
    await allowed({ event: 'ANOTHER_NOTIFICATION' });
    await allowed(logWith());
    booking.payment.status = 'not_required';
    await allowed(logWith());
    booking.status = 'waitlist';
    await allowed(logWith({ bookingStatus: 'waitlist' }));
    await skipped(logWith(), /status has changed/);
    booking.status = 'active'; booking.payment.status = 'pending';
    await skipped(logWith(), /no longer confirmed or waitlisted/);
    booking.status = 'cancelled';
    await skipped(logWith({ bookingStatus: 'cancelled' }), /no longer confirmed or waitlisted/);

    reset();
    await allowed(logWith({}, { recipient: ' BOOKER@EXAMPLE.TEST ' }));
    await allowed(logWith({}, { channel: 'whatsapp', recipient: '+91 90000 00001' }));
    await allowed(logWith({}, { channel: 'whatsapp', recipient: '00919000000001' }));
    await skipped(logWith({}, { channel: 'whatsapp', recipient: '+1 90000 00001' }), /recipient is no longer/);
    const participantLog = logWith({}, { recipient: booking.participants[0].email });
    await allowed(participantLog);
    await allowed(logWith({}, { channel: 'whatsapp', recipient: '+919000000002' }));
    booking.participants = [];
    await skipped(participantLog, /recipient is no longer/);
    booking.bookedBy.email = 'new-booker@example.test';
    await skipped(logWith(), /recipient is no longer/);

    reset();
    booking.deletedAt = new Date();
    await skipped(logWith(), /no longer exists/);
    booking = null;
    await skipped(logWith(), /no longer exists/);
    reset();
    await skipped(logWith({ eventId: id() }), /no longer matches/);
    await skipped(logWith({}, { eventId: id() }), /no longer matches/);
    event = null;
    await skipped(logWith(), /event no longer exists/);
    reset();
    event.endAt = new Date(now - 1);
    await skipped(logWith(), /already finished/);
    reset();
    event.status = 'draft';
    await skipped(logWith(), /no longer published/);
    reset();
    event.archivedAt = new Date();
    await skipped(logWith(), /no longer published/);

    reset();
    booking.userId = member._id;
    await allowed(logWith({}, { user: { _id: member._id } }));
    await skipped(logWith({}, { user: id() }), /member account/);
    member.isActive = false;
    await skipped(logWith(), /member account is no longer active/);
    member.isActive = true; member.deletedAt = new Date();
    await skipped(logWith(), /member account is no longer active/);
    member.deletedAt = null; member.membershipStatus = 'cancelled';
    await skipped(logWith(), /member account is no longer active/);
    member = null;
    await skipped(logWith(), /member account is no longer active/);

    reset();
    event.description = 'New artwork description'; event.updatedAt = new Date(now + 1000);
    await allowed(logWith());
    // A legacy lifecycle claim is not a new material event revision.
    booking.eventChangesSent.push('a'.repeat(64));
    await allowed(logWith());
    event.venue = 'Third hall';
    await skipped(logWith(), /details have changed/);
    // Changing away and then back still supersedes the original change message.
    const reverted = { ...savedEvent, updatedAt: new Date(now + 2000) };
    const newerKey = changes.eventChangeKey(event, reverted, { kind: 'updated' });
    event = clone(reverted); booking.eventChangesSent.push(newerKey);
    await skipped(logWith(), /newer event change/);
    await allowed(logWith({ changeId: newerKey }));
    // A slower worker may append an older claim later: compare revisions, not array order.
    booking.eventChangesSent.push(changeId);
    await allowed(logWith({ changeId: newerKey }));
    await skipped(logWith({ changeSnapshotKey: '' }), /details have changed/);
    await skipped(logWith({ changeId: '' }), /could not be verified/);
    await skipped(logWith({ changeId: 'unrecognised' }), /could not be verified/);

    reset();
    const archived = { ...savedEvent, archivedAt: new Date(now + 1000),
        updatedAt: new Date(now + 1000), status: 'draft' };
    const cancelledKey = changes.eventChangeKey(savedEvent, archived, { kind: 'event_cancelled' });
    booking.eventChangesSent.push(cancelledKey); event = clone(archived);
    const cancellation = logWith({ changeId: cancelledKey, cancelledScope: 'event' }, { event: 'EVENT_CANCELLED' });
    await allowed(cancellation);
    booking.status = 'waitlist';
    await allowed(logWith({ changeId: cancelledKey, cancelledScope: 'event', bookingStatus: 'waitlist' }, { event: 'EVENT_CANCELLED' }));
    booking.status = 'active'; event.archivedAt = null;
    await skipped(cancellation, /no longer withdrawn/);
    event = clone(archived); event.endAt = new Date(now - 1);
    await skipped(cancellation, /already finished/);

    reset();
    await allowed(legacyLog());
    registration.status = 'waitlist';
    await allowed(legacyLog());
    registration.payment.status = 'pending'; registration.status = 'registered';
    await skipped(legacyLog(), /no longer confirmed or waitlisted/);
    reset();
    const legacyRecipient = legacyLog();
    registration.email = 'changed@example.test';
    await skipped(legacyRecipient, /recipient is no longer/);
    registration = null;
    await skipped(legacyRecipient, /no longer exists/);
    reset(); member = null;
    await skipped(legacyLog(), /member account is no longer active/);

    reset();
    registration.status = 'cancelled'; registration.cancelledAt = new Date(now);
    registration.eventChangesSent.push('c'.repeat(64));
    const individual = legacyLog({ changeId: 'c'.repeat(64), changeScope: 'registration', cancelledScope: 'registration' }, { event: 'EVENT_CANCELLED' });
    await allowed(individual);
    registration.status = 'registered';
    await skipped(individual, /status has changed/);
    registration.status = 'cancelled'; registration.cancelledAt = new Date(now + 1000);
    await skipped(individual, /registration has changed/);

    reset();
    registration.status = 'registered'; registration.payment.status = 'pending';
    registration.eventChangesSent.push('d'.repeat(64));
    const promotion = legacyLog({ changeId: 'd'.repeat(64), changeScope: 'registration' });
    await allowed(promotion);
    registration.payment.status = 'paid';
    await skipped(promotion, /status has changed/);
    registration.payment.status = 'pending'; registration.registeredAt = new Date(now + 1000);
    await skipped(promotion, /registration has changed/);
    registration.registeredAt = clone(baseRegistration.registeredAt); event.venue = 'Another hall';
    await skipped(promotion, /details have changed/);

    reset(); lookupFailure = true;
    await skipped(logWith(), /could not be checked/);
    await skipped(logWith({}, { channel: 'in_app' }), /Only external/);
    console.log(`PASS event change retry guard (${checked} local assertions; no external sends)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
