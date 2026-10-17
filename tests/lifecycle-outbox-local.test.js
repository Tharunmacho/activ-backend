// One disposable loopback database. Every message provider is stubbed.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false', NOTIFICATION_WORKER_ENABLED: 'false',
    PAYMENT_PENDING_NOTICE_DELAY_MS: '1000', FRONTEND_URL: 'https://activ.org.in' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Outbox = require('../src/modules/notifications/lifecycleOutbox.model');
    const Log = require('../src/modules/notifications/notificationLog.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Member = require('../src/modules/members/memberdetails.model');
    const Order = require('../src/modules/payment/paymentorder.model');
    const service = require('../src/modules/notifications/notification.service');
    let worker = require('../src/modules/notifications/lifecycleOutbox');
    await Promise.all([Outbox, Log, Notification].map(model => model.createIndexes()));
    const id = new mongoose.Types.ObjectId();
    await Member.collection.insertOne({ _id: id, fullName: 'Local member', email: 'local@example.test', phoneNumber: '9123450000',
        membershipStatus: 'pending', isActive: true });
    const recipient = { id: String(id), name: 'Local member', email: 'local@example.test', phone: '9123450000' };
    const renewalKey = '2027-01-01T00:00:00.000Z:7';
    const renewal = await worker.enqueue('MEMBERSHIP_RENEWAL_DUE', recipient, { daysLeft: 7, data: { renewalReminderKey: renewalKey } });
    const renewalAgain = await worker.enqueue('MEMBERSHIP_RENEWAL_DUE', { ...recipient, email: 'changed@example.test' },
        { daysLeft: 6, memberAccess: { isStudent: true }, data: { renewalReminderKey: renewalKey } });
    assert.equal(String(renewalAgain._id), String(renewal._id), 'renewal replay deduplicates despite changed dates, contacts and benefits');
    for (const separateKey of ['2027-01-01T00:00:00.000Z:3', '2028-01-01T00:00:00.000Z:7', '2027-02:2027-01-01T00:00:00.000Z']) {
        assert.notEqual(worker.keyFor('MEMBERSHIP_RENEWAL_DUE', recipient, { data: { renewalReminderKey: separateKey } }), renewal.key,
            'different renewal window, purchased period or monthly reminder remains independent');
    }
    const sends = [];
    let emailError = '';
    let emailOutcome;
    require('../src/modules/notifications/email.service').sendEmail = async options => {
        assert.equal(options.to, recipient.email); sends.push('email');
        return emailOutcome || (emailError ? { success: false, error: emailError } : { success: true, messageId: `email-${sends.length}`, provider: 'smtp' });
    };
    require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async phone => {
        assert.equal(phone, recipient.phone); sends.push('whatsapp');
        return { success: true, messageId: `whatsapp-${sends.length}`, provider: 'meta', to: phone };
    };
    const enqueue = key => service.dispatchInBackground('ACCOUNT_REGISTERED', recipient, { data: { fixture: key } });
    const first = await enqueue('restart');
    assert.equal(first.queued, true); assert.equal(sends.length, 0, 'background API awaits persistence, never a provider');
    assert.equal((await enqueue('restart')).outboxId, first.outboxId, 'repeated intent has one durable key');
    delete require.cache[require.resolve('../src/modules/notifications/lifecycleOutbox')];
    worker = require('../src/modules/notifications/lifecycleOutbox');
    const delivered = await worker.processOne(first.outboxId);
    assert(delivered.channels.email.success && delivered.channels.whatsapp.success);
    assert.equal(await Notification.countDocuments({ deliveryKey: `lifecycle:${first.outboxId}:in_app` }), 1);
    assert.deepEqual(sends.slice().sort(), ['email', 'whatsapp']);
    await worker.processOne(first.outboxId); assert.equal(sends.length, 2, 'restart/duplicate request never replays accepted channels');

    const concurrent = await enqueue('concurrent');
    await Promise.all([worker.processOne(concurrent.outboxId), worker.processOne(concurrent.outboxId)]);
    assert.equal(sends.length, 4, 'atomic intent claim admits one worker');

    const interrupted = await enqueue('interrupted');
    await Outbox.updateOne({ _id: interrupted.outboxId }, { $set: { status: 'processing', worker: 'dead-worker', leaseUntil: new Date(0), 'channels.email.status': 'sending' } });
    const beforeUnknown = sends.length;
    await worker.processOne(interrupted.outboxId);
    assert.equal(sends.length, beforeUnknown + 1, 'untouched WhatsApp recovers while unknown email is held');
    assert.equal((await Outbox.findById(interrupted.outboxId)).channels.email.status, 'held');
    const unknownLog = await Log.findOne({ 'data.outboxId': interrupted.outboxId, channel: 'email' }).lean();
    assert.equal(unknownLog.data.autoRetryDisabled, true, 'unknown interruption is visible without entering generic retry');
    assert((await service.retryLog(unknownLog._id)).skipped, 'manual retry also refuses an uncertain interrupted send');

    const acceptance = await enqueue('persisted-acceptance');
    await Outbox.updateOne({ _id: acceptance.outboxId }, { $set: { status: 'processing', worker: 'dead-worker', leaseUntil: new Date(0), 'channels.email.status': 'sending' } });
    await Log.create({ event: 'ACCOUNT_REGISTERED', channel: 'email', recipient: recipient.email, status: 'sent', deliveryStatus: 'accepted',
        providerMessageId: 'already-accepted', data: { outboxId: acceptance.outboxId } });
    const beforeAccepted = sends.length;
    await worker.processOne(acceptance.outboxId);
    assert.equal(sends.length, beforeAccepted + 1, 'accepted audit repairs checkpoint without another email');
    assert.equal((await Outbox.findById(acceptance.outboxId)).channels.email.status, 'done');

    emailError = 'SMTP temporarily unavailable';
    const rejected = await enqueue('known-rejection'); await worker.processOne(rejected.outboxId);
    assert.equal((await Outbox.findById(rejected.outboxId)).channels.email.status, 'failed');
    const rejectedLog = await Log.findOne({ 'data.outboxId': rejected.outboxId, channel: 'email' });
    assert.equal(rejectedLog.deliveryStatus, 'failed'); assert(!rejectedLog.data.autoRetryDisabled);
    const beforeRetry = sends.length; emailError = '';
    await worker.processOne(rejected.outboxId); assert.equal(sends.length, beforeRetry, 'outbox leaves logged rejection to existing retry owner');
    const retried = await service.retryLog(rejectedLog._id); assert.equal(retried.outcome.success, true);
    assert.equal(sends.length, beforeRetry + 1, 'manual retry only retries the failed email');

    emailError = 'write EPIPE';
    const pipe = await enqueue('uncertain-result'); await worker.processOne(pipe.outboxId); emailError = '';
    assert.equal((await Outbox.findById(pipe.outboxId)).channels.email.status, 'held');
    assert.equal((await Log.findOne({ 'data.outboxId': pipe.outboxId, channel: 'email' })).data.outcomeUnknown, true);

    for (const smtpRecipientStatus of ['unknown', 'partial']) {
        emailOutcome = { success: false, outcomeUnknown: true, autoRetryDisabled: true, smtpRecipientStatus,
            error: 'SMTP acceptance needs review before sending again.' };
        const review = await enqueue(`smtp-${smtpRecipientStatus}`);
        await worker.processOne(review.outboxId);
        assert.equal((await Outbox.findById(review.outboxId)).channels.email.status, 'held');
        const reviewLog = await Log.findOne({ 'data.outboxId': review.outboxId, channel: 'email' });
        assert.equal(reviewLog.data.smtpRecipientStatus, smtpRecipientStatus);
        assert.equal(reviewLog.data.autoRetryDisabled, true);
        const before = sends.length;
        await worker.processOne(review.outboxId);
        assert((await service.retryLog(reviewLog._id)).skipped);
        assert.equal(sends.length, before, 'uncertain SMTP metadata never replays through either retry owner');
    }
    emailOutcome = undefined;

    // A delayed checkout job is persisted independently of this process's timers.
    const payments = require('../src/modules/payment/paymentOrder.service');
    await Order.collection.insertOne({ orderId: 'local-pending', memberId: id, orderType: 'membership', status: 'created', provider: 'mock',
        planId: 'basic', planName: 'Beginner', amount: 100, createdAt: new Date(), expiresAt: new Date(Date.now() + 600000) });
    const scheduled = await payments.schedulePendingPaymentNotice('local-pending');
    assert.equal(scheduled.queued, true);
    assert.equal((await payments.schedulePendingPaymentNotice('local-pending')).outboxId, scheduled.outboxId);
    const dueJob = await Outbox.findById(scheduled.outboxId).lean(); assert(+dueJob.nextAttemptAt > Date.now());
    await Outbox.updateOne({ _id: scheduled.outboxId }, { $set: { nextAttemptAt: new Date(0) } });
    await worker.processOne(scheduled.outboxId);
    const pendingNotice = await Outbox.findOne({ event: 'PAYMENT_REQUIRED', 'payload.data.orderId': 'local-pending' }).lean();
    assert(pendingNotice, 'delayed job reconstructs current order and enqueues durable notification');
    await Order.updateOne({ orderId: 'local-pending' }, { $set: { status: 'paid' } });
    const beforePaid = sends.length;
    assert((await worker.processOne(pendingNotice._id)).skipped, 'payment landing after scheduling invalidates the pending notice');
    assert.equal(sends.length, beforePaid);

    // A nominee can change while the durable notice waits for its worker.
    const Booking = require('../src/modules/events/eventbooking.model');
    const eventId = new mongoose.Types.ObjectId();
    await Booking.collection.insertOne({ bookingRef: 'LOCAL-QUEUE', eventId, userId: id, status: 'active',
        payment: { status: 'paid' }, participants: [{ name: 'Replacement nominee', email: 'replacement@example.test', phone: '9123450001' }] });
    const staleNominee = await worker.enqueue('EVENT_PARTICIPANT_CONFIRMED', { ...recipient, id: '' }, {
        bookingRef: 'LOCAL-QUEUE', participantName: recipient.name,
        data: { bookingRef: 'LOCAL-QUEUE', eventId: String(eventId), nominationChange: { id: 'local-change', kind: 'confirmed',
            participant: { name: recipient.name, email: recipient.email, phone: recipient.phone }, participantIndex: 0 } },
    });
    const beforeStale = sends.length;
    const staleResult = await worker.processOne(staleNominee._id);
    assert(staleResult.skipped && /nominee changed/i.test(staleResult.reason));
    assert.equal(sends.length, beforeStale, 'current-booking validator blocks an obsolete queued nominee before providers');

    const preparation = await enqueue('preparation-outage');
    await Outbox.updateOne({ _id: preparation.outboxId }, { $set: { attempts: 8 } });
    const deliver = service._deliverLifecycleEvent;
    service._deliverLifecycleEvent = async () => { throw new Error('Temporary preparation/database outage'); };
    try { assert((await worker.processOne(preparation.outboxId)).queued); } finally { service._deliverLifecycleEvent = deliver; }
    const deferred = await Outbox.findById(preparation.outboxId).lean();
    assert.equal(deferred.status, 'pending', 'repeated pre-provider outages never silently discard durable intent');
    assert(+deferred.nextAttemptAt <= Date.now() + 3600000, 'preparation retry backoff is bounded at one hour');
    await Outbox.updateOne({ _id: preparation.outboxId }, { $set: { nextAttemptAt: new Date(0) } });
    assert((await worker.processOne(preparation.outboxId)).channels.email.success, 'preparation recovers without a new business event');

    // Existing synchronous callers still receive actual provider outcomes.
    const synchronous = await service.dispatchLifecycleEvent('ACCOUNT_REGISTERED', recipient, { data: { fixture: 'awaited' } });
    assert(synchronous.channels.email.success && synchronous.channels.whatsapp.success && synchronous.rows.email._id);
    console.log('PASS: lifecycle intent survives restart, concurrent claim, accepted/unknown recovery, independent logged-failure retry, durable delayed payment and awaited channel outcomes. No external sends.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
