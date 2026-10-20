// Scheduler fixtures only. No database, provider credentials or external sends.
process.env.NODE_ENV = 'test';
process.env.EVENT_LEGACY_REMINDERS_FROM = '2030-01-01T00:00:00.000Z';
process.env.EVENT_REMINDER_DEFAULT_HOURS = '24';
process.env.EVENT_REMINDERS_ENABLED = 'true';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const hour = 3600000;
const rollout = Date.parse(process.env.EVENT_LEGACY_REMINDERS_FROM);
const realNow = Date.now;
let now = rollout + 2 * hour;
Date.now = () => now;
const Event = require('../src/modules/events/event.model');
const Booking = require('../src/modules/events/eventbooking.model');
const Registration = require('../src/modules/events/eventregistration.model');
const Member = require('../src/modules/members/memberdetails.model');
const notifications = require('../src/modules/notifications/notification.service');
const changes = require('../src/modules/events/eventChanges.service');
require('../src/config/logger').silent = true;
const servicePath = require.resolve('../src/modules/events/eventbooking.service');
const loadService = () => { delete require.cache[servicePath]; return require(servicePath); };
const clone = value => structuredClone(value);
const id = () => new mongoose.Types.ObjectId().toString();
const owner = { _id: id(), isActive: true, membershipStatus: 'active' };
const event = { _id: id(), title: 'Current workshop', status: 'published', mode: 'online',
    onlinePlatform: 'Zoom', onlineUrl: 'https://example.test/current-join',
    startAt: new Date(rollout + 26 * hour), endAt: new Date(rollout + 27 * hour),
    reminderOffsetsHours: [24], venue: '', days: [] };
let events = [], bookings = [], registrations = [], members = [], sent = [], claims = [], eventScans = 0, queueKeys = new Set();
let inFlight = 0, maxInFlight = 0, pauseModern;
const field = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
const scalar = value => value instanceof Date ? +value : value;
const matches = (row, filter) => !!row && Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(clause => matches(row, clause));
    const actual = field(row, key);
    if (expected == null) return actual == null;
    if (expected instanceof RegExp) return (Array.isArray(actual) ? actual : [actual]).some(value => expected.test(String(value || '')));
    if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('$in' in expected) return expected.$in.includes(actual);
        if ('$ne' in expected) return Array.isArray(actual) ? !actual.includes(expected.$ne) : actual !== expected.$ne;
        if ('$lt' in expected) return scalar(actual) < scalar(expected.$lt);
        if ('$gt' in expected && !(scalar(actual) > scalar(expected.$gt))) return false;
        if ('$lte' in expected && !(scalar(actual) <= scalar(expected.$lte))) return false;
        return '$gt' in expected || '$lte' in expected;
    }
    return scalar(actual) === scalar(expected);
});
const query = value => ({
    select() { return this; },
    sort() { return this; },
    lean() { return this; },
    async *cursor() { for (const row of clone(value)) yield row; },
    catch: handler => Promise.resolve(clone(value)).catch(handler),
    then: (resolve, reject) => Promise.resolve(clone(value)).then(resolve, reject),
});
Event.find = filter => { eventScans++; return query(events.filter(row => matches(row, filter))); };
Event.findById = ref => query(events.find(row => row._id === String(ref)) || null);
Registration.findById = ref => query(registrations.find(row => row._id === String(ref)) || null);
Member.findById = ref => query(members.find(row => row._id === String(ref)) || null);
const update = (kind, list, filter, patch) => {
    const row = list.find(value => matches(value, filter));
    if (!row) return null;
    for (const [key, value] of Object.entries(patch.$addToSet || {})) {
        row[key] ||= [];
        if (!row[key].includes(value)) row[key].push(value);
    }
    claims.push({ kind, id: row._id, filter: clone(filter) });
    return row;
};
Booking.findOneAndUpdate = (filter, patch) => query(update('booking', bookings, filter, patch));
Booking.find = filter => query(bookings.filter(row => matches(row, filter)));
Booking.updateOne = async (filter, patch) => ({ modifiedCount: update('booking', bookings, filter, patch) ? 1 : 0 });
Registration.find = filter => query(registrations.filter(row => matches(row, filter)));
Registration.findOneAndUpdate = (filter, patch) => query(update('registration', registrations, filter, patch));
Registration.updateOne = async (filter, patch) => ({ modifiedCount: update('registration', registrations, filter, patch) ? 1 : 0 });
const deliver = async notice => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
        sent.push(clone(notice));
        if (notice.kind === 'booking' && pauseModern) await pauseModern();
        await new Promise(resolve => setImmediate(resolve));
        return { channels: { email: { success: true }, whatsapp: { success: true } } };
    } finally { inFlight--; }
};
notifications.dispatchLifecycleEvent = async (type, recipient, payload) => deliver({ kind: 'registration', type, recipient, payload });
notifications.dispatchInBackground = async (type, recipient, payload) => {
    const key = require('../src/modules/notifications/lifecycleOutbox').keyFor(type, recipient, payload);
    if (!queueKeys.has(key)) {
        queueKeys.add(key);
        await deliver({ kind: 'registration', type, recipient, payload });
    }
    return { queued: true };
};
const makeService = () => {
    const service = loadService();
    service.queueBookingReminder = async (row, extra) => {
        await deliver({ kind: 'booking', row, notice: 'reminder', extra });
        return { queued: true };
    };
    service.announce = async () => undefined;
    return service;
};
const registration = (extra = {}) => ({ _id: id(), eventId: event._id, userId: owner._id,
    memberName: 'Legacy attendee', email: 'attendee@example.test', phone: '9000000001', status: 'registered',
    registeredAt: new Date(rollout + hour), payment: { status: 'paid', paidAt: new Date(rollout + hour) }, ...extra });
const booking = (extra = {}) => ({ _id: id(), eventId: event._id, bookingRef: id(), status: 'active',
    createdAt: new Date(rollout + hour), payment: { status: 'paid' }, participants: [], ...extra });
const reset = () => {
    now = rollout + 2 * hour; events = [clone(event)]; bookings = []; registrations = []; members = [clone(owner)];
    sent = []; claims = []; eventScans = 0; inFlight = 0; maxInFlight = 0; pauseModern = null;
    queueKeys = new Set();
    process.env.EVENT_REMINDER_DEFAULT_HOURS = '24';
    process.env.EVENT_LEGACY_REMINDERS_FROM = '2030-01-01T00:00:00.000Z';
};
const logFor = notice => ({ event: notice.type, user: notice.recipient.id, channel: 'email', recipient: notice.recipient.email,
    eventId: notice.payload.data.eventId, data: { lifecycleData: clone(notice.payload.data) } });

async function main() {
    reset();
    bookings = [booking(), booking({ payment: { status: 'not_required' } })];
    registrations = [registration(), registration({ payment: { status: 'not_required' } }),
        registration({ payment: { status: 'pending' } }), registration({ status: 'waitlist' }),
        registration({ status: 'cancelled' }), registration({ registeredAt: new Date(now + 1) }),
        registration({ registeredAt: new Date(now) })];
    events[0].reminderOffsetsHours = [24, 24, -1, 200];
    const current = makeService();
    assert.equal(await current.sendDueReminders(), 4);
    assert.equal(sent.filter(item => item.kind === 'booking').length, 2);
    const legacy = sent.filter(item => item.kind === 'registration');
    assert.equal(legacy.length, 2);
    assert(legacy.every(item => item.type === 'EVENT_REMINDER' && item.payload.contactEmail === 'events@activ.org.in'));
    assert(legacy.every(item => item.payload.eventTitle === event.title && item.payload.registerUrl === event.onlineUrl));
    assert.equal(maxInFlight, 1, 'Each sweep awaits dispatch instead of overlapping background sends');
    assert.equal(await current.sendDueReminders(), 0, 'Repeated offsets and later sweeps cannot duplicate claimed reminders');
    assert(registrations.slice(2).every(row => !row.remindersSent), 'Ineligible rows are not claimed');
    const reminderLog = logFor(legacy[0]);
    assert.equal(await changes.reasonToSkipRegistrationNotice(reminderLog), '');
    registrations[0].status = 'cancelled';
    assert.match(await changes.reasonToSkipRegistrationNotice(reminderLog), /no longer holds/);
    registrations[0].status = 'registered';
    events[0].venue = 'Changed venue';
    assert.match(await changes.reasonToSkipRegistrationNotice(reminderLog), /details have changed/);
    events[0].venue = ''; events[0].reminderOffsetsHours = [2];
    assert.match(await changes.reasonToSkipRegistrationNotice(reminderLog), /window is no longer due/);
    events[0].reminderOffsetsHours = [24];
    registrations[0].email = 'different@example.test';
    assert.match(await changes.reasonToSkipRegistrationNotice(reminderLog), /recipient is no longer/);
    registrations[0].email = 'attendee@example.test'; members = [];
    assert.match(await changes.reasonToSkipRegistrationNotice(reminderLog), /member account is no longer active/);

    reset();
    const historicalWindow = { ...clone(event), _id: id(), startAt: new Date(rollout + 23 * hour) };
    events.push(historicalWindow);
    registrations = [registration(), registration({ eventId: historicalWindow._id, registeredAt: new Date(rollout - 2 * hour) })];
    now = rollout + hour;
    assert.equal(await makeService().sendDueReminders(), 0, 'No future window or pre-rollout window is newly backfilled');
    now = rollout + 2 * hour + 5 * 60000;
    assert.equal(await makeService().sendDueReminders(), 1, 'Restart retains fixed rollout boundary and recovers an unclaimed later window');
    assert.equal(sent[0].recipient.id, owner._id);
    assert.equal(registrations[1].remindersSent, undefined);
    assert.equal(await makeService().sendDueReminders(), 0, 'Restart does not erase durable reminder claims');

    reset();
    events[0].startAt = new Date(rollout + 23 * hour);
    bookings = [booking({ createdAt: new Date(rollout - 2 * hour) })];
    registrations = [registration({ registeredAt: new Date(rollout - 2 * hour) })];
    assert.equal(await makeService().sendDueReminders(), 1, 'Existing modern reminders keep their pre-rollout behavior');
    assert.equal(sent[0].kind, 'booking');

    reset();
    const variants = [
        { archivedAt: new Date(now) }, { status: 'draft' },
        { startAt: new Date(now - hour), endAt: new Date(now - 1) },
        { startAt: new Date(now + 10 * 24 * hour) },
    ].map(extra => ({ ...clone(event), _id: id(), ...extra }));
    events = variants;
    registrations = variants.map(item => registration({ eventId: item._id }));
    assert.equal(await makeService().sendDueReminders(), 0, 'Archived, draft, past and beyond-horizon events are skipped');
    assert.equal(claims.length, 0);

    reset();
    events[0].reminderOffsetsHours = [];
    events[0].startAt = new Date(rollout + 2.5 * hour);
    registrations = [registration()];
    process.env.EVENT_REMINDER_DEFAULT_HOURS = '1,0,-1,not-a-number';
    assert.equal(await makeService().sendDueReminders(), 1, 'Legacy reminders honor the same configured fallback');
    assert.equal(sent[0].payload.data.reminderHours, 1);
    reset(); process.env.EVENT_REMINDER_DEFAULT_HOURS = '0';
    events[0].reminderOffsetsHours = []; registrations = [registration()];
    assert.equal(await makeService().sendDueReminders(), 0, 'Zero fallback keeps reminders disabled for events without offsets');
    reset(); process.env.EVENT_LEGACY_REMINDERS_FROM = 'invalid'; registrations = [registration()];
    assert.equal(await makeService().sendDueReminders(), 0, 'An invalid rollout override fails closed');

    reset(); registrations = [registration()];
    const moved = makeService();
    assert.equal(await moved.sendDueReminders(), 1);
    events[0].startAt = new Date(rollout + 28 * hour); events[0].endAt = new Date(rollout + 29 * hour);
    assert.equal(await moved.sendDueReminders(), 0, 'Moving an event moves its next reminder window');
    now = rollout + 4 * hour;
    assert.equal(await moved.sendDueReminders(), 1);
    assert.equal(registrations[0].remindersSent.length, 2, 'Each rescheduled window has a distinct durable claim');

    reset(); bookings = [booking()]; registrations = [registration()];
    const shared = makeService();
    let release, started;
    const startGate = new Promise(resolve => { started = resolve; });
    const block = new Promise(resolve => { release = resolve; });
    pauseModern = async () => { started(); await block; };
    const first = shared.sendDueReminders(); await startGate;
    const overlap = shared.sendDueReminders(); release();
    assert.deepEqual(await Promise.all([first, overlap]), [2, 2]);
    assert.equal(eventScans, 1, 'Overlapping jobs share one active sweep');
    assert.equal(sent.length, 2);
    reset(); registrations = [registration()];
    const workers = [makeService(), makeService()];
    assert.equal((await Promise.all(workers.map(worker => worker.sendDueReminders()))).reduce((sum, count) => sum + count, 0), 1);
    assert.equal(sent.length, 1, 'Atomic legacy claim prevents duplicate reminders across workers');

    reset(); bookings = [booking(), booking()]; registrations = [registration()];
    const slow = makeService();
    pauseModern = async () => { now = +events[0].startAt; };
    assert.equal(await slow.sendDueReminders(), 1, 'A slow sweep stops as soon as the event starts');
    assert.equal(claims.length, 1, 'No additional modern or legacy reminders are claimed after start');
    reset(); events[0].endAt = new Date(now - 1); bookings = [booking()]; registrations = [registration()];
    assert.equal(await makeService().sendDueReminders(), 0, 'An inconsistent future start cannot revive an already finished event');
    assert.equal(claims.length, 0);

    reset(); registrations = [registration()];
    const timed = makeService(), timers = [];
    const originalInterval = global.setInterval, originalTimeout = global.setTimeout;
    try {
        global.setInterval = (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; };
        global.setTimeout = (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; };
        timed.startReminderScheduler(); timed.startReminderScheduler();
        assert.equal(timers.length, 2, 'Timer setup is idempotent');
        assert.equal(timers[1].ms, 30000);
        await Promise.all(timers.map(timer => timer.fn()));
        assert.equal(sent.length, 1, 'Boot and interval ticks cannot overlap duplicate sends');
    } finally { global.setInterval = originalInterval; global.setTimeout = originalTimeout; }

    reset(); registrations = [registration()];
    await changes.announceRegistration(registrations[0], events[0]);
    const confirmation = logFor(sent[0]);
    assert.equal(await changes.reasonToSkipRegistrationNotice(confirmation), '');
    registrations[0].payment.status = 'pending';
    assert.match(await changes.reasonToSkipRegistrationNotice(confirmation), /no longer holds/);
    reset(); registrations = [registration({ status: 'waitlist' })];
    await changes.announceRegistration(registrations[0], events[0]);
    const waitlist = logFor(sent[0]);
    assert.equal(await changes.reasonToSkipRegistrationNotice(waitlist), '');
    registrations[0].status = 'registered';
    assert.match(await changes.reasonToSkipRegistrationNotice(waitlist), /no longer waitlisted/);
    console.log('PASS legacy event reminders: current/legacy paths, eligibility, fixed rollout and restart, offsets, rescheduling, atomic claims, awaited/coalesced/timed jobs and stale-notice guards.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = realNow; });
