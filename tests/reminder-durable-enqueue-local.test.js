// Disposable loopback Mongo only. Every external delivery provider is stubbed.
const assert = require('node:assert/strict');
const path = require('node:path');
Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'false', PUSH_ENABLED: 'false',
    EVENT_REMINDERS_ENABLED: 'false', EVENT_LEGACY_REMINDERS_FROM: '2020-01-01T00:00:00.000Z',
    FRONTEND_URL: 'https://activ.example.test' });
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
let mongo;

async function main() {
    mongo = await MongoMemoryServer.create({
        binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') },
        instance: { ip: '127.0.0.1' },
    });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri());
    const Event = require('../src/modules/events/event.model');
    const Booking = require('../src/modules/events/eventbooking.model');
    const Registration = require('../src/modules/events/eventregistration.model');
    const Member = require('../src/modules/members/memberdetails.model');
    const Outbox = require('../src/modules/notifications/lifecycleOutbox.model');
    const Log = require('../src/modules/notifications/notificationLog.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const service = require('../src/modules/events/eventbooking.service');
    const worker = require('../src/modules/notifications/lifecycleOutbox');
    const progression = require('../src/modules/notifications/membershipProgression.service');
    require('../src/modules/notifications/regionalContacts.service').resolveForRegion = async () => null;
    const emails = [], whatsapps = [];
    require('../src/modules/notifications/email.service').sendEmail = async options => {
        emails.push(options); return { success: true, provider: 'smtp', messageId: `email-${emails.length}` };
    };
    require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async phone => {
        whatsapps.push(phone); return { success: true, provider: 'meta', messageId: `whatsapp-${whatsapps.length}`, to: phone };
    };
    require('../src/modules/notifications/botbee.service').sendTextMessage = async () => {
        throw new Error('No supplementary provider call is expected in this fixture');
    };
    await Promise.all([Outbox, Log, Notification].map(model => model.createIndexes()));
    const enqueue = worker.enqueue;
    const bookingUpdate = Booking.updateOne.bind(Booking);
    const registrationUpdate = Registration.updateOne.bind(Registration);
    const memberUpdate = Member.updateOne.bind(Member);
    const HOUR = 3600000;
    const now = Date.now();
    const id = () => new mongoose.Types.ObjectId();
    async function reset() {
        worker.enqueue = enqueue; Booking.updateOne = bookingUpdate;
        Registration.updateOne = registrationUpdate; Member.updateOne = memberUpdate;
        await Promise.all([Event, Booking, Registration, Member, Outbox, Log, Notification].map(model => model.deleteMany({})));
        emails.length = 0; whatsapps.length = 0;
    }
    async function event() {
        const row = { _id: id(), title: 'Reminder fixture', slug: 'reminder-fixture', status: 'published',
            mode: 'offline', startAt: new Date(now + HOUR), endAt: new Date(now + 2 * HOUR), reminderOffsetsHours: [24] };
        await Event.collection.insertOne(row); return row;
    }
    async function booking(eventRow, extra = {}) {
        const booker = { name: 'Booker', email: 'booker@example.test', phone: '9123456789' };
        const row = { _id: id(), eventId: eventRow._id, bookingRef: `FIXTURE-${id()}`.toUpperCase(), status: 'active',
            payment: { status: 'not_required' }, createdAt: new Date(now - 48 * HOUR), bookedBy: booker,
            participants: [booker, { name: 'Shared phone', email: 'shared@example.test', phone: booker.phone },
                { name: 'Guest', email: 'guest@example.test', phone: '9987654321' }], noOfPersons: 3, ...extra };
        await Booking.collection.insertOne(row); return row;
    }
    async function drain() {
        for (let index = 0; index < 20; index++) if (!await worker.processOne()) return;
        throw new Error('Fixture worker did not drain');
    }

    await reset();
    let currentEvent = await event(), currentBooking = await booking(currentEvent);
    worker.enqueue = async () => { throw new Error('Simulated enqueue outage'); };
    assert.equal(await service.runDueReminderSweep(), 0);
    assert.equal(await Outbox.countDocuments(), 0);
    assert.deepEqual((await Booking.findById(currentBooking._id)).reminderWindowsQueued, []);
    assert.equal(emails.length, 0, 'failed enqueue never consumes a reminder or contacts SMTP');

    worker.enqueue = async (name, recipient, payload) => {
        if (recipient.email === 'shared@example.test') throw new Error('Simulated partial recipient enqueue');
        return enqueue(name, recipient, payload);
    };
    assert.equal(await service.runDueReminderSweep(), 0);
    assert.equal(await Outbox.countDocuments(), 1);
    await drain();
    assert.equal(emails.length, 1, `a persisted prefix can deliver before the remaining recipients recover: ${JSON.stringify(await Outbox.findOne().select('status lastError channels').lean())}`);
    assert.deepEqual((await Booking.findById(currentBooking._id)).reminderWindowsQueued, []);
    await Event.updateOne({ _id: currentEvent._id }, { $set: { title: 'Renamed while retrying' } });
    worker.enqueue = enqueue;
    assert.equal(await service.runDueReminderSweep(), 1);
    assert.equal(await Outbox.countDocuments(), 3, 'changed text/time wording does not duplicate an accepted prefix');
    await drain();
    assert.equal(emails.length, 3); assert.equal(whatsapps.length, 2);
    assert.equal(new Set(emails.map(mail => mail.to)).size, 3, 'shared phone still receives independent email');
    assert.deepEqual((await Booking.findById(currentBooking._id)).remindersSent, [24], 'older readers retain the completed offset marker');
    assert.equal(await service.runDueReminderSweep(), 0);

    const movedStart = new Date(+currentEvent.startAt + 2 * HOUR);
    await Event.updateOne({ _id: currentEvent._id }, { $set: { startAt: movedStart, endAt: new Date(+movedStart + HOUR) } });
    assert.equal(await service.runDueReminderSweep(), 1, 'a reschedule creates a distinct window');
    await drain(); assert.equal(emails.length, 6);
    assert.equal((await Booking.findById(currentBooking._id)).reminderWindowsQueued.length, 2);

    await reset();
    currentEvent = await event(); currentBooking = await booking(currentEvent);
    Booking.updateOne = async (filter, patch) => {
        if (patch.$addToSet?.reminderWindowsQueued) throw new Error('Simulated source checkpoint interruption');
        return bookingUpdate(filter, patch);
    };
    await assert.rejects(service.runDueReminderSweep(), /checkpoint interruption/);
    assert.equal(await Outbox.countDocuments(), 3);
    await drain(); assert.equal(emails.length, 3);
    Booking.updateOne = bookingUpdate;
    assert.equal(await service.runDueReminderSweep(), 1);
    await drain(); assert.equal(emails.length, 3, 'lost checkpoint cannot replay accepted primary notices');

    await reset();
    currentEvent = await event(); currentBooking = await booking(currentEvent);
    const concurrent = await Promise.all([service.runDueReminderSweep(), service.runDueReminderSweep()]);
    assert.equal(concurrent.reduce((sum, value) => sum + value, 0), 1);
    await drain(); assert.equal(emails.length, 3); assert.equal(await Outbox.countDocuments(), 3);
    await Booking.updateOne({ _id: currentBooking._id }, { $set: { reminderWindowsQueued: [] } });
    await Event.updateOne({ _id: currentEvent._id }, { $set: { reminderOffsetsHours: [] } });
    process.env.EVENT_REMINDER_DEFAULT_HOURS = '0';
    assert.equal(await service.runDueReminderSweep(), 0, 'disabled reminder fallback never queues');
    delete process.env.EVENT_REMINDER_DEFAULT_HOURS;

    await reset();
    currentEvent = await event(); currentBooking = await booking(currentEvent, { remindersSent: [24] });
    assert.equal(await service.runDueReminderSweep(), 0, 'pre-fix numeric history is never replayed on deploy');
    assert.equal(await Outbox.countDocuments(), 0);
    await Booking.updateOne({ _id: currentBooking._id }, { $set: { remindersSent: [] } });
    assert.equal(await service.runDueReminderSweep(), 1);
    await Event.updateOne({ _id: currentEvent._id }, { $set: { startAt: new Date(now - HOUR), endAt: new Date(now - 1) } });
    await drain(); assert.equal(emails.length, 0, 'queued reminders cannot send after expiry or rescheduling');

    await reset();
    currentEvent = await event();
    const owner = { _id: id(), fullName: 'Legacy member', email: 'legacy@example.test', isActive: true, membershipStatus: 'active' };
    await Member.collection.insertOne(owner);
    const registration = { _id: id(), userId: owner._id, eventId: currentEvent._id, memberName: owner.fullName,
        email: owner.email, phone: '9123456789', registeredAt: new Date(now - 48 * HOUR), status: 'registered',
        payment: { status: 'not_required' } };
    await Registration.collection.insertOne(registration);
    worker.enqueue = async () => { throw new Error('Legacy enqueue outage'); };
    assert.equal(await service.runDueReminderSweep(), 0);
    assert.deepEqual((await Registration.findById(registration._id)).remindersSent, []);
    worker.enqueue = enqueue;
    Registration.updateOne = async (filter, patch) => {
        if (patch.$addToSet?.remindersSent) throw new Error('Legacy checkpoint interruption');
        return registrationUpdate(filter, patch);
    };
    assert.equal(await service.runDueReminderSweep(), 0);
    await drain(); assert.equal(emails.length, 1, 'legacy outbox remains valid before checkpoint');
    Registration.updateOne = registrationUpdate;
    assert.equal(await service.runDueReminderSweep(), 1);
    await drain(); assert.equal(emails.length, 1, 'legacy checkpoint recovery deduplicates');

    await reset();
    const old = { planId: 'beginner', planName: 'Beginner', minYears: 0, initializedAt: new Date(now - 86400000) };
    const member = { _id: id(), fullName: 'Progressing member', email: 'progression@example.test', isActive: true,
        membershipStatus: 'active', membershipType: 'annual', membershipExpiresAt: new Date(now + 180 * 86400000),
        planNotificationState: old };
    await Member.collection.insertOne(member);
    const progress = { kind: 'business', promoted: true, effective: { key: 'intermediate', name: 'Intermediate', minYears: 5, price: 200 } };
    worker.enqueue = async () => { throw new Error('Progression enqueue outage'); };
    assert.equal(await progression.observe(member, progress), false);
    assert.equal((await Member.findById(member._id)).planNotificationState.planId, old.planId);
    worker.enqueue = enqueue;
    Member.updateOne = async () => { throw new Error('Progression checkpoint interruption'); };
    await assert.rejects(progression.observe(member, progress), /checkpoint interruption/);
    assert.equal(await Outbox.countDocuments(), 1);
    await drain();
    assert.equal(emails.length, 0);
    assert.equal((await Outbox.findOne()).status, 'pending', 'worker before checkpoint defers instead of dropping the notice');
    Member.updateOne = memberUpdate;
    const renamed = { ...progress, effective: { ...progress.effective, name: 'Renamed intermediate' } };
    const result = await Promise.all([progression.observe(member, renamed), progression.observe(member, renamed)]);
    assert.equal(result.filter(Boolean).length, 1);
    assert.equal(await Outbox.countDocuments(), 1, 'display text/concurrency preserve progression identity');
    await Outbox.updateMany({}, { $set: { nextAttemptAt: new Date(0) } });
    await drain(); assert.equal(emails.length, 1);
    assert.equal(await progression.observe(await Member.findById(member._id).lean(), renamed), false);
    assert.equal((await Member.findById(member._id)).membershipExpiresAt.getTime(), member.membershipExpiresAt.getTime());
    console.log('PASS durable modern/legacy reminders and progression: enqueue outage, partial prefix, interrupted checkpoint, concurrent workers, distinct reschedule, expiry/disabled/history guards and exactly-once stub SMTP acceptance.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop();
});
