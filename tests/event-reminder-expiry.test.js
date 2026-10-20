// Offline regression fixtures: models and providers are stubbed, with a fixed
// IST clock reproducing a reminder attempted after a 10 October event.
Object.assign(process.env, { NODE_ENV: 'test', EVENT_REMINDERS_ENABLED: 'false',
    NOTIFICATION_WORKER_ENABLED: 'false', EVENT_REMINDER_DEFAULT_HOURS: '24' });
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Event = require('../src/modules/events/event.model');
const Booking = require('../src/modules/events/eventbooking.model');
const service = require('../src/modules/events/eventbooking.service');
const notifications = require('../src/modules/notifications/notification.service');
const retry = require('../src/modules/notifications/deliveryRetryPolicy');
const { reminderReason } = require('../src/modules/events/eventReminder');
const realNow = Date.now;
const clock = Date.parse('2026-10-11T10:00:00+05:30');
let now = clock;
Date.now = () => now;
const future = { _id: '111111111111111111111111', title: 'Future workshop', status: 'published', mode: 'online',
    startAt: new Date('2026-10-12T10:00:00+05:30'), endAt: new Date('2026-10-12T17:00:00+05:30'), reminderOffsetsHours: [24] };
const booking = { _id: '222222222222222222222222', bookingRef: 'LOCAL-REMINDER', eventId: future._id,
    status: 'active', payment: { status: 'not_required' }, createdAt: new Date('2026-10-10T09:00:00+05:30'),
    bookedBy: { name: 'Booker', email: 'booker@example.test', phone: '9123456789' },
    participants: [{ name: 'Attendee', email: 'attendee@example.test', phone: '9123456790' }] };
let event = structuredClone(future), sends = [];
const query = value => ({ lean: async () => structuredClone(value) });
Event.findById = () => query(event);
Booking.findOne = () => query(booking);
notifications.dispatchLifecycleEvent = async (name, target, payload) => {
    sends.push({ name, target, payload });
    return { channels: { email: { success: true }, whatsapp: { success: true } }, rows: {} };
};
const extra = { reminderHours: 24, reminderEventStartAt: future.startAt.toISOString() };
const log = (name = 'EVENT_BOOKING_REMINDER', channel = 'email') => ({ event: name, channel,
    recipient: channel === 'email' ? booking.bookedBy.email : booking.bookedBy.phone,
    bookingRef: booking.bookingRef, eventId: future._id, status: 'failed', deliveryStatus: 'failed',
    createdAt: new Date(clock), data: { lifecycleData: { bookingRef: booking.bookingRef, eventId: future._id, ...extra } } });

async function main() {
    await service.announce(booking, 'reminder', extra);
    assert.equal(sends.length, 2, 'A due reminder reaches the booker and participant');
    for (const sent of sends) {
        assert.equal(sent.payload.data.reminderEventStartAt, extra.reminderEventStartAt);
        assert.equal(sent.payload.data.reminderHours, 24);
        assert.equal(await service.reasonToSkipQueuedNotification(sent.name, sent.target, sent.payload), '');
    }
    assert.equal(await retry.logReason(log()), '');
    assert.equal((await service.resendLoggedMessage(log())).outcome.success, true);

    const originals = sends.slice(0, 2);
    const cases = [
        ['past event reported on 11 October', { startAt: new Date('2026-10-10T09:00:00+05:30'), endAt: new Date('2026-10-10T17:00:00+05:30') }],
        ['already started, still running', { startAt: new Date(clock), endAt: new Date(clock + 3600000) }],
        ['archived', { archivedAt: new Date(clock) }],
        ['unpublished', { status: 'draft' }],
        ['history only', { bookingHistoryOnly: true }],
        ['missing start', { startAt: null }],
        ['rescheduled into a different due window', { startAt: new Date(+future.startAt - 3600000) }],
        ['rescheduled beyond the due window', { startAt: new Date(+future.startAt + 3600000) }],
        ['offset removed', { reminderOffsetsHours: [2] }],
        ['inconsistent past end', { endAt: new Date(clock - 1) }],
    ];
    for (const [label, patch] of cases) {
        event = { ...structuredClone(future), ...patch };
        const before = sends.length;
        assert((await service.announce(booking, 'reminder', extra)).skipped, label);
        for (const sent of originals) assert(await service.reasonToSkipQueuedNotification(sent.name, sent.target, sent.payload), label);
        for (const name of ['EVENT_BOOKING_REMINDER', 'EVENT_PARTICIPANT_REMINDER', 'EVENT_DOCUMENT_REMINDER', 'EVENT_CHANNEL_REMINDER']) {
            const row = log(name);
            assert((await service.resendLoggedMessage(row)).skipped, `${label}: ${name} resend`);
            assert(await retry.logReason(row), `${label}: ${name} report retry`);
        }
        assert.equal(sends.length, before, `${label}: no provider dispatch`);
    }
    event = structuredClone(future);
    for (const patch of [null, { archivedAt: new Date(clock) }, { status: 'draft' },
        { startAt: new Date('2026-10-10T09:00:00+05:30'), endAt: new Date('2026-10-10T17:00:00+05:30') }]) {
        event = patch === null ? null : { ...structuredClone(future), ...patch };
        const before = sends.length;
        for (const name of ['EVENT_BOOKING_CONFIRMED', 'EVENT_PARTICIPANT_CONFIRMED', 'EVENT_DOCUMENT_CONFIRMED', 'EVENT_CHANNEL_CONFIRMED']) {
            assert((await service.resendLoggedMessage(log(name))).skipped, `${name}: an old attendance confirmation cannot be replayed`);
        }
        assert.equal(sends.length, before);
    }
    event = structuredClone(future);
    const unknown = log(); unknown.data = {};
    assert((await service.resendLoggedMessage(unknown)).skipped, 'Old reminders without a verifiable original window cannot replay');
    assert(await retry.logReason(unknown));
    assert(await service.reasonToSkipQueuedNotification(originals[0].name, originals[0].target,
        { ...originals[0].payload, data: { bookingRef: booking.bookingRef } }));
    assert(reminderReason(event, extra, new Date(clock)), 'Booking at the due time has just received its confirmation');
    now = +future.startAt - 1;
    assert.equal(reminderReason(event, extra, booking.createdAt), '', 'Last instant before start is valid');
    now += 1;
    assert.match(reminderReason(event, extra, booking.createdAt), /already started/);
    console.log('PASS event reminder expiry: future booker/participant sends, metadata, exact start boundary, 11 October historical-event replay, moved/archived/draft/invalid events, queue and report/manual/document/channel retry guards. No external sends.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = realNow; });
