// Real persistence and routes, disposable loopback Mongo only; FCM is a fake adapter.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const request = require('supertest');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'local-audience-test-only', JWT_REFRESH_SECRET: 'local-refresh-test-only', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
  assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  const Member = require('../src/modules/members/memberdetails.model');
  const Order = require('../src/modules/payment/paymentorder.model');
  const Announcement = require('../src/modules/announcements/announcement.model');
  const Notification = require('../src/modules/notifications/notification.model');
  const Job = require('../src/modules/notifications/broadcast.model');
  const Device = require('../src/modules/notifications/pushDevice.model');
  const Event = require('../src/modules/events/event.model');
  const { memberAccess, allowedAudiences } = require('../src/modules/common/memberAudience');
  const contextService = require('../src/modules/common/memberContext');
  const updates = require('../src/modules/announcements/announcement.service');
  const broadcast = require('../src/modules/notifications/contentBroadcast');
  const push = require('../src/modules/notifications/push.service');
  const notifications = require('../src/modules/notifications/notification.service');
  notifications.dispatchInBackground = () => {};
  await Promise.all([Member, Order, Announcement, Notification, Job, Device, Event].map(m => m.createIndexes()));
  const fixtures = {};
  for (const kind of ['student', 'paid', 'unpaid', 'lifetime', 'expired']) {
    fixtures[kind] = await Member.create({ fullName: `Test ${kind}`, email: `${kind}@example.test`, phoneNumber: '9123456780',
      role: 'member', state: 'Tamil Nadu', district: 'Chennai', block: '', memberType: kind === 'student' ? 'student' : 'business',
      membershipStatus: kind === 'unpaid' ? 'pending' : 'active', membershipType: kind === 'lifetime' ? 'lifetime' : 'annual',
      membershipExpiresAt: new Date(Date.now() + (kind === 'expired' ? -2 : 30) * 86400000), isActive: true });
    if (kind !== 'unpaid') await Order.collection.insertOne({ memberId: fixtures[kind]._id, orderType: 'membership', status: 'paid',
      orderId: `local-${kind}`, planAudience: kind === 'student' ? 'student' : kind === 'lifetime' ? 'platinum' : 'business', paidAt: new Date() });
  }
  const context = async kind => contextService.resolveMemberContext({ user: { userId: String(fixtures[kind]._id), role: 'member' } });
  assert.deepEqual(allowedAudiences(await context('student')), ['all', 'paid', 'student']);
  assert.deepEqual(allowedAudiences(await context('lifetime')), ['all', 'paid', 'lifetime', 'paid_non_student']);
  assert.equal(memberAccess(fixtures.expired).canNetwork, false);
  const notices = {};
  for (const audience of ['all', 'paid', 'unpaid', 'student', 'lifetime']) {
    notices[audience] = await updates.create({ title: `Test ${audience}`, body: 'Dear member, thank you for participating.', status: 'published', audience });
  }
  const expected = { student: ['all', 'paid', 'student'], paid: ['all', 'paid'], unpaid: ['all', 'unpaid'], lifetime: ['all', 'paid', 'lifetime'], expired: ['all', 'unpaid'] };
  for (const kind of Object.keys(fixtures)) {
    const ctx = await context(kind);
    const list = await updates.listForMember(ctx);
    assert.deepEqual(list.announcements.map(a => a.audience).sort(), expected[kind].slice().sort(), `${kind} feed`);
    for (const audience of Object.keys(notices)) {
      if (expected[kind].includes(audience)) await updates.getForMember(notices[audience].id, ctx);
      else await assert.rejects(updates.getForMember(notices[audience].id, ctx), e => e.statusCode === 404, `${kind} direct link cannot bypass ${audience}`);
    }
  }
  const regional = await updates.create({ title: 'Regional students', body: 'Private regional update', audience: 'student', state: 'Kerala', status: 'published' });
  await assert.rejects(updates.getForMember(regional.id, await context('student')), e => e.statusCode === 404);
  for (let i = 0; i < 10; i++) await broadcast.processBatch();
  for (const kind of Object.keys(fixtures)) {
    const list = await notifications.getUserNotifications(fixtures[kind]._id, 1, 20, await context(kind));
    assert.equal(list.notifications.length, expected[kind].length, `${kind} notifications respect membership + region`);
    assert(list.notifications.every(n => !n.push && !n.deliveryKey), 'worker state is not returned to members');
  }
  assert.equal(await Job.countDocuments(), 6, 'one durable job per publication');
  const doc = await Announcement.findById(notices.student.id);
  await doc.save();
  assert.equal(await Job.countDocuments(), 6, 'saving unchanged content does not broadcast again');
  const already = await Notification.countDocuments();
  await Job.updateMany({}, { $set: { cursor: null, status: 'pending', nextAttemptAt: new Date() } });
  for (let i = 0; i < 10; i++) await broadcast.processBatch();
  assert.equal(await Notification.countDocuments(), already, 'worker restart is idempotent');
  await updates.update(notices.student.id, { status: 'draft' });
  const hidden = await notifications.getUserNotifications(fixtures.student._id, 1, 20, await context('student'));
  assert.equal(hidden.notifications.length, 2, 'withdrawn private content disappears from the bell');
  const stale = await Notification.findOne({ user: fixtures.student._id, 'data.sourceId': notices.student.id }).lean();
  assert.equal(await push.stillVisible(stale), false, 'withdrawn publication cannot send from an old job');

  // Students cannot bypass the UI through any directory or messaging route.
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/members', require('../src/modules/members/member.routes'));
  app.use('/browse', require('../src/modules/members/memberExtras.routes').browseRouter);
  app.use('/messages', require('../src/modules/messages/message.routes'));
  app.use('/notifications', require('../src/modules/notifications/notification.routes'));
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const auth = require('../src/modules/auth/auth.service');
  const token = auth.generateTokens(fixtures.student).accessToken;
  for (const route of ['/members', '/members/directory', `/members/directory/${fixtures.paid._id}`, '/browse', '/browse/search', '/messages', '/messages/unread-count']) {
    const response = await request(app).get(route).set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, 403, route); assert.match(response.body.message, /upgrade/i);
  }
  const messageService = require('../src/modules/messages/message.service');
  await assert.rejects(messageService.openWith(fixtures.student._id, fixtures.paid._id), e => e.statusCode === 403);
  await assert.rejects(messageService.openWith(fixtures.paid._id, fixtures.student._id), e => e.statusCode === 403);
  // Changing a profile kind does not convert a paid Student plan into a business plan.
  await Member.updateOne({ _id: fixtures.student._id }, { $set: { memberType: 'business' } });
  contextService.invalidateMemberContext(fixtures.student._id);
  assert.equal((await context('student')).canNetwork, false);
  await Order.collection.insertOne({ memberId: fixtures.student._id, orderType: 'membership', status: 'paid',
    orderId: 'local-student-upgrade', upgradeKind: 'aspirant', paidAt: new Date(Date.now() + 1000) });
  contextService.invalidateMemberContext(fixtures.student._id);
  assert.equal((await context('student')).canNetwork, true, 'a paid upgrade unlocks networking');
  const conversation = await messageService.openWith(fixtures.student._id, fixtures.paid._id);
  assert(conversation.id, 'upgraded members can open a conversation');

  // Students retain event access; online joining information requires a settled booking.
  const event = await Event.create({ title: 'Online learning', slug: 'online-learning', status: 'published', audience: 'paid', mode: 'online', onlinePlatform: 'Google Meet',
    onlineUrl: 'https://meet.google.com/test-meeting', registrationEnabled: true, startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 90000000), capacity: 100, reachEveryone: true });
  const bookingService = require('../src/modules/events/eventbooking.service');
  const studentContext = { ...(await context('paid')), isStudent: true, canNetwork: false };
  const bookable = await bookingService.getBookableEvent(event._id, studentContext);
  assert.equal(bookable.onlinePlatform, 'Google Meet'); assert.equal(bookable.onlineUrl, undefined);
  const Booking = require('../src/modules/events/eventbooking.model');
  for (const [ref, status, paymentStatus] of [['LOCAL-FREE', 'active', 'not_required'], ['LOCAL-PAID', 'active', 'paid'], ['LOCAL-PENDING', 'pending_payment', 'pending'], ['LOCAL-CANCEL', 'cancelled', 'paid']]) {
    await Booking.collection.insertOne({ bookingRef: ref, eventId: event._id, status, payment: { status: paymentStatus }, participants: [], contact: {} });
    const booking = await bookingService.getBooking(ref);
    assert.equal(booking.onlineUrl, ['LOCAL-FREE', 'LOCAL-PAID'].includes(ref) ? event.onlineUrl : '', `${ref} link release`);
  }

  // Device tokens belong only to the current user, and failed devices do not duplicate successes.
  const a = 'local-device-token-a-123456789'; const b = 'local-device-token-b-123456789'; const c = 'local-device-token-c-123456789';
  await push.register(fixtures.paid._id, { token: a, platform: 'android' });
  await push.register(fixtures.unpaid._id, { token: a, platform: 'android' });
  assert.equal(await Device.countDocuments({ user: fixtures.paid._id }), 0, 'account switch reassigns token');
  await push.unregister(fixtures.paid._id, a);
  assert.equal(await Device.countDocuments({ token: a }), 1, 'another user cannot unregister the current owner');
  await push.register(fixtures.unpaid._id, { token: b, platform: 'ios' });
  await push.register(fixtures.unpaid._id, { token: c, platform: 'android' });
  const devices = await Device.find({ user: fixtures.unpaid._id }).sort({ token: 1 }).lean();
  const row = await Notification.create({ user: fixtures.unpaid._id, title: 'Private headline', message: 'Secret details', data: { kind: 'test' } });
  const requests = [];
  const first = await push.deliver(row, devices, { sendEach: async messages => {
    requests.push(messages); return { responses: [{ success: true }, { error: { code: 'messaging/registration-token-not-registered' } }, { error: { code: 'messaging/server-unavailable' } }] };
  } });
  assert.equal(first.status, 'pending'); assert.equal(first.sentTokens.length, 1);
  assert.equal(await Device.countDocuments({ token: b }), 0, 'unregistered tokens are removed');
  assert(requests[0].every(message => message.data.title === 'Private headline' && message.data.body === 'Secret details'), 'the current recipient receives the actual notice preview');
  assert(requests[0].every(message => message.notification.title === 'Private headline' && message.notification.body === 'Secret details'));
  row.push = { ...row.push.toObject(), ...first };
  const second = await push.deliver(row, await Device.find({ user: fixtures.unpaid._id }).lean(), { sendEach: async messages => {
    assert.equal(messages.length, 1); assert.equal(messages[0].token, c, 'only the transient failure retries');
    return { responses: [{ success: true }] };
  } });
  assert.equal(second.status, 'sent');
  const browserToken = 'web-test-token-'.repeat(4);
  await push.register(fixtures.unpaid._id, { token: browserToken, platform: 'web' });
  const webDevice = await Device.findOne({ token: browserToken }).lean();
  assert.equal(webDevice.platform, 'web');
  const webPayload = push.payload(row, webDevice);
  assert.equal(webPayload.notification, undefined, 'web must not bypass the worker account check with automatic display');
  assert.equal(webPayload.data.userId, String(fixtures.unpaid._id));
  assert.equal(webPayload.webpush.headers.TTL, '86400');
  assert.equal(webPayload.data.title, 'Private headline');
  assert.equal(webPayload.data.body, 'Secret details');
  await push.register(fixtures.paid._id, { token: browserToken, platform: 'web' });
  await push.unregister(fixtures.unpaid._id, browserToken);
  assert.equal(String((await Device.findOne({ token: browserToken })).user), String(fixtures.paid._id));
  await push.unregister(fixtures.paid._id, browserToken);
  assert.equal(await Device.countDocuments({ token: browserToken }), 0);
  const forbiddenHealth = await request(app).get('/notifications/push/status').set('Authorization', `Bearer ${token}`);
  assert.equal(forbiddenHealth.status, 403, 'members cannot inspect push administration');

  // Successful sessions record identity and provider; failed/blocked logins do not.
  const session = await auth.memberSession('paid@example.test', '', 'google');
  assert.equal(session.user.loginMethod, 'google');
  const Audit = require('../src/modules/audit/audit.model');
  assert.equal(await Audit.countDocuments({ action: 'auth.signed_in', actorId: String(fixtures.paid._id), 'metadata.provider': 'google' }), 1);
  await Member.updateOne({ _id: fixtures.paid._id }, { $set: { isActive: false } });
  await assert.rejects(auth.memberSession('paid@example.test', '', 'facebook'), e => e.statusCode === 403);
  assert.equal(await Audit.countDocuments({ action: 'auth.signed_in', 'metadata.provider': 'facebook' }), 0);
  const { NewsArticle, GalleryItem, Scheme } = require('../src/modules/cms/cms.models');
  const news = await NewsArticle.create({ title: 'Draft news', slug: 'local-news', status: 'draft' });
  assert.equal(await Job.countDocuments({ sourceId: news._id }), 0, 'draft news does not broadcast');
  await NewsArticle.findByIdAndUpdate(news._id, { $set: { status: 'published' } }, { new: true });
  const gallery = await GalleryItem.create({ title: 'Test gallery', visible: true });
  const scheme = await Scheme.create({ title: 'National learning scheme', slug: 'local-scheme', status: 'published', tier: 'national' });
  for (const [kind, source] of [['news', news], ['gallery', gallery], ['scheme', scheme]]) {
    assert.equal(await Job.countDocuments({ sourceId: source._id, kind }), 1, `${kind} publication hook`);
  }
  const beforeSeats = await Job.countDocuments({ sourceId: event._id });
  await Event.findByIdAndUpdate(event._id, { $inc: { registeredCount: 1 } }, { new: true });
  assert.equal(await Job.countDocuments({ sourceId: event._id }), beforeSeats, 'booking counters do not broadcast');
  // Resume a publication larger than one batch, including a retried first page.
  await Job.updateMany({}, { $set: { status: 'done' } });
  await Member.collection.insertMany(Array.from({ length: 510 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), fullName: `Batch member ${i}`,
    email: `batch${i}@example.test`, role: 'member', membershipStatus: 'pending', state: 'Test Batch', createdAt: new Date(Date.now() - 10000) })));
  const large = await updates.create({ title: 'Batch test', body: 'Test only', status: 'published', audience: 'all', state: 'Test Batch' });
  await broadcast.processBatch();
  const partial = await Job.findOne({ sourceId: large.id }).lean();
  assert.equal(partial.status, 'pending'); assert(partial.cursor, 'cursor checkpoint saved');
  const firstPage = await Notification.countDocuments({ 'data.sourceId': large.id });
  assert(firstPage > 0 && firstPage <= 500, 'one batch stays bounded');
  await Job.updateOne({ _id: partial._id }, { $set: { cursor: null } });
  await broadcast.processBatch();
  assert.equal(await Notification.countDocuments({ 'data.sourceId': large.id }), firstPage, 'retrying a cursor does not duplicate recipients');
  await broadcast.processBatch();
  assert.equal(await Notification.countDocuments({ 'data.sourceId': large.id }), 510, 'remaining recipients delivered on the next batch');
  assert.equal((await Job.findById(partial._id)).status, 'done');
  console.log('PASS: audience feeds/direct links, persistent broadcasts, networking gates/upgrades, online booking access, device ownership/retries and sign-in audit. No external delivery.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
