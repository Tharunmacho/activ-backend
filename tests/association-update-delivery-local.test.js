// Disposable MongoDB only; every provider call is stubbed and recipient-asserted.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'local-update-delivery-test-only', PUSH_ENABLED: 'false',
    EMAIL_HOST: 'localhost', EMAIL_USER: 'test@example.test', EMAIL_PASS: 'local-test-not-a-credential',
    MEMBER_EMAIL_TRANSPORT: 'shared', FRONTEND_URL: 'https://activ.org.in' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1', launchTimeout: 60000 } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Order = require('../src/modules/payment/paymentorder.model');
    const Plan = require('../src/modules/members/membershipplan.model');
    const Announcement = require('../src/modules/announcements/announcement.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Job = require('../src/modules/notifications/broadcast.model');
    const Log = require('../src/modules/notifications/notificationLog.model');
    const service = require('../src/modules/announcements/announcement.service');
    const notifications = require('../src/modules/notifications/notification.service');
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    const delivery = require('../src/modules/notifications/associationUpdateDelivery');
    const templateReview = require('../src/modules/notifications/associationTemplateReview');
    templateReview.status = async () => ({ ready: true, checked: true, status: 'APPROVED' });
    const prefs = require('../src/modules/notifications/updatePreferences');
    const messages = require('../src/modules/notifications/associationUpdateMessage');
    const calls = [];
    const failures = new Map();
    const send = (channel, to, title) => {
        assert(channel === 'email' ? to.endsWith('@example.test') : /^919123450\d{3}$/.test(to), 'only fake recipients');
        calls.push({ channel, to, title });
        const error = failures.get(`${channel}:${title}`);
        return error && typeof error === 'object' ? error : error ? { success: false, error } : { success: true, messageId: `local-${calls.length}`, provider: channel === 'email' ? 'smtp' : 'meta' };
    };
    require('../src/modules/notifications/email.service').sendEmail = async payload => send('email', payload.to, payload.subject.replace(/^ACTIV update: /, ''));
    require('../src/modules/notifications/whatsappTemplate').isConfigured = () => true;
    require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async (to, template, params) => {
        assert.equal(template, 'activ_association_update_v2'); assert.equal(params.length, 4);
        assert.match(params[3], /^https:\/\/activ\.org\.in\/member\/updates\//);
        return send('whatsapp', to, params[1]);
    };
    await Promise.all([Member, Order, Plan, Announcement, Notification, Job, Log].map(model => model.createIndexes()));
    for (const [key, audience] of [['basic', 'business'], ['intermediate', 'business'], ['student', 'student'], ['aspirant', 'aspirant']]) {
        await Plan.create({ key, name: key, audience, amountPaise: 100, isActive: key !== 'basic' });
    }
    const members = {};
    const kinds = ['basic', 'intermediate', 'student', 'aspirant', 'lifetime', 'unpaid', 'expired', 'other_region'];
    for (const [index, kind] of kinds.entries()) {
        members[kind] = await Member.create({ fullName: `Local ${kind}`, email: `${kind}@example.test`, phoneNumber: `9123450${String(index).padStart(3, '0')}`,
            role: 'member', isActive: true, state: 'Tamil Nadu', district: 'Chennai', block: kind === 'other_region' ? 'Other Block' : 'Test Block',
            memberType: kind === 'student' ? 'student' : 'business', membershipStatus: kind === 'unpaid' ? 'pending' : 'active',
            membershipType: kind === 'lifetime' ? 'lifetime' : 'annual', membershipExpiresAt: new Date(Date.now() + (kind === 'expired' ? -2 : 30) * 86400000) });
        assert.equal((await prefs.get(members[kind]._id)).whatsapp, false);
        await prefs.update(members[kind]._id, { whatsapp: true });
        if (!['unpaid', 'lifetime'].includes(kind)) await Order.collection.insertOne({ memberId: members[kind]._id,
            orderId: `local-${kind}`, orderType: 'membership', status: 'paid', paidAt: new Date(),
            planId: ['expired', 'other_region'].includes(kind) ? 'basic' : kind });
    }
    const expected = {
        basic: ['all', 'paid', 'paid_non_student', 'business', 'plans:basic'],
        intermediate: ['all', 'paid', 'paid_non_student', 'business', 'plans:intermediate'],
        student: ['all', 'paid', 'student', 'plans:student'],
        aspirant: ['all', 'paid', 'paid_non_student', 'aspirant', 'plans:aspirant'],
        lifetime: ['all', 'paid', 'paid_non_student', 'lifetime'], unpaid: ['all', 'unpaid'], expired: ['all', 'unpaid'], other_region: [],
    };
    for (const key of [...new Set(Object.values(expected).flat())]) {
        const [audience, plan] = key.split(':');
        await service.create({ title: key, body: 'Dear member, thank you for joining ACTIV.', status: 'published',
            audience, state: 'Tamil Nadu', district: 'Chennai', block: 'Test Block', ...(plan ? { planKeys: [plan] } : {}) });
    }
    const drain = async () => {
        for (let index = 0; index < 80; index++) {
            await broadcast.processBatch(); await delivery.processBatch();
            if (!await Job.exists({ status: 'pending' }) && !await Notification.exists({ $or: [{ 'updateDelivery.email.status': 'pending' }, { 'updateDelivery.whatsapp.status': 'pending' }] })) return;
        }
        throw new Error('Queue did not drain');
    };
    await drain();
    for (const [kind, member] of Object.entries(members)) for (const channel of ['email', 'whatsapp']) {
        const to = channel === 'email' ? member.email : prefs.phoneFor(member);
        assert.deepEqual(calls.filter(call => call.channel === channel && call.to === to).map(call => call.title).sort(), expected[kind].slice().sort(), `${kind} ${channel} segment + region`);
    }
    const count = calls.length; await Promise.all([delivery.processBatch(), delivery.processBatch()]);
    assert.equal(calls.length, count, 'restarted/concurrent workers do not repeat accepted deliveries');

    const draft = await service.create({ title: 'Unpublished draft', body: 'This is not ready to send.', status: 'draft', audience: 'all' });
    assert.equal(await Job.countDocuments({ sourceId: draft.id }), 0, 'drafts never enter the recipient queue');
    const ordinary = await Notification.create({ user: members.basic._id, title: 'Account message', message: 'An existing account notice' });
    assert(!ordinary.updateDelivery?.email && !ordinary.updateDelivery?.whatsapp, 'ordinary notices do not start update deliveries');

    // Isolated queued notice makes each late-state transition explicit.
    const queued = async (title, audience = 'plans', planKeys = ['basic']) => {
        const update = await Announcement.create({ title, body: 'Please review this update. Thank you.', status: 'published', audience, planKeys,
            state: 'Tamil Nadu', district: 'Chennai', block: 'Test Block' });
        const job = await Job.findOne({ sourceId: update._id }).lean();
        await Job.updateOne({ _id: job._id }, { $set: { status: 'done' } });
        const row = await Notification.create(broadcast.notice(job, update.toObject(), members.basic));
        return { update, row: row.toObject() };
    };
    let item = await queued('Concurrent pending workers');
    await Promise.all([delivery.processBatch(), delivery.processBatch()]);
    for (const channel of ['email', 'whatsapp']) {
        assert.equal(calls.filter(call => call.title === item.update.title && call.channel === channel).length, 1, 'only one worker contacts each channel');
    }

    item = await queued('Template awaiting approval');
    templateReview.status = async () => ({ ready: false, checked: true, status: 'PENDING', reason: 'Waiting for Meta approval.' });
    await delivery.processBatch();
    assert.equal(calls.filter(call => call.title === item.update.title && call.channel === 'email').length, 1);
    assert(!calls.some(call => call.title === item.update.title && call.channel === 'whatsapp'));
    let held = await Notification.findById(item.row._id).lean();
    assert.equal(held.updateDelivery.whatsapp.status, 'pending');
    assert.equal(held.updateDelivery.whatsapp.attempts, 0, 'approval waiting does not exhaust provider retries');
    assert.equal(await Log.countDocuments({ 'data.notificationId': String(item.row._id), channel: 'whatsapp' }), 0);
    templateReview.status = async () => ({ ready: true, checked: true, status: 'APPROVED' });
    await Notification.updateOne({ _id: item.row._id }, { $set: { 'updateDelivery.whatsapp.nextAttemptAt': new Date(0) } });
    await delivery.processBatch();
    assert.equal(calls.filter(call => call.title === item.update.title && call.channel === 'whatsapp').length, 1, 'approval releases the original job');
    assert.equal(calls.filter(call => call.title === item.update.title && call.channel === 'email').length, 1, 'approval does not repeat email');

    item = await queued('Queue age expired');
    await Notification.collection.updateOne({ _id: item.row._id }, { $set: { createdAt: new Date(Date.now() - 8 * 86400000) } });
    await delivery.processBatch();
    assert(!calls.some(call => call.title === item.update.title), 'old queue rows expire even if the update stays published');

    item = await queued('Opt out before send');
    await prefs.update(members.basic._id, { email: false, whatsapp: false });
    await delivery.processBatch();
    assert(!calls.some(call => call.title === item.update.title));
    assert.equal((await Notification.findById(item.row._id)).updateDelivery.email.status, 'skipped');
    await prefs.update(members.basic._id, { email: true, whatsapp: true });

    item = await queued('Number changed');
    await Member.updateOne({ _id: members.basic._id }, { $set: { whatsappNumber: '9123450999' } });
    assert.equal((await prefs.get(members.basic._id)).whatsapp, false, 'old phone consent does not transfer');
    await delivery.processBatch();
    assert(!calls.some(call => call.title === item.update.title && call.channel === 'whatsapp'));
    await Member.updateOne({ _id: members.basic._id }, { $set: { whatsappNumber: '' } });
    await prefs.update(members.basic._id, { whatsapp: true });

    item = await queued('Member upgraded');
    await Order.collection.insertOne({ memberId: members.basic._id, orderId: 'new-plan', orderType: 'membership', status: 'paid', planId: 'intermediate', planAudience: 'business', paidAt: new Date(Date.now() + 1000) });
    await delivery.processBatch(); assert(!calls.some(call => call.title === item.update.title));
    await Order.deleteOne({ orderId: 'new-plan' });

    item = await queued('Membership expired');
    await Member.updateOne({ _id: members.basic._id }, { $set: { membershipExpiresAt: new Date(Date.now() - 2 * 86400000) } });
    await delivery.processBatch(); assert(!calls.some(call => call.title === item.update.title));
    await Member.updateOne({ _id: members.basic._id }, { $set: { membershipExpiresAt: new Date(Date.now() + 30 * 86400000) } });

    item = await queued('Region changed');
    await Member.updateOne({ _id: members.basic._id }, { $set: { block: 'Elsewhere' } });
    await delivery.processBatch(); assert(!calls.some(call => call.title === item.update.title));
    await Member.updateOne({ _id: members.basic._id }, { $set: { block: 'Test Block' } });

    for (const change of ['withdrawn', 'expired', 'revised', 'deleted']) {
        item = await queued(`Update ${change}`);
        if (change === 'deleted') await Announcement.deleteOne({ _id: item.update._id });
        else await Announcement.collection.updateOne({ _id: item.update._id }, { $set: change === 'withdrawn' ? { status: 'draft' }
            : change === 'expired' ? { expiresAt: new Date(0) } : { body: 'A different revision' } });
        await delivery.processBatch(); assert(!calls.some(call => call.title === item.update.title), change);
    }

    // A temporary provider failure retries only its own channel. The retry
    // rechecks membership/region/content instead of replaying stored HTML.
    item = await queued('Transient failure'); failures.set('email:Transient failure', 'SMTP temporarily unavailable');
    await delivery.processBatch();
    assert.equal(calls.filter(call => call.title === 'Transient failure' && call.channel === 'whatsapp').length, 1);
    failures.delete('email:Transient failure');
    await Notification.updateOne({ _id: item.row._id }, { $set: { 'updateDelivery.email.nextAttemptAt': new Date(0) } });
    await delivery.processBatch();
    assert.equal(calls.filter(call => call.title === 'Transient failure' && call.channel === 'email').length, 2);
    assert.equal(calls.filter(call => call.title === 'Transient failure' && call.channel === 'whatsapp').length, 1);
    const oldLog = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'email', status: 'failed' }).lean();
    assert(oldLog.resentAs, 'retry attempts are linked');
    assert((await notifications.retryLog(oldLog._id)).skipped, 'an older failed attempt is not replayed');

    item = await queued('Permanent failure'); failures.set('whatsapp:Permanent failure', '132001 template does not exist');
    await delivery.processBatch();
    let log = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'whatsapp' }).lean();
    assert.equal((await Notification.findById(item.row._id)).updateDelivery.whatsapp.status, 'failed');
    await prefs.update(members.basic._id, { whatsapp: false });
    assert((await notifications.retryLog(log._id)).skipped, 'manual retry respects opt-out');
    await prefs.update(members.basic._id, { whatsapp: true });

    item = await queued('Webhook reports failure'); await delivery.processBatch();
    log = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'whatsapp' });
    log.status = 'failed'; log.deliveryStatus = 'failed'; log.lastError = '131016 temporarily unavailable'; await log.save();
    const results = await Promise.all([notifications.retryLog(log._id), notifications.retryLog(log._id)]);
    assert.equal(results.filter(result => result.outcome?.success).length, 1, 'one retry owns the failed webhook attempt');
    assert.equal(calls.filter(call => call.title === item.update.title && call.channel === 'whatsapp').length, 2);

    item = await queued('Worker interrupted');
    const uncertainLog = await Log.create({ user: members.basic._id, event: 'ASSOCIATION_UPDATE', channel: 'email',
        recipient: members.basic.email, status: 'queued', data: { notificationId: String(item.row._id) } });
    await Notification.updateOne({ _id: item.row._id }, { $set: { 'updateDelivery.email.status': 'sending', 'updateDelivery.email.worker': 'old-worker',
        'updateDelivery.email.logId': uncertainLog._id, 'updateDelivery.email.leaseUntil': new Date(0), 'updateDelivery.whatsapp.status': 'skipped' } });
    await delivery.recover('email'); await delivery.processBatch();
    assert(!calls.some(call => call.title === item.update.title), 'an unknown provider outcome is not replayed');

    item = await queued('Worker stopped before provider');
    await Notification.updateOne({ _id: item.row._id }, { $set: { 'updateDelivery.email.status': 'sending', 'updateDelivery.email.worker': 'old-worker',
        'updateDelivery.email.leaseUntil': new Date(0), 'updateDelivery.whatsapp.status': 'skipped' } });
    await delivery.recover('email'); await delivery.processBatch();
    assert.equal(calls.filter(call => call.title === item.update.title && call.channel === 'email').length, 1, 'unattempted work resumes after restart');

    item = await queued('Transport timeout'); failures.set('email:Transport timeout', 'Timeout waiting for server reply');
    await delivery.processBatch();
    log = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'email' });
    assert.equal(log.data.outcomeUnknown, true);
    assert((await notifications.retryLog(log._id)).skipped, 'timeout cannot safely prove the provider rejected a send');

    item = await queued('Transport pipe closed'); failures.set('email:Transport pipe closed', 'write EPIPE');
    await delivery.processBatch();
    log = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'email' });
    assert.equal(log.data.outcomeUnknown, true, 'a broken transport cannot prove the provider rejected a send');
    assert((await notifications.retryLog(log._id)).skipped, 'a broken pipe is held for review instead of duplicated');

    for (const smtpRecipientStatus of ['unknown', 'partial']) {
        item = await queued(`SMTP ${smtpRecipientStatus}`);
        failures.set(`email:SMTP ${smtpRecipientStatus}`, { success: false, outcomeUnknown: true,
            autoRetryDisabled: true, smtpRecipientStatus, error: 'SMTP acceptance needs review before sending again.' });
        await delivery.processBatch();
        log = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'email' });
        assert.equal(log.data.smtpRecipientStatus, smtpRecipientStatus);
        assert.equal(log.data.autoRetryDisabled, true);
        assert.equal((await Notification.findById(item.row._id)).updateDelivery.email.status, 'failed');
        const before = calls.length;
        await delivery.processBatch();
        assert((await notifications.retryLog(log._id)).skipped);
        assert.equal(calls.length, before, 'uncertain SMTP metadata never replays through association retries');
    }

    item = await queued('Acceptance persisted'); await delivery.processBatch();
    const beforeRecovery = calls.length;
    await Notification.updateOne({ _id: item.row._id }, { $set: { 'updateDelivery.email.status': 'sending', 'updateDelivery.email.worker': 'old-worker', 'updateDelivery.email.leaseUntil': new Date(0) } });
    await delivery.recover('email'); await delivery.processBatch();
    assert.equal(calls.length, beforeRecovery, 'accepted audit survives a worker restart without replay');
    assert.equal((await Notification.findById(item.row._id)).updateDelivery.email.status, 'sent');

    item = await queued('Queue write failed after acceptance');
    const originalUpdateOne = Notification.updateOne;
    let failQueueWrite = true;
    Notification.updateOne = function(query, update, ...rest) {
        if (failQueueWrite && String(query._id) === String(item.row._id) && update.$set?.['updateDelivery.email.status'] === 'sent') {
            failQueueWrite = false;
            throw new Error('Local simulated queue-write interruption');
        }
        return originalUpdateOne.call(this, query, update, ...rest);
    };
    try { await delivery.processBatch(); } finally { Notification.updateOne = originalUpdateOne; }
    log = await Log.findOne({ 'data.notificationId': String(item.row._id), channel: 'email' });
    assert.equal(failQueueWrite, false, 'the queue-write failure was exercised after the provider accepted');
    assert.equal(log.status, 'sent', 'a queue-write failure must preserve confirmed acceptance in the audit');
    assert.equal(log.deliveryStatus, 'accepted');
    assert(!log.data.outcomeUnknown, 'persisted acceptance is a known outcome');
    await delivery.processBatch();
    assert.equal(calls.filter(call => call.title === item.update.title && call.channel === 'email').length, 1);

    item = await queued('Deleted member');
    await Member.updateOne({ _id: members.basic._id }, { $set: { isActive: false } });
    await delivery.processBatch(); assert(!calls.some(call => call.title === item.update.title));
    await Member.updateOne({ _id: members.basic._id }, { $set: { isActive: true } });

    // Route validation, authentication and safe member-facing serialization.
    const app = require('express')(); app.use(require('express').json());
    app.use('/notifications', require('../src/modules/notifications/notification.routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const request = require('supertest');
    const token = require('jsonwebtoken').sign({ userId: String(members.basic._id), role: 'member' }, process.env.JWT_SECRET);
    assert.equal((await request(app).get('/notifications/update-preferences')).status, 401);
    assert.equal((await request(app).patch('/notifications/update-preferences').set('Authorization', `Bearer ${token}`).send({ whatsapp: 'true' })).status, 400);
    const result = await request(app).patch('/notifications/update-preferences').set('Authorization', `Bearer ${token}`).send({ email: false, whatsapp: true });
    assert.equal(result.status, 200); assert.equal(result.body.data.email, false); assert.equal(result.body.data.whatsapp, true);
    const feed = await notifications.getUserNotifications(members.basic._id);
    assert(feed.notifications.every(row => !row.updateDelivery && !row.push));

    const rendered = messages.render({ _id: item.update._id, title: '<b>Member update</b>', body: '<script>alert(1)</script><p>Dear member &amp; friends</p><p>Thank you.</p>',
        bannerUrl: 'javascript:alert(2)', attachmentUrl: 'https://example.test/circular.pdf', attachmentLabel: 'Read circular' }, { fullName: '<img src=x onerror=alert(3)>' });
    assert(!rendered.html.includes('<script>')); assert(!rendered.html.includes('onerror=')); assert(!rendered.html.includes('javascript:'));
    assert(rendered.html.includes('Dear member &amp; friends')); assert(rendered.html.includes('/member/settings'));
    assert(rendered.text.includes('Read circular: https://example.test/circular.pdf')); assert(rendered.whatsappText.includes('Thank you'));
    console.log('PASS: all audiences/plans/regions on email+WhatsApp; consent and number change; expiry, upgrade, revision, withdrawal and deletion; channel retries, webhook concurrency, unknown outcomes; API auth/validation and safe email formatting. No external delivery.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
