// Disposable loopback Mongo; every Firebase request uses the adapter below.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'true', NOTIFICATION_WORKER_ENABLED: 'true',
    FIREBASE_SERVICE_ACCOUNT_JSON: '{"testOnly":true}', JWT_SECRET: 'push-worker-local-only', JWT_REFRESH_SECRET: 'push-worker-refresh-local-only' });
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
    const { Conversation, sortedPair, pairKeyOf } = require('../src/modules/messages/message.model');
    const push = require('../src/modules/notifications/push.service');
    // This suite exercises queue/delivery state using its fake Firebase adapter.
    // Authentication is separately covered by push-readiness.test.js.
    require('../src/modules/notifications/pushReadiness').check = async () => ({ configured: true, ready: true, credentialReady: true });
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    const service = require('../src/modules/notifications/notification.service');
    await Promise.all([Member, Order, Announcement, Notification, Job, Device, Conversation].map(model => model.createIndexes()));
    const members = {};
    for (const name of ['owner', 'other', 'student']) {
        const member = await Member.create({ fullName: name, email: `${name}@example.test`, phoneNumber: '9123456780', role: 'member',
            state: 'Tamil Nadu', district: 'Chennai', membershipStatus: 'active', membershipType: 'annual',
            membershipExpiresAt: new Date(Date.now() + 30 * 86400000), memberType: name === 'student' ? 'student' : 'business', isActive: true });
        members[name] = member;
        await Order.collection.insertOne({ memberId: member._id, orderType: 'membership', status: 'paid', orderId: `local-${name}`,
            planId: name === 'student' ? 'student' : 'business', planAudience: name === 'student' ? 'student' : 'business', paidAt: new Date() });
    }
    const owner = members.owner._id;
    const tokens = { web: 'local-web-token-123456789012345', android: 'local-android-token-123456789012345', ios: 'local-ios-token-123456789012345' };
    for (const [platform, token] of Object.entries(tokens)) await push.register(owner, { platform, token });
    const sent = [];
    let transient = '';
    const client = { sendEach: async messages => {
        sent.push(...messages);
        return { responses: messages.map(message => message.token === transient
            ? { success: false, error: { code: 'messaging/server-unavailable' } } : { success: true }) };
    } };
    const worker = () => push.processPushBatch({ client });
    const latest = id => Notification.findById(id).lean();

    const once = await service.createNotification(owner, { title: 'Once', message: 'Durable lifecycle notice', deliveryKey: 'local-lifecycle-once' });
    await service.createNotification(owner, { title: 'Once', message: 'Durable lifecycle notice', deliveryKey: 'local-lifecycle-once' });
    assert.equal(await Notification.countDocuments({ deliveryKey: 'local-lifecycle-once' }), 1);
    assert.equal((await latest(once._id)).push.status, 'pending', 'idempotent lifecycle upserts also enqueue push');
    await Notification.updateOne({ _id: once._id }, { $set: { 'push.status': 'skipped' } });

    // The actual worker fans one stored notice out to each current platform.
    const lifecycle = await service.createNotification(owner, { title: 'Account update', message: 'Private account content', data: { event: 'WELCOME' } });
    await worker();
    assert.equal((await latest(lifecycle._id)).push.status, 'sent');
    assert.equal(sent.length, 3);
    assert(sent.every(message => message.data.event === 'WELCOME'));
    assert.equal(sent.find(message => message.token === tokens.web).notification, undefined);
    assert.equal(sent.find(message => message.token === tokens.android).android.notification.channelId, 'activ_updates');
    assert.equal(sent.find(message => message.token === tokens.android).android.notification.priority, 'high', 'pre-O notification display requests heads-up priority');
    assert.equal(sent.find(message => message.token === tokens.ios).apns.payload.aps.sound, 'default');
    assert(!JSON.stringify(sent).includes('Private account content'));

    // A partial provider outage retries only the device that failed.
    sent.length = 0;
    transient = tokens.ios;
    const retry = await service.createNotification(owner, { title: 'Retry', message: 'Retry test', data: { kind: 'test' } });
    await worker();
    assert.equal((await latest(retry._id)).push.status, 'pending');
    assert.equal((await latest(retry._id)).push.sentTokens.length, 2);
    await Notification.updateOne({ _id: retry._id }, { $set: { 'push.nextAttemptAt': new Date(0) } });
    transient = '';
    await worker();
    assert.equal((await latest(retry._id)).push.status, 'sent');
    assert.deepEqual(sent.slice(3).map(message => message.token), [tokens.ios]);

    // Current account ownership and opt-out are respected before sending.
    sent.length = 0;
    const switched = await service.createNotification(owner, { title: 'Switch', message: 'Switch test' });
    await push.register(members.other._id, { token: tokens.web, platform: 'web' });
    await push.unregister(owner, tokens.android);
    await push.register(owner, { token: tokens.ios, platform: 'ios', enabled: false });
    await worker();
    assert.equal((await latest(switched._id)).push.status, 'skipped');
    assert.equal((await latest(switched._id)).push.lastError, push.skipReasons.noDevices);
    assert.equal(sent.length, 0);
    await push.register(owner, { token: tokens.web, platform: 'web' });

    // Only the latest published revision produces a campaign, even if an
    // editor saves twice before the worker wakes up.
    const update = await Announcement.create({ title: 'Revision one', body: 'A member update', status: 'published', audience: 'paid', state: 'Tamil Nadu', deliveryChannels: { email: false, whatsapp: false, push: true } });
    await Announcement.findByIdAndUpdate(update._id, { $set: { title: 'Revision two' } }, { new: true });
    for (let index = 0; index < 3; index++) await broadcast.processBatch();
    assert.equal(await Notification.countDocuments({ user: owner, 'data.sourceId': String(update._id) }), 1);
    const campaign = await Notification.findOne({ user: owner, 'data.sourceId': String(update._id) }).lean();
    assert.equal(await push.stillVisible(campaign), true);
    // Populate the feed cache, then change the member without invalidating it.
    await require('../src/modules/common/memberContext').memberSnapshot(String(owner));
    await Member.updateOne({ _id: owner }, { $set: { state: 'Kerala' } });
    assert.equal(await push.stillVisible(campaign), false, 'fresh region rejects stale cached audience');
    assert.equal(await push.visibilityReason(campaign), push.skipReasons.noAccess);
    await Member.updateOne({ _id: owner }, { $set: { state: 'Tamil Nadu', membershipExpiresAt: new Date(Date.now() - 86400000) } });
    assert.equal(await push.stillVisible(campaign), false, 'expired member cannot receive paid content');
    await Member.updateOne({ _id: owner }, { $set: { membershipExpiresAt: new Date(Date.now() + 86400000) } });
    await Announcement.findByIdAndUpdate(update._id, { $set: { title: 'Revision three' } }, { new: true });
    assert.equal(await push.stillVisible(campaign), false, 'superseded push is skipped');
    assert.equal(await push.visibilityReason(campaign), push.skipReasons.sourceChanged);
    await Announcement.findByIdAndUpdate(update._id, { $set: { status: 'draft' } }, { new: true });
    assert.equal(await push.stillVisible(campaign), false, 'withdrawn content cannot send');
    await worker();
    assert.equal((await latest(campaign._id)).push.status, 'skipped');
    assert.equal((await latest(campaign._id)).push.lastError, push.skipReasons.sourceUnavailable);

    // Default findOneAndUpdate returns its old draft; the hook still sees the
    // committed publication. Saving an unchanged row does not enqueue twice.
    const draft = await Announcement.create({ title: 'Default query return', body: 'A test draft', status: 'draft' });
    await Announcement.findByIdAndUpdate(draft._id, { $set: { status: 'published' } });
    assert.equal(await Job.countDocuments({ sourceId: draft._id }), 1);
    await (await Announcement.findById(draft._id)).save();
    assert.equal(await Job.countDocuments({ sourceId: draft._id }), 1);

    // Deactivated/deleted accounts receive neither content nor personal alerts.
    await Member.updateOne({ _id: owner }, { $set: { isActive: false } });
    assert.equal(await push.stillVisible({ user: owner, data: { kind: 'test' } }), false);
    await Member.updateOne({ _id: owner }, { $set: { isActive: true, deletedAt: new Date() } });
    assert.equal(await push.stillVisible({ user: owner, data: { kind: 'test' } }), false);
    await Member.updateOne({ _id: owner }, { $unset: { deletedAt: '' } });

    // Message notices must still belong to this member and require a paid
    // non-student membership when the queued push is processed.
    const conversation = await Conversation.create({ participants: sortedPair(owner, members.other._id), pairKey: pairKeyOf(owner, members.other._id) });
    const messageRow = { user: owner, data: { kind: 'message', conversationId: String(conversation._id) } };
    assert.equal(await push.stillVisible(messageRow), true);
    assert.equal(await push.stillVisible({ ...messageRow, user: members.student._id }), false);
    await Member.updateOne({ _id: owner }, { $set: { membershipStatus: 'pending' } });
    assert.equal(await push.stillVisible(messageRow), false);
    await Member.updateOne({ _id: owner }, { $set: { membershipStatus: 'active' } });

    // Stale payment failures stop once the same order has been paid.
    const paidOrder = await Order.findOne({ memberId: owner }).lean();
    assert.equal(await push.stillVisible({ user: owner, data: { event: 'PAYMENT_FAILED', orderId: paidOrder.orderId } }), false);
    assert.equal(await push.stillVisible({ user: owner, data: { event: 'PAYMENT_FAILED' } }), false, 'unverifiable failure metadata cannot send');
    assert.equal(await push.stillVisible({ user: owner, data: { event: 'MEMBERSHIP_ACTIVATED' } }), false, 'activation requires its original membership snapshot');
    const findOrder = Order.findOne;
    try {
        Order.findOne = () => ({ lean: async () => { throw Error('Disposable database outage'); } });
        await assert.rejects(push.stillVisible({ user: owner, data: { event: 'PAYMENT_FAILED', orderId: paidOrder.orderId } }), /Disposable database outage/,
            'transient state lookup failures defer rather than permanently skip a queued alert');
    } finally { Order.findOne = findOrder; }

    // Admin tests cannot claim success with no registered target or no worker.
    await assert.rejects(push.queueTest(members.student._id), error => error.statusCode === 400 && /Enable notifications/.test(error.message));
    process.env.NOTIFICATION_WORKER_ENABLED = 'false';
    await assert.rejects(push.queueTest(owner), error => error.statusCode === 400 && /worker is disabled/.test(error.message));
    process.env.NOTIFICATION_WORKER_ENABLED = 'true';
    assert.equal((await push.queueTest(owner)).queued, true);

    const Admin = require('../src/modules/admin/superadmin.model');
    const admin = await Admin.create({ adminId: 'SUPER901', email: 'push-admin@example.test', passwordHash: 'local-fixture', fullName: 'Push tester', active: true });
    await push.register(admin._id, { token: 'local-admin-browser-token-1234567890', platform: 'web' });
    assert.equal(await push.stillVisible({ user: admin._id, data: { kind: 'test' } }), true, 'separate admin accounts can test their own devices');
    await Admin.updateOne({ _id: admin._id }, { $set: { active: false } });
    assert.equal(await push.stillVisible({ user: admin._id, data: { kind: 'test' } }), false);
    await Admin.deleteOne({ _id: admin._id });
    assert.equal(await push.stillVisible({ user: admin._id, data: { kind: 'test' } }), false, 'deleted admins do not keep receiving queued alerts');

    // A timed-out lease can be recovered; an old notification is not replayed.
    const expired = await service.createNotification(owner, { title: 'Old', message: 'Old test' });
    await Notification.collection.updateOne({ _id: expired._id }, { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } });
    const leased = await service.createNotification(owner, { title: 'Lease', message: 'Lease test' });
    await Notification.updateOne({ _id: leased._id }, { $set: { 'push.status': 'sending', 'push.leaseUntil': new Date(0) } });
    await worker();
    assert.equal((await latest(expired._id)).push.status, 'skipped');
    assert.equal((await latest(expired._id)).push.lastError, push.skipReasons.expired);
    assert.equal((await latest(leased._id)).push.status, 'sent');
    assert.equal((await latest(once._id)).push.lastError || '', '', 'historical skipped rows are not rewritten or replayed');

    // A channel edit stops an already queued notification and records why,
    // even though it also changes the publication revision.
    const channelUpdate = await Announcement.create({ title: 'Channel test', body: 'Worker fixture', status: 'published', audience: 'all', deliveryChannels: { email: false, whatsapp: false, push: true } });
    const channelRow = await service.createNotification(owner, { title: 'Channel test', message: 'Worker fixture', data: {
        kind: 'announcement', sourceId: String(channelUpdate._id), broadcastKey: broadcast.sourceKey('announcement', channelUpdate.toObject()),
    } });
    await Announcement.updateOne({ _id: channelUpdate._id }, { $set: { 'deliveryChannels.push': false } });
    const beforeChannelCheck = sent.length;
    await worker();
    assert.equal((await latest(channelRow._id)).push.status, 'skipped');
    assert.equal((await latest(channelRow._id)).push.lastError, push.skipReasons.channelOff);
    assert.equal(sent.length, beforeChannelCheck, 'disabled channels make no provider calls');

    const inactiveRow = await service.createNotification(owner, { title: 'Inactive', message: 'Worker fixture' });
    await Member.updateOne({ _id: owner }, { $set: { isActive: false } });
    await worker();
    assert.equal((await latest(inactiveRow._id)).push.lastError, push.skipReasons.accountInactive);
    assert.equal(sent.length, beforeChannelCheck, 'inactive accounts make no provider calls');
    await Member.updateOne({ _id: owner }, { $set: { isActive: true } });

    // All invalid registrations retain their existing skip semantics, with a
    // clear reason and only the exact expired token removed.
    const invalidToken = 'local-invalid-worker-token-123456789';
    await push.register(members.other._id, { token: invalidToken, platform: 'web' });
    const invalidRow = await service.createNotification(members.other._id, { title: 'Invalid device', message: 'Worker fixture' });
    let invalidCalls = 0;
    await push.processPushBatch({ client: { sendEach: async messages => {
        invalidCalls++;
        assert.deepEqual(messages.map(message => message.token), [invalidToken]);
        return { responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }] };
    } } });
    assert.equal(invalidCalls, 1);
    assert.equal((await latest(invalidRow._id)).push.status, 'skipped');
    assert.equal((await latest(invalidRow._id)).push.lastError, push.skipReasons.invalidDevices);
    assert.equal(await Device.countDocuments({ token: invalidToken }), 0);
    assert.equal(await Device.countDocuments({ user: owner, token: tokens.web }), 1, 'unrelated live registrations are preserved');
    await worker();
    assert.equal(invalidCalls, 1, 'skipped invalid registrations do not automatically retry');
    console.log('PASS: persistent push worker across web/Android/iOS, partial retries, account ownership, publication revisions, fresh audience/region, messaging access, payment state, expiry and test prerequisites. No external delivery.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
