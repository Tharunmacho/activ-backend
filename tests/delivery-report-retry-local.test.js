// Disposable loopback MongoDB; every provider is replaced before any action.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'delivery-report-retry-local-only', PUSH_ENABLED: 'false',
    CORS_ORIGIN: 'https://activ.org.in',
    NOTIFICATION_WORKER_ENABLED: 'false', EMAIL_HOST: 'localhost', EMAIL_USER: 'fixture@example.test',
    EMAIL_PASS: 'fixture-only', MEMBER_EMAIL_TRANSPORT: 'shared' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') },
        instance: { ip: '127.0.0.1', launchTimeout: 60000 } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Log = require('../src/modules/notifications/notificationLog.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Batch = require('../src/modules/notifications/deliveryRetryBatch.model');
    const Device = require('../src/modules/notifications/pushDevice.model');
    const Announcement = require('../src/modules/announcements/announcement.model');
    const { VisitorDelivery, VisitorDevice, PublicNotice } = require('../src/modules/notifications/visitorPush.models');
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    const retry = require('../src/modules/notifications/deliveryRetry');
    const service = require('../src/modules/notifications/notification.service');
    const calls = [];
    let outcome = { success: true, provider: 'smtp', messageId: 'fixture-accepted', smtpRecipientStatus: 'accepted' };
    require('../src/modules/notifications/email.service').sendEmail = async payload => {
        assert.match(payload.to, /@example\.test$/);
        calls.push({ channel: 'email', to: payload.to });
        await new Promise(resolve => setTimeout(resolve, 15));
        return outcome;
    };
    const whatsapp = require('../src/modules/notifications/whatsappTemplate');
    whatsapp.isConfigured = () => true;
    whatsapp.sendTemplateMessage = async to => { assert.equal(to, '919123456780'); calls.push({ channel: 'whatsapp', to }); return { success: true, provider: 'meta', messageId: 'fixture-whatsapp' }; };
    require('../src/modules/notifications/associationTemplateReview').status = async () => ({ ready: true });
    require('../src/modules/notifications/push.service').messaging = () => { throw Error('Report retries must queue push through the existing worker'); };
    await Promise.all([Log, Notification, Batch, Device, VisitorDevice, VisitorDelivery, PublicNotice].map(Model => Model.createIndexes()));
    const member = await Member.create({ fullName: 'Retry Fixture', email: 'retry@example.test', phoneNumber: '9123456780',
        role: 'member', state: 'Tamil Nadu', district: 'Chennai', block: 'Fixture Block', isActive: true,
        membershipStatus: 'pending', memberType: 'business', associationUpdatePreferences: { email: true, whatsapp: true,
            whatsappConsentAt: new Date(), whatsappConsentNumber: '919123456780' } });
    const admin = String(new mongoose.Types.ObjectId()), otherAdmin = String(new mongoose.Types.ObjectId());
    const auth = (userId = admin, role = 'super_admin') => `Bearer ${jwt.sign({ userId, role }, process.env.JWT_SECRET)}`;
    const app = express(); require('../src/core/middleware/security')(app); app.use(express.json());
    app.use('/notifications', require('../src/modules/notifications/notification.routes'));
    app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const post = (url, body, actor = admin) => request(app).post(`/notifications/reports/${url}`).set('Authorization', auth(actor)).send(body);
    const makeLog = (extra = {}) => Log.create({ user: member._id, event: 'CUSTOM', channel: 'email', recipient: member.email,
        status: 'failed', deliveryStatus: 'failed', lastError: 'SMTP 535 authentication refused', attempts: 4,
        subject: 'Retry fixture', data: { emailHtml: '<p>Original fixture content</p>' }, ...extra });
    const id = row => `log:${row._id}`;
    const preview = async ids => (await post('retry-preview', { ids }).expect(200)).body.data;
    const confirm = async review => (await post('retry', { ids: review.ids, token: review.token }).expect(200)).body.data;

    const first = await makeLog();
    const preflight = await request(app).options('/notifications/reports/retry-status')
        .set('Origin', 'https://activ.org.in').set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization,x-delivery-retry-token').expect(204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://activ.org.in');
    assert(preflight.headers['access-control-allow-headers'].toLowerCase().split(',').includes('x-delivery-retry-token'));
    await request(app).post('/notifications/reports/retry-preview').send({ ids: [id(first)] }).expect(401);
    await request(app).post('/notifications/reports/retry').set('Authorization', auth(String(member._id), 'member')).send({ ids: [id(first)] }).expect(403);
    await post('retry-preview', { ids: Array.from({ length: 101 }, () => id(first)) }).expect(400);
    await post('retry-preview', { filters: { channel: 'invalid' } }).expect(400);
    await post('retry-preview', { filters: { channel: { $ne: 'email' } } }).expect(400);
    await post('retry-preview', { filters: 'invalid' }).expect(400);
    let review = await preview([id(first)]);
    assert.equal(review.eligible, 1); assert.equal(review.reviewed, 1); assert.equal(review.remaining, 0);
    assert.equal(calls.length, 0, 'preview is read-only and never sends');
    assert.equal(await Batch.countDocuments({}), 0, 'preview does not create a job or consume a retry');
    assert(review.statusToken.length < 512, 'status token fits well within proxy header limits');
    await post('retry', { ids: review.ids, token: review.statusToken }).expect(400);
    await post('retry', { ids: review.ids, token: review.token }, otherAdmin).expect(400);
    await post('retry', { ids: ['log:' + new mongoose.Types.ObjectId()], token: review.token }).expect(400);
    const decoded = jwt.decode(review.token);
    const expired = jwt.sign({ ids: decoded.ids, versions: decoded.versions }, process.env.JWT_SECRET,
        { audience: 'activ-delivery-report-retry', subject: admin, jwtid: 'expired', expiresIn: -1 });
    await post('retry', { ids: review.ids, token: expired }).expect(400);
    const duplicate = await Promise.all([confirm(review), confirm(review)]);
    assert.equal(calls.length, 1, 'concurrent duplicate confirmations send once');
    assert(duplicate.some(result => result.alreadySubmitted));
    assert.equal((await Log.findById(first._id).lean()).attempts, 5, 'cumulative attempts retained');
    let status = (await request(app).get('/notifications/reports/retry-status').set('Authorization', auth())
        .set('X-Delivery-Retry-Token', review.statusToken).expect(200)).body.data;
    assert.equal(status.sent, 1); assert.equal(status.processing, false); assert.equal(status.found, true);
    await request(app).get('/notifications/reports/retry-status').set('Authorization', auth(otherAdmin))
        .set('X-Delivery-Retry-Token', review.statusToken).expect(400);
    assert.equal((await request(app).get('/notifications/reports/retry-status').set('Authorization', auth())
        .set('X-Delivery-Retry-Token', review.token).expect(200)).body.data.sent, 1, 'full review tokens remain compatible with older clients');
    assert.equal(calls.length, 1, 'status lookups never retry');
    const audit = await Batch.findOne({}).lean();
    assert.equal(audit.requestedBy, admin); assert.equal(audit.results[0].previousAttempts, 4);

    const protectedRows = await Promise.all([
        makeLog({ status: 'sent', deliveryStatus: 'accepted' }), makeLog({ deliveryStatus: 'read', readAt: new Date() }),
        makeLog({ deliveryStatus: 'failed', deliveredAt: new Date() }),
        makeLog({ data: { emailHtml: '<p>Partial</p>', smtpRecipientStatus: 'partial', outcomeUnknown: true } }),
        makeLog({ data: { emailHtml: '<p>Unknown</p>', outcomeUnknown: true } }),
        makeLog({ data: { emailHtml: '<p>Opt-out</p>', autoRetryDisabled: true, skipReason: 'Recipient opted out.' } }),
        makeLog({ lastError: 'ETIMEDOUT after provider contact' }), makeLog({ event: 'PASSWORD_RESET' }),
        makeLog({ createdAt: new Date(Date.now() - 31 * 86400000) }),
    ]);
    review = await preview(protectedRows.map(id));
    assert.equal(review.eligible, 0); assert.equal(review.skipped, protectedRows.length);
    for (const row of protectedRows.slice(0, 6)) assert((await service.retryLog(row._id)).skipped);
    assert.equal(calls.length, 1, 'accepted/read/partial/unknown/disabled rows cannot send via old retry path either');

    const changed = await makeLog(); review = await preview([id(changed)]);
    await Log.updateOne({ _id: changed._id }, { $set: { deliveryStatus: 'accepted', status: 'sent' } });
    assert.equal((await confirm(review)).skipped, 1, 'provider status change after preview is respected');
    const raced = await makeLog(); review = await preview([id(raced)]);
    const beforeRace = calls.length;
    await Promise.all([confirm(review), service.retryLog(raced._id)]);
    assert.equal(calls.length - beforeRace, 1, 'report confirmation and legacy/automatic retry share the same atomic claim');

    const rejection = await makeLog(); review = await preview([id(rejection)]);
    outcome = { success: false, error: 'SMTP 535 authentication refused', smtpRecipientStatus: 'rejected' };
    assert.equal((await confirm(review)).failed, 1);
    const rejected = await Log.findById(rejection._id).lean();
    assert.equal(rejected.attempts, 5); assert(!rejected.retryClaim?.token);
    assert(rejected.statusHistory.some(item => item.status === 'failed'));
    outcome = { success: false, error: 'SMTP outcome unknown', outcomeUnknown: true, smtpRecipientStatus: 'unknown' };
    review = await preview([id(rejection)]); assert.equal((await confirm(review)).failed, 1);
    assert((await Log.findById(rejection._id).lean()).retryClaim?.token, 'unknown outcomes stay claimed for review');
    assert.equal((await preview([id(rejection)])).eligible, 0);
    outcome = { success: true, provider: 'smtp', messageId: 'fixture-accepted', smtpRecipientStatus: 'accepted' };

    const scopedEmail = await makeLog({ subject: 'Unique filter fixture' });
    await makeLog({ channel: 'whatsapp', recipient: '919123456780', templateId: 'fixture-approved', subject: 'Unique filter fixture', data: { params: ['Fixture'] } });
    const filtered = (await post('retry-preview', { filters: { channel: 'email', group: 'automation', campaignKey: 'automation:CUSTOM',
        search: 'Unique filter fixture', status: 'accepted', page: 99 } }).expect(200)).body.data;
    assert.deepEqual(filtered.ids, [id(scopedEmail)], 'channel/campaign/group/search stay scoped and outcome is always failed');

    const payment = await makeLog({ event: 'PAYMENT_REQUIRED' });
    review = await preview([id(payment)]); assert.equal(review.eligible, 1);
    await Member.updateOne({ _id: member._id }, { $set: { membershipStatus: 'active' } });
    assert.equal((await confirm(review)).skipped, 1, 'completed membership payment invalidates an earlier reviewed reminder');
    await Member.updateOne({ _id: member._id }, { $set: { membershipStatus: 'pending' } });
    const Event = require('../src/modules/events/event.model');
    const Booking = require('../src/modules/events/eventbooking.model');
    const event = { _id: new mongoose.Types.ObjectId(), title: 'Retry event', status: 'published',
        startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 90000000) };
    await Event.collection.insertOne(event);
    await Booking.collection.insertOne({ bookingRef: 'RETRY-BOOKING', eventId: event._id, userId: member._id,
        status: 'active', payment: { status: 'paid' }, bookedBy: { name: member.fullName, email: member.email, phone: member.phoneNumber } });
    const bookingLog = await makeLog({ event: 'EVENT_BOOKING_CONFIRMED', bookingRef: 'RETRY-BOOKING', eventId: String(event._id) });
    review = await preview([id(bookingLog)]); assert.equal(review.eligible, 1, JSON.stringify(review.reasons));
    await Event.collection.updateOne({ _id: event._id }, { $set: { endAt: new Date(Date.now() - 1000) } });
    assert.equal((await confirm(review)).skipped, 1, 'expired event cannot send an earlier reviewed booking confirmation');
    await Booking.collection.deleteOne({ bookingRef: 'RETRY-BOOKING' });
    assert.equal((await preview([id(bookingLog)])).eligible, 0, 'deleted booking cannot fall back to a stale stored email');

    const update = { _id: new mongoose.Types.ObjectId(), title: 'Association retry fixture', body: 'A current public update.',
        status: 'published', audience: 'all', targets: [], includeVisitors: true, createdAt: new Date(), updatedAt: new Date() };
    await Announcement.collection.insertOne(update);
    const key = broadcast.sourceKey('announcement', update);
    const notice = await Notification.create({ user: member._id, title: 'Association fixture', message: 'An update',
        data: { kind: 'announcement', sourceId: String(update._id), broadcastKey: key },
        push: { status: 'skipped' }, updateDelivery: { email: { status: 'failed', attempts: 5 }, whatsapp: { status: 'failed', attempts: 5 } } });
    const associationLog = await makeLog({ event: 'ASSOCIATION_UPDATE', data: { notificationId: String(notice._id), sourceId: String(update._id), broadcastKey: key } });
    const whatsappLog = await makeLog({ event: 'ASSOCIATION_UPDATE', channel: 'whatsapp', recipient: '919123456780',
        data: { notificationId: String(notice._id), sourceId: String(update._id), broadcastKey: key } });
    await Notification.updateOne({ _id: notice._id }, { $set: { 'updateDelivery.email.logId': associationLog._id, 'updateDelivery.whatsapp.logId': whatsappLog._id } });
    review = await preview([`${notice._id}:email`, `${notice._id}:whatsapp`]);
    assert.equal(review.eligible, 2, JSON.stringify(review.reasons));
    const associationResult = await confirm(review);
    assert.equal(associationResult.sent, 2);
    const currentNotice = await Notification.findById(notice._id).lean();
    assert.equal(currentNotice.updateDelivery.email.attempts, 6); assert.equal(currentNotice.updateDelivery.whatsapp.attempts, 6);
    assert((await Log.findById(associationLog._id).lean()).resentAs, 'association retries link the new audit attempt');

    const largeIds = Array.from({ length: 100 }, () => ({ noticeId: new mongoose.Types.ObjectId(), logId: new mongoose.Types.ObjectId() }));
    await Notification.insertMany(largeIds.map(ids => ({ _id: ids.noticeId, user: member._id, title: 'Large retry review', message: 'Fixture',
        data: { kind: 'announcement', sourceId: String(update._id), broadcastKey: key }, push: { status: 'skipped' },
        updateDelivery: { email: { status: 'failed', attempts: 5, logId: ids.logId } } })));
    await Log.insertMany(largeIds.map(ids => ({ _id: ids.logId, user: member._id, event: 'ASSOCIATION_UPDATE', channel: 'email', recipient: member.email,
        status: 'failed', deliveryStatus: 'failed', lastError: 'SMTP 535 authentication refused',
        data: { notificationId: String(ids.noticeId), sourceId: String(update._id), broadcastKey: key } })));
    const beforeLargePreview = calls.length;
    const largeReview = await preview(largeIds.map(ids => `${ids.noticeId}:email`));
    assert.equal(largeReview.eligible, 100, JSON.stringify(largeReview.reasons));
    assert(largeReview.token.length > 8192, 'fixture covers the formerly oversized 100-row association review');
    assert(largeReview.statusToken.length < 512, 'compact status token size is independent of reviewed row count');
    const largeClaims = jwt.decode(largeReview.token), statusClaims = jwt.decode(largeReview.statusToken);
    for (const claim of ['sub', 'aud', 'jti', 'iat', 'exp']) assert.equal(statusClaims[claim], largeClaims[claim]);
    assert.equal(statusClaims.purpose, 'status'); assert.equal(statusClaims.ids, undefined); assert.equal(statusClaims.versions, undefined);
    await post('retry', { ids: largeReview.ids, token: largeReview.statusToken }).expect(400);
    const statusOfLarge = (await request(app).get('/notifications/reports/retry-status').set('Authorization', auth())
        .set('X-Delivery-Retry-Token', largeReview.statusToken).expect(200)).body.data;
    assert.equal(statusOfLarge.found, false, 'a compact token cannot read another reviewed batch');
    assert.equal(calls.length, beforeLargePreview, 'large preview and status lookup do not send or queue any messages');

    await Device.create({ user: member._id, token: 'local-member-push-token-123456789', platform: 'web' });
    const push = await Notification.create({ user: member._id, title: 'Push retry', message: 'Original notice', data: { event: 'CUSTOM' },
        push: { status: 'failed', attempts: 5, lastError: 'messaging/quota-exceeded', sentTokens: [] } });
    const pushReview = await preview([`${push._id}:push`, `${push._id}:in_app`]);
    assert.equal(pushReview.eligible, 1); assert.equal(pushReview.skipped, 1);
    const callsBeforePush = calls.length;
    assert.equal((await confirm(pushReview)).queued, 1);
    assert.equal(calls.length, callsBeforePush);
    const pushAfter = await Notification.findById(push._id).lean();
    assert.equal(pushAfter.push.status, 'pending'); assert.equal(pushAfter.push.attempts, 5);
    assert.equal(await Notification.countDocuments({ _id: push._id }), 1, 'retry does not create another in-app notification');
    process.env.PUSH_ENABLED = 'true'; process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
    let memberPushCalls = 0;
    await require('../src/modules/notifications/push.service').processPushBatch({ client: { sendEach: async payloads => {
        memberPushCalls += payloads.length;
        assert(payloads.every(payload => payload.token === 'local-member-push-token-123456789'));
        return { responses: payloads.map(() => ({ success: true })) };
    } } });
    process.env.PUSH_ENABLED = 'false'; delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    assert.equal(memberPushCalls, 1, 'manual push retry executes once even after the normal five-attempt limit');
    const deliveredPush = await Notification.findById(push._id).lean();
    assert.equal(deliveredPush.push.status, 'sent'); assert.equal(deliveredPush.push.attempts, 6);
    const partialPush = await Notification.create({ user: member._id, title: 'Partial push', message: 'Do not replay',
        push: { status: 'failed', lastError: 'messaging/quota-exceeded', sentTokens: ['accepted-token-hash'] } });
    assert.equal((await preview([`${partialPush._id}:push`])).eligible, 0);

    const device = await VisitorDevice.create({ secretHash: 'fixture-visitor-hash', token: 'local-visitor-push-token-123456789', platform: 'web', enabled: true });
    const publicNotice = await PublicNotice.create({ key, kind: 'announcement', sourceId: update._id, status: 'done' });
    const visitor = await VisitorDelivery.create({ notice: publicNotice._id, device: device._id, status: 'failed', attempts: 5, lastError: 'messaging/quota-exceeded' });
    review = await preview([`visitor:${visitor._id}:push`]); assert.equal(review.eligible, 1, JSON.stringify(review.reasons));
    assert.equal((await confirm(review)).queued, 1);
    assert.equal((await VisitorDelivery.findById(visitor._id).lean()).attempts, 5);
    let visitorPushCalls = 0;
    await require('../src/modules/notifications/visitorPush.service').processBatch({ send: async payload => {
        visitorPushCalls++; assert.equal(payload.token, 'local-visitor-push-token-123456789'); return 'visitor-accepted';
    } });
    assert.equal(visitorPushCalls, 1);
    assert.equal((await VisitorDelivery.findById(visitor._id).lean()).attempts, 6);
    // Another independent failed delivery exercises source revalidation without
    // inventing a failure on the successfully accepted fixture above.
    const otherDevice = await VisitorDevice.create({ secretHash: 'fixture-visitor-hash-2', token: 'local-visitor-push-token-987654321', platform: 'web', enabled: true });
    const lateVisitor = await VisitorDelivery.create({ notice: publicNotice._id, device: otherDevice._id, status: 'failed', attempts: 5, lastError: 'messaging/quota-exceeded' });
    review = await preview([`visitor:${lateVisitor._id}:push`]);
    await Announcement.collection.updateOne({ _id: update._id }, { $set: { status: 'draft' } });
    assert.equal((await confirm(review)).skipped, 1, 'withdrawn source between preview and confirmation cannot be queued');
    await VisitorDevice.updateOne({ _id: otherDevice._id }, { $set: { enabled: false } });
    assert.equal((await preview([`visitor:${lateVisitor._id}:push`])).eligible, 0, 'visitor opt-out respected');
    console.log('PASS: admin-only preview/confirm/status; exact filters and token snapshot; replay and old-route concurrency; accepted/unknown/partial guards; source revalidation; email/WhatsApp retry audits; member/visitor push queue attempts preserved; no duplicate in-app notices. All providers stubbed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
    process.exit(process.exitCode || 0);
});
