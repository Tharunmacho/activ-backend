// Disposable loopback Mongo; SMTP and WhatsApp are recorders, never providers.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const testTemp = path.resolve(__dirname, '../node_modules/.cache/confirmation-mongo-tmp');
fs.mkdirSync(testTemp, { recursive: true });
Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'false', EVENT_REMINDERS_ENABLED: 'false',
    PUSH_ENABLED: 'false', JWT_SECRET: 'local-confirmation-fixture', FRONTEND_URL: 'https://activ.example.test',
    TEMP: testTemp, TMP: testTemp, TMPDIR: testTemp });
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
let mongo;
async function main() {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri());
    const Booking = require('../src/modules/events/eventbooking.model');
    const Event = require('../src/modules/events/event.model');
    const Outbox = require('../src/modules/notifications/lifecycleOutbox.model');
    const service = require('../src/modules/events/eventbooking.service');
    const worker = require('../src/modules/notifications/lifecycleOutbox');
    const notifications = require('../src/modules/notifications/notification.service');
    const emails = [], whatsapps = [];
    require('../src/modules/notifications/regionalContacts.service').resolveForRegion = async () => null;
    require('../src/modules/notifications/email.service').sendEmail = async options => {
        emails.push(options); return { success: true, messageId: `email-${emails.length}`, provider: 'smtp' };
    };
    require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async phone => {
        whatsapps.push(phone); return { success: true, messageId: `whatsapp-${whatsapps.length}`, provider: 'meta', to: phone };
    };
    require('../src/modules/notifications/botbee.service').sendText = async () => { throw new Error('No session send expected'); };
    const eventId = new mongoose.Types.ObjectId();
    await Event.collection.insertOne({ _id: eventId, title: 'Local confirmation fixture', slug: 'local-confirmation', status: 'published',
        mode: 'offline', startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 90000000) });
    const booker = { name: 'Booker', email: 'booker@example.test', phone: '9123456789' };
    const participants = [booker, { name: 'Shared phone', email: 'shared@example.test', phone: '9123456789' },
        { name: 'Separate guest', email: 'guest@example.test', phone: '9987654321' }];
    const id = new mongoose.Types.ObjectId();
    await Booking.collection.insertOne({ _id: id, eventId, bookingRef: 'ACTIVB-LOCAL-0001', bookedBy: booker, participants,
        noOfPersons: 3, totalAmount: 0, status: 'active', payment: { status: 'not_required' },
        confirmationPending: true, confirmationSentAt: null, createdAt: new Date() });
    const enqueue = worker.enqueue;
    worker.enqueue = async (name, recipient, payload) => {
        if (recipient.email === 'shared@example.test') throw new Error('Simulated interrupted recipient enqueue');
        return enqueue(name, recipient, payload);
    };
    await service.queuePendingConfirmations();
    assert.equal(await Outbox.countDocuments(), 2);
    assert.equal((await Booking.findById(id)).confirmationPending, true);
    assert.equal(emails.length + whatsapps.length, 0, 'booking enqueue does not call any provider');
    worker.enqueue = enqueue;
    await Event.updateOne({ _id: eventId }, { $set: { title: 'Updated fixture title' } });
    delete require.cache[require.resolve('../src/modules/events/eventbooking.service')];
    await require('../src/modules/events/eventbooking.service').queuePendingConfirmations();
    assert.equal(await Outbox.countDocuments(), 3, 'restart restores missing recipient without duplicate stored jobs');
    const saved = await Booking.findById(id).lean();
    assert(saved.confirmationSentAt); assert.equal(saved.confirmationPending, false);
    for (let i = 0; i < 5; i++) if (!await worker.processOne()) break;
    assert.equal(emails.length, 3); assert.equal(whatsapps.length, 2);
    assert.equal(new Set(emails.map(row => row.to)).size, 3);
    const guestEmail = emails.find(row => row.to === 'shared@example.test');
    assert(guestEmail.inlineImages.some(image => image.cid === 'ticket-qr' && Buffer.isBuffer(image.content)));
    const bookerEmail = emails.find(row => row.to === booker.email);
    assert.equal(bookerEmail.inlineImages.length, 3);
    assert.equal(await Outbox.countDocuments({ status: 'done' }), 3);
    await service.queuePendingConfirmations(); await worker.processOne();
    assert.equal(emails.length, 3); assert.equal(whatsapps.length, 2, 'completed intents do not resend');
    // An unflagged historical booking is not enrolled by the recovery sweep.
    await Booking.collection.insertOne({ ...saved, _id: new mongoose.Types.ObjectId(), bookingRef: 'ACTIVB-HISTORY-0001',
        confirmationPending: false, confirmationSentAt: null });
    assert.equal(await service.queuePendingConfirmations(), 0);
    assert.equal(await Outbox.countDocuments(), 3);
    assert.equal(typeof notifications.dispatchInBackground, 'function');
    console.log('PASS isolated Mongo confirmation recovery, unique provider deliveries, participant PNG QR, and historical exclusion');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop();
});
