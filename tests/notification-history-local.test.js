// Disposable loopback Mongo only. No provider, production database or send.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'history-local-fixture-only', PUSH_ENABLED: 'false', NOTIFICATION_WORKER_ENABLED: 'false' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Log = require('../src/modules/notifications/notificationLog.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Batch = require('../src/modules/notifications/notificationHistoryBatch.model');
    const { VisitorDelivery, PublicNotice } = require('../src/modules/notifications/visitorPush.models');
    const Booking = require('../src/modules/events/eventbooking.model');
    const history = require('../src/modules/notifications/notificationHistory');
    const reports = require('../src/modules/notifications/deliveryReport');
    const service = require('../src/modules/notifications/notification.service');
    const member = await require('../src/modules/members/memberdetails.model').create({ fullName: 'History Fixture', email: 'history@example.test',
        phoneNumber: '9123456780', role: 'member', state: 'Tamil Nadu', district: 'Chennai', isActive: true });
    const user = member._id;
    await Promise.all([Log, Notification, Batch, VisitorDelivery, PublicNotice].map(Model => Model.createIndexes()));
    let providerCalls = 0;
    require('../src/modules/notifications/email.service').sendEmail = async () => { providerCalls++; throw Error('No send permitted'); };
    require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async () => { providerCalls++; throw Error('No send permitted'); };
    require('../src/modules/notifications/push.service').messaging = () => { providerCalls++; throw Error('No send permitted'); };
    const admin = String(new mongoose.Types.ObjectId()), other = String(new mongoose.Types.ObjectId());
    const auth = (id = admin, role = 'super_admin') => `Bearer ${jwt.sign({ userId: id, role }, process.env.JWT_SECRET)}`;
    const app = express(); app.use(express.json());
    app.use('/notifications', require('../src/modules/notifications/notification.routes'));
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const post = (route, body, actor = admin) => request(app).post(`/notifications/history/${route}`).set('Authorization', auth(actor)).send(body);
    const preview = async (ids, view = 'reports') => (await post('delete-preview', { view, ids }).expect(200)).body.data;
    const confirm = async review => (await post('delete', { ids: review.ids, token: review.token }).expect(200)).body.data;
    const makeLog = (extra = {}) => Log.create({ user, channel: 'email', event: 'CUSTOM', recipient: 'fixture@example.test', subject: 'History fixture', status: 'failed', deliveryStatus: 'failed', ...extra });
    const id = row => `log:${row._id}`;

    const first = await makeLog();
    await request(app).post('/notifications/history/delete-preview').send({ view: 'logs', ids: [String(first._id)] }).expect(401);
    await request(app).post('/notifications/history/delete').set('Authorization', auth(String(user), 'member')).send({}).expect(403);
    for (const body of [
        { view: 'logs', ids: ['invalid'] }, { view: 'reports', ids: [id(first)], filters: {} },
        { view: 'logs', filters: { channel: { $ne: 'email' } } }, { view: 'reports', filters: { unknown: 'field' } },
        { view: 'logs', filters: { from: '2026-02-30' } }, { view: 'reports', filters: { status: 'all-ish' } },
        { view: 'logs', filters: { bookingRef: { $ne: null } } },
        { view: 'logs', filters: null }, { view: 'logs', filters: false },
        { view: 'reports', ids: Array.from({ length: 501 }, () => id(first)) },
    ]) await post('delete-preview', body).expect(400);
    let review = await preview([String(first._id)], 'logs');
    assert.equal(review.eligible, 1); assert.equal(review.retained, 0);
    assert.equal(await Batch.countDocuments({}), 0, 'preview is read-only');
    assert.equal((await Log.findById(first._id)).adminHistoryHiddenAt, undefined);
    await post('delete', { ids: review.ids, token: review.token }, other).expect(400);
    await post('delete', { ids: [`log:${new mongoose.Types.ObjectId()}`], token: review.token }).expect(400);
    const expired = jwt.sign({ ids: review.ids, versions: jwt.decode(review.token).versions }, process.env.JWT_SECRET,
        { audience: 'activ-notification-history-cleanup', subject: admin, jwtid: 'expired', expiresIn: -1 });
    await post('delete', { ids: review.ids, token: expired }).expect(400);
    const confirmations = await Promise.all([confirm(review), confirm(review)]);
    assert(confirmations.some(result => result.alreadySubmitted), 'concurrent confirmations share one durable claim');
    assert.equal(await Batch.countDocuments({}), 1);
    assert.equal((await Log.findById(first._id)).status, 'failed', 'original delivery outcome retained');
    assert((await Log.findById(first._id)).adminHistoryHiddenAt);
    assert.equal((await service.listLogs()).pagination.total, 0);
    assert.equal((await reports.report()).pagination.total, 0);

    const queued = await makeLog({ status: 'queued', deliveryStatus: undefined });
    const claimed = await makeLog({ retryClaim: { token: 'in-flight', at: new Date() } });
    const completed = await makeLog({ status: 'sent', deliveryStatus: 'accepted' });
    review = await preview([id(queued), id(claimed), id(completed)]);
    assert.equal(review.eligible, 1); assert.equal(review.retained, 2);
    assert.equal((await confirm(review)).removed, 1, 'only terminal entries are removed');
    assert.equal((await Log.findById(queued._id)).status, 'queued');
    assert.equal((await Log.findById(claimed._id)).retryClaim.token, 'in-flight');

    const changed = await makeLog();
    review = await preview([id(changed)]);
    await Log.updateOne({ _id: changed._id }, { $set: { status: 'sent', deliveryStatus: 'delivered' } });
    assert.equal((await confirm(review)).retained, 1, 'provider change after review requires a new review');
    assert.equal((await Log.findById(changed._id)).adminHistoryHiddenAt, undefined);

    const atomicRace = await makeLog();
    review = await preview([id(atomicRace)]);
    const raceUpdate = Log.updateOne;
    let raced = false;
    Log.updateOne = async function(filter, update, options) {
        if (!raced && String(filter._id) === String(atomicRace._id) && update.$set?.adminHistoryHiddenAt) {
            raced = true;
            await raceUpdate.call(this, { _id: atomicRace._id }, { $set: { status: 'sent', deliveryStatus: 'delivered' } }, { timestamps: false });
        }
        return raceUpdate.call(this, filter, update, options);
    };
    try { assert.equal((await confirm(review)).retained, 1, 'the write guard also catches a callback after the final read'); }
    finally { Log.updateOne = raceUpdate; }
    assert.equal((await Log.findById(atomicRace._id)).adminHistoryHiddenAt, undefined);

    const callbackLog = await makeLog({ channel: 'whatsapp', status: 'sent', deliveryStatus: 'accepted', providerMessageId: 'history-callback-fixture' });
    await confirm(await preview([id(callbackLog)]));
    assert.equal((await require('../src/modules/notifications/deliveryStatus.service').applyStatus({ id: 'history-callback-fixture', status: 'delivered' })).changed, true);
    assert.equal((await Log.findById(callbackLog._id)).deliveryStatus, 'delivered', 'callbacks still update hidden delivery records');
    assert.equal((await service.listLogs({ search: 'history-callback-fixture' })).pagination.total, 0);

    const notice = await Notification.create({ user, title: 'Member notice', message: 'Kept in inbox', deliveryKey: 'history-dedupe',
        push: { status: 'failed' }, updateDelivery: { email: { status: 'failed' }, whatsapp: { status: 'sent' } } });
    const email = await makeLog({ event: 'ASSOCIATION_UPDATE', data: { notificationId: String(notice._id), broadcastKey: 'fixture-update' } });
    const whatsapp = await makeLog({ channel: 'whatsapp', event: 'ASSOCIATION_UPDATE', status: 'sent', deliveryStatus: 'read', data: { notificationId: String(notice._id), broadcastKey: 'fixture-update' } });
    await Notification.updateOne({ _id: notice._id }, { $set: { 'updateDelivery.email.logId': email._id, 'updateDelivery.whatsapp.logId': whatsapp._id } });
    const inboxBefore = await service.getUserNotifications(user);
    review = await preview([`${notice._id}:email`, id(email)]);
    assert.equal(review.eligible, 1); assert.equal(review.retained, 1, 'linked report/log aliases are one delivery');
    assert.equal((await confirm(review)).removed, 1);
    assert((await Notification.findById(notice._id)).adminHistoryHiddenAt.email);
    assert((await Log.findById(email._id)).adminHistoryHiddenAt);
    let rows = (await reports.report({ limit: 100 })).rows;
    assert(!rows.some(row => row._id === `${notice._id}:email`));
    assert(rows.some(row => row._id === `${notice._id}:whatsapp`), 'other channels stay visible');
    assert.equal((await confirm(await preview([String(whatsapp._id)], 'logs'))).removed, 1, 'legacy action hides its current report counterpart');
    assert((await Notification.findById(notice._id)).adminHistoryHiddenAt.whatsapp);
    assert.equal((await confirm(await preview([`${notice._id}:push`, `${notice._id}:in_app`]))).removed, 2);
    const inboxAfter = await service.getUserNotifications(user);
    assert.equal(inboxAfter.pagination.total, inboxBefore.pagination.total);
    assert.equal(inboxAfter.unread, inboxBefore.unread);
    assert(inboxAfter.notifications.some(row => String(row._id) === String(notice._id)));
    assert(!Object.keys(inboxAfter.notifications[0]).some(key => key.startsWith('adminHistory')), 'admin metadata is absent from member inbox DTO');
    await service.createNotification(user, { title: notice.title, message: notice.message, deliveryKey: 'history-dedupe' });
    assert.equal(await Notification.countDocuments({ deliveryKey: 'history-dedupe' }), 1, 'cleanup preserves durable deduplication keys');

    // A queue change between linked writes rolls back only our visibility
    // marker and keeps the now-pending delivery in both history views.
    const race = await Notification.create({ user, title: 'Race', message: 'Fixture', push: { status: 'skipped' }, updateDelivery: { email: { status: 'failed' } } });
    const raceLog = await makeLog({ event: 'ASSOCIATION_UPDATE', data: { notificationId: String(race._id) } });
    await Notification.updateOne({ _id: race._id }, { $set: { 'updateDelivery.email.logId': raceLog._id } });
    review = await preview([`${race._id}:email`]);
    const originalUpdate = Log.updateOne;
    Log.updateOne = async function(filter, update, options) {
        const result = await originalUpdate.call(this, filter, update, options);
        if (String(filter._id) === String(raceLog._id) && update.$set?.adminHistoryHiddenAt) await Notification.updateOne({ _id: race._id }, { $set: { 'updateDelivery.email.status': 'pending' } });
        return result;
    };
    try { assert.equal((await confirm(review)).retained, 1); } finally { Log.updateOne = originalUpdate; }
    assert.equal((await Log.findById(raceLog._id)).adminHistoryHiddenAt, undefined);
    assert.equal((await Notification.findById(race._id)).adminHistoryHiddenAt?.email, undefined);
    assert.equal((await Notification.findById(race._id)).updateDelivery.email.status, 'pending');

    const publicNotice = await PublicNotice.create({ key: 'history-visitor', kind: 'announcement', sourceId: new mongoose.Types.ObjectId(), status: 'done' });
    const visitor = await VisitorDelivery.create({ notice: publicNotice._id, device: new mongoose.Types.ObjectId(), status: 'failed', lastError: 'messaging/registration-token-not-registered' });
    assert.equal((await confirm(await preview([`visitor:${visitor._id}:push`]))).removed, 1);
    rows = (await reports.report({ limit: 100 })).rows;
    assert(rows.some(row => row._id === `visitor:${visitor._id}:in_app`));
    assert(!rows.some(row => row._id === `visitor:${visitor._id}:push`));
    assert.equal((await VisitorDelivery.findById(visitor._id)).lastError, 'messaging/registration-token-not-registered');

    // Booking detail and summary hide both tracked and recipient-matched
    // legacy history, without removing the booking or stored send records.
    const bookingRef = 'HISTORY-BOOKING-1';
    await Booking.collection.insertOne({ bookingRef, createdAt: new Date(Date.now() - 86400000), bookedBy: { email: 'booking-fixture@example.test' }, participants: [] });
    const tracked = await makeLog({ event: 'EVENT_BOOKING_REMINDER', bookingRef, recipient: 'booking-fixture@example.test' });
    const legacy = await makeLog({ event: 'EVENT_DOCUMENT_REMINDER', recipient: 'booking-fixture@example.test' });
    assert.equal((await service.bookingDelivery(bookingRef)).rows.length, 2);
    await confirm(await preview([String(tracked._id), String(legacy._id)], 'logs'));
    assert.equal((await service.bookingDelivery(bookingRef)).rows.length, 0);
    assert.deepEqual((await service.deliverySummary([bookingRef])).summaries[bookingRef], {});
    assert.equal(await Log.countDocuments({ _id: { $in: [tracked._id, legacy._id] } }), 2);

    // Clear a bounded exact snapshot. Messages arriving after review survive;
    // the next review finds the remainder, not the just-hidden entries.
    await Log.insertMany(Array.from({ length: 503 }, (_, index) => ({ user, channel: 'email', event: 'CUSTOM', recipient: 'batch@example.test',
        subject: 'Bulk history cleanup fixture', status: 'failed', deliveryStatus: 'failed', createdAt: new Date(Date.now() - index) })));
    const reportReview = await history.preview({ view: 'reports', filters: { search: 'Bulk history cleanup fixture', channel: 'email', status: 'failed' } }, admin);
    assert.equal(reportReview.eligible, 500, 'report cleanup supports the same bounded500 entries');
    assert.equal(reportReview.remaining, 3);
    assert.equal((await reports.report({ search: 'Bulk history cleanup fixture', limit: 500 })).rows.length, 100, 'public report request pagination remains capped100');
    review = (await post('delete-preview', { view: 'logs', filters: { search: 'Bulk history cleanup fixture', channel: 'email', delivery: 'failed' } }).expect(200)).body.data;
    assert.equal(review.matched, 503); assert.equal(review.reviewed, 500); assert.equal(review.eligible, 500); assert.equal(review.remaining, 3); assert.equal(review.truncated, true);
    assert(Buffer.byteLength(JSON.stringify({ ids: review.ids, token: review.token })) < 100 * 1024, '500-row confirmation fits default JSON parser limit');
    const arriving = await makeLog({ subject: 'Bulk history cleanup fixture' });
    assert.equal((await confirm(review)).removed, 500);
    assert.equal((await Log.findById(arriving._id)).adminHistoryHiddenAt, undefined);
    const remaining = await history.preview({ view: 'logs', filters: { search: 'Bulk history cleanup fixture' } }, admin);
    assert.equal(remaining.matched, 4); assert.equal(remaining.eligible, 4);
    assert.equal((await service.listLogs({ search: 'Bulk history cleanup fixture' })).counts.total, 4);
    assert.equal((await reports.report({ search: 'Bulk history cleanup fixture' })).pagination.total, 4);

    // More than a full page of waiting messages must not trap an older
    // completed row forever behind the same first500 unremovable entries.
    await Log.insertMany(Array.from({ length: 501 }, () => ({ user, channel: 'email', event: 'CUSTOM', recipient: 'waiting@example.test',
        subject: 'Waiting priority fixture', status: 'queued' })));
    const older = await makeLog({ subject: 'Waiting priority fixture', createdAt: new Date(Date.now() - 86400000) });
    for (const view of ['logs', 'reports']) {
        const priority = await history.preview({ view, filters: { search: 'Waiting priority fixture' } }, admin);
        assert.equal(priority.matched, 502); assert.equal(priority.reviewed, 500); assert.equal(priority.eligible, 1);
        assert(priority.ids.includes(id(older)), `${view} selects an older terminal entry ahead of waiting entries`);
        assert.equal(priority.retained, 499); assert.equal(priority.remaining, 2);
    }
    const onlyWaiting = await history.preview({ view: 'logs', filters: { search: 'Waiting priority fixture', status: 'queued' } }, admin);
    assert.equal(onlyWaiting.eligible, 0); assert.equal(onlyWaiting.retained, 500);
    assert.equal(onlyWaiting.token, '', 'waiting-only filters cannot authorize removal');
    assert.equal(providerCalls, 0, 'history cleanup never queues or sends a notification');
    console.log('PASS history cleanup: super-admin access, strict IDs/filters, 500-row signed snapshots, duplicates/replays, changed/in-flight protection, channel isolation, association counterparts/rollback, visitor rows, booking legacy matching, inbox/dedupe/callback preservation, new arrivals, counts and no provider calls.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
