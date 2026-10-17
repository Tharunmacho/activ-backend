// Disposable loopback Mongo only; every outbound adapter is intercepted.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', MONGOMS_RUNTIME_DOWNLOAD: 'false', NOTIFICATION_WORKER_ENABLED: 'false',
    JWT_SECRET: 'local-channel-selection-secret', PUSH_ENABLED: 'true', FIREBASE_SERVICE_ACCOUNT_JSON: '{"testOnly":true}',
    EMAIL_HOST: 'localhost', EMAIL_USER: 'fixture@example.test', EMAIL_PASS: 'fixture-only', MEMBER_EMAIL_TRANSPORT: 'shared' });
let mongo, count = 0;
const pass = text => { count++; console.log('PASS ' + text); };
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/); process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Announcement = require('../src/modules/announcements/announcement.model');
    const channels = require('../src/modules/announcements/announcementChannels');
    const updates = require('../src/modules/announcements/announcement.service');
    const Member = require('../src/modules/members/memberdetails.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Job = require('../src/modules/notifications/broadcast.model');
    const Log = require('../src/modules/notifications/notificationLog.model');
    const Device = require('../src/modules/notifications/pushDevice.model');
    const { VisitorDevice, PublicNotice, VisitorDelivery } = require('../src/modules/notifications/visitorPush.models');
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    const delivery = require('../src/modules/notifications/associationUpdateDelivery');
    const push = require('../src/modules/notifications/push.service');
    const visitors = require('../src/modules/notifications/visitorPush.service');
    const retry = require('../src/modules/notifications/deliveryRetry');
    const preferences = require('../src/modules/notifications/updatePreferences');
    const audits = [];
    require('../src/modules/audit/audit.service').record = async row => { audits.push(row); };
    require('../src/modules/notifications/associationTemplateReview').status = async () => ({ ready: true });
    require('../src/modules/notifications/emailAccounts').accountFor = () => ({ isConfigured: true });
    const whatsapp = require('../src/modules/notifications/whatsappTemplate'); whatsapp.isConfigured = () => true;
    const calls = { email: 0, whatsapp: 0, push: 0, visitor: 0 };
    let failing = false;
    require('../src/modules/notifications/email.service').sendEmail = async value => {
        assert.equal(value.to, 'channels@example.test'); calls.email++;
        return failing ? { success: false, error: 'SMTP 550 recipient rejected' } : { success: true, messageId: 'fixture-email' };
    };
    whatsapp.sendTemplateMessage = async number => {
        assert.equal(number, '919123456780'); calls.whatsapp++;
        return failing ? { success: false, error: 'Template parameters rejected' } : { success: true, messageId: 'fixture-whatsapp' };
    };
    const client = { sendEach: async payloads => {
        assert(payloads.every(payload => payload.token === 'fixture-member-push-123456789')); calls.push += payloads.length;
        return { responses: payloads.map(() => failing ? { success: false, error: { code: 'messaging/quota-exceeded' } } : { success: true }) };
    } };
    const visitorClient = { send: async payload => {
        assert.equal(payload.token, 'fixture-visitor-push-123456789'); calls.visitor++;
        if (failing) throw Object.assign(new Error('quota refused'), { code: 'messaging/quota-exceeded' });
        return 'fixture-visitor';
    } };
    await Promise.all([Announcement, Member, Notification, Job, Log, Device, VisitorDevice, PublicNotice, VisitorDelivery].map(model => model.createIndexes()));
    const member = await Member.create({ fullName: 'Channel Fixture', email: 'channels@example.test', phoneNumber: '9123456780', registrationIncomplete: true,
        role: 'member', isActive: true, membershipStatus: 'pending' });
    await preferences.update(member._id, { email: true, whatsapp: true });
    await push.register(member._id, { platform: 'android', token: 'fixture-member-push-123456789' });
    const installation = await visitors.install();
    await visitors.register(installation.key, { platform: 'android', token: 'fixture-visitor-push-123456789' });
    const all = { email: true, whatsapp: true, push: true }, none = channels.none();
    const payload = { title: 'Channel fixture', body: 'Read this update.', audience: 'all', status: 'published', includeVisitors: true };
    const fanoutMembers = async () => { for (let i = 0; i < 30 && await Job.exists({ status: 'pending' }); i++) await broadcast.processBatch(); };
    const work = async () => { await fanoutMembers(); await delivery.processBatch(); await push.processPushBatch({ client }); await visitors.processBatch(visitorClient); };
    const defaults = await updates.create({ ...payload, title: 'Safe omitted defaults' });
    assert.deepEqual(defaults.deliveryChannels, none);
    assert.deepEqual((await Announcement.findById(defaults.id).lean()).deliveryChannels, none);
    await work(); assert.deepEqual(calls, { email: 0, whatsapp: 0, push: 0, visitor: 0 });
    assert(await Notification.exists({ 'data.sourceId': defaults.id }));
    assert((await visitors.feed()).some(row => row.sourceId === defaults.id));
    assert.equal((await updates.getForMember(defaults.id, { id: String(member._id), _id: member._id, audience: 'unpaid' })).deliveryChannels, undefined);
    const direct = await Announcement.create({ title: 'Direct model default', status: 'draft' });
    assert.deepEqual(direct.deliveryChannels, none);
    pass('new omitted channels persist all off while member/in-app/public visitor feeds remain');

    for (let bits = 0; bits < 8; bits++) {
        const selected = { email: !!(bits & 1), whatsapp: !!(bits & 2), push: !!(bits & 4) };
        const before = { ...calls };
        const created = await updates.create({ ...payload, title: 'Combination ' + bits, deliveryChannels: selected });
        await work();
        assert.deepEqual(created.deliveryChannels, selected);
        const row = await Notification.findOne({ 'data.sourceId': created.id }).lean(); assert(row);
        assert.equal(!!row.updateDelivery?.email, selected.email); assert.equal(!!row.updateDelivery?.whatsapp, selected.whatsapp);
        assert.equal(row.push.status, selected.push ? 'sent' : 'skipped');
        for (const channel of ['email', 'whatsapp', 'push']) assert.equal(calls[channel] - before[channel], Number(selected[channel]), channel + ' combination ' + bits);
        assert.equal(calls.visitor - before.visitor, Number(selected.push));
        assert((await visitors.feed()).some(item => item.sourceId === created.id));
        pass('only selected channels contact fake providers for combination ' + bits);
    }
    for (const value of [null, [], {}, { email: true }, { email: true, whatsapp: false, push: 'false' }, { ...all, sms: true }, 'invalid', 'true']) {
        await assert.rejects(updates.create({ ...payload, deliveryChannels: value }), error => error.statusCode === 400);
        await assert.rejects(updates.update(defaults.id, { deliveryChannels: value }), error => error.statusCode === 400);
    }
    await assert.rejects(new Announcement({ title: 'Bad model', deliveryChannels: { ...all, push: 'true' } }).validate());
    const multipart = await updates.create({ title: 'Multipart', deliveryChannels: JSON.stringify({ ...none, email: true }) });
    assert.deepEqual(multipart.deliveryChannels, { ...none, email: true });
    await updates.update(multipart.id, { summary: 'Preserve saved channels' });
    assert.deepEqual((await Announcement.findById(multipart.id).lean()).deliveryChannels, { ...none, email: true });
    const status = await updates.setStatus(multipart.id, 'published');
    assert.deepEqual(status.deliveryChannels, { ...none, email: true });
    assert.deepEqual(audits.at(-1).metadata.deliveryChannels, status.deliveryChannels);
    assert.deepEqual((await updates.listForAdmin()).announcements.find(row => row.id === multipart.id).deliveryChannels, status.deliveryChannels);
    await work(); pass('strict full-object validation, multipart, partial edits, admin/status DTOs and audit metadata');

    const legacy = { _id: new mongoose.Types.ObjectId('000000000000000000000123'), title: 'Legacy channel fixture', body: 'Legacy body', status: 'published', audience: 'all' };
    assert.equal(broadcast.sourceKey('announcement', legacy), 'announcement:000000000000000000000123:2ea371e1d8192c1762fdb5c7815574d00d009e658ec740e72f4698ff3ddb81ff');
    await Announcement.collection.insertOne({ ...legacy, createdAt: new Date(), updatedAt: new Date() });
    assert.equal((await Announcement.findById(legacy._id)).deliveryChannels, undefined, 'hydration never inserts new defaults into legacy records');
    assert.deepEqual((await updates.listForAdmin()).announcements.find(row => row.id === String(legacy._id)).deliveryChannels, all);
    const oldKey = broadcast.sourceKey('announcement', legacy);
    await broadcast.enqueue('announcement', legacy); const beforeLegacy = { ...calls }; await work();
    assert.equal(calls.email - beforeLegacy.email, 1); assert.equal(calls.whatsapp - beforeLegacy.whatsapp, 1); assert.equal(calls.push - beforeLegacy.push, 1);
    await updates.update(String(legacy._id), { summary: 'Legacy edit preserves missing choice' });
    assert.equal((await Announcement.findById(legacy._id).lean()).deliveryChannels, undefined);
    assert.notEqual(broadcast.sourceKey('announcement', { ...legacy, deliveryChannels: none }), oldKey);
    await work(); pass('legacy absence stays all-on with original revision hashes and no implicit migration');

    await preferences.update(member._id, { email: false, whatsapp: false });
    await push.unregister(member._id, 'fixture-member-push-123456789');
    await visitors.unregister(installation.key);
    const beforeOptout = { ...calls }; await updates.create({ ...payload, title: 'Respect opt outs', deliveryChannels: all }); await work();
    assert.deepEqual(calls, beforeOptout);
    await preferences.update(member._id, { email: true, whatsapp: true });
    await push.register(member._id, { platform: 'android', token: 'fixture-member-push-123456789' });
    await visitors.register(installation.key, { platform: 'android', token: 'fixture-visitor-push-123456789' });
    pass('author selection does not override member consent or enabled device requirements');

    const queued = await updates.create({ ...payload, title: 'Disable before queue sends', deliveryChannels: all });
    await fanoutMembers(); await visitors.fanout(); const oldDoc = await Announcement.findById(queued.id).lean();
    const oldNotice = await Notification.findOne({ 'data.sourceId': queued.id }).lean();
    const beforeDisable = { ...calls }; await updates.update(queued.id, { deliveryChannels: none }); await work();
    assert.deepEqual(calls, beforeDisable);
    assert.equal((await delivery.sendPrepared('email', member, oldDoc, member.email)).skipped, true);
    assert.equal((await push.deliver(oldNotice, await Device.find({ user: member._id }).lean(), client)).status, 'skipped');
    assert.deepEqual(calls, beforeDisable);
    const latestDoc = await Announcement.findById(queued.id).lean(); oldNotice.data.broadcastKey = broadcast.sourceKey('announcement', latestDoc);
    assert.match((await delivery.current(oldNotice, 'email')).reason, /not selected/);
    const visible = await visitors.feed(); assert(visible.some(row => row.sourceId === queued.id));
    pass('channel-only edits cancel old queued jobs and last-moment send calls without hiding the feed');

    failing = true;
    const failed = await updates.create({ ...payload, title: 'Failed retry selection', deliveryChannels: all }); await work();
    const row = await Notification.findOne({ 'data.sourceId': failed.id }).lean();
    const publicRow = await PublicNotice.findOne({ sourceId: failed.id }).lean();
    const visitorRow = await VisitorDelivery.findOne({ notice: publicRow._id }).lean();
    await Notification.updateOne({ _id: row._id }, { $set: { 'push.status': 'failed', 'push.lastError': 'messaging/quota-exceeded', 'push.attempts': 5 } });
    await VisitorDelivery.updateOne({ _id: visitorRow._id }, { $set: { status: 'failed', lastError: 'messaging/quota-exceeded', attempts: 5 } });
    const ids = [`${row._id}:email`, `${row._id}:whatsapp`, `${row._id}:push`, `visitor:${visitorRow._id}:push`];
    const actor = String(new mongoose.Types.ObjectId());
    const preview = await retry.preview({ ids }, actor); assert.equal(preview.eligible, 4);
    const beforeRetry = { ...calls };
    await updates.update(failed.id, { deliveryChannels: none });
    assert.equal((await retry.preview({ ids }, actor)).eligible, 0);
    const result = await retry.execute({ ids: preview.ids, token: preview.token }, actor);
    assert.equal(result.sent, 0); assert.equal(result.queued, 0); assert.equal(result.skipped, 4);
    const failedLog = await Log.findById(row.updateDelivery.email.logId).lean();
    assert.equal((await delivery.retryLog(failedLog)).skipped, true);
    assert.deepEqual(calls, beforeRetry); pass('reports and direct retries recheck all four selected delivery types after preview');
    console.log(`PASS: ${count} channel-selection scenarios; fake provider calls ${JSON.stringify(calls)}, zero real deliveries.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
