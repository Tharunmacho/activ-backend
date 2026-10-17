// Real persistence and visibility checks against disposable loopback Mongo only.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false', JWT_SECRET: 'local-update-test-only' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Order = require('../src/modules/payment/paymentorder.model');
    const Plan = require('../src/modules/members/membershipplan.model');
    const Announcement = require('../src/modules/announcements/announcement.model');
    const Notification = require('../src/modules/notifications/notification.model');
    const Job = require('../src/modules/notifications/broadcast.model');
    const service = require('../src/modules/announcements/announcement.service');
    const contexts = require('../src/modules/common/memberContext');
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    const notifications = require('../src/modules/notifications/notification.service');
    const push = require('../src/modules/notifications/push.service');
    await Promise.all([Member, Order, Plan, Announcement, Notification, Job].map(m => m.createIndexes()));
    for (const [key, audience] of [['basic', 'business'], ['intermediate', 'business'], ['student', 'student'], ['aspirant', 'aspirant'], ['platinum', 'platinum']]) {
        await Plan.create({ key, name: key, audience, amountPaise: 100, isActive: key !== 'basic' });
    }
    const members = {};
    for (const kind of ['basic', 'intermediate', 'student', 'aspirant', 'lifetime', 'unpaid', 'expired', 'expired_student']) {
        members[kind] = await Member.create({ fullName: `Test ${kind}`, email: `${kind}@example.test`, phoneNumber: '9123456780',
            role: 'member', isActive: true, state: 'Tamil Nadu', district: 'Chennai', block: 'Test Block', memberType: kind.includes('student') ? 'student' : 'business',
            membershipStatus: kind === 'unpaid' ? 'pending' : 'active', membershipType: kind === 'lifetime' ? 'lifetime' : 'annual',
            membershipExpiresAt: new Date(Date.now() + (kind.startsWith('expired') ? -2 : 30) * 86400000) });
        if (!['unpaid', 'lifetime'].includes(kind)) await Order.collection.insertOne({ memberId: members[kind]._id,
            orderId: `local-${kind}`, orderType: 'membership', status: 'paid', paidAt: new Date(),
            // Exercise catalogue fallback for old receipts without planAudience.
            planId: kind === 'expired' ? 'basic' : kind === 'expired_student' ? 'student' : kind });
    }
    const context = async kind => contexts.resolveMemberContext({ user: { userId: String(members[kind]._id), role: 'member' } });
    const expected = {
        basic: ['paid_non_student', 'business', 'plans:basic'], intermediate: ['paid_non_student', 'business', 'plans:intermediate'],
        student: ['student', 'plans:student'], aspirant: ['paid_non_student', 'aspirant', 'plans:aspirant'],
        lifetime: ['paid_non_student', 'lifetime', 'plans:platinum'], unpaid: ['unpaid'], expired: ['unpaid'], expired_student: ['unpaid'],
    };
    const updates = {};
    for (const key of ['paid_non_student', 'business', 'aspirant', 'student', 'lifetime', 'unpaid', 'plans:basic', 'plans:intermediate', 'plans:student', 'plans:aspirant', 'plans:platinum']) {
        const [audience, plan] = key.split(':');
        updates[key] = await service.create({ title: key, body: 'Dear member, thank you for being part of ACTIV.', status: 'published', audience, deliveryChannels: { email: false, whatsapp: false, push: true }, ...(plan ? { planKeys: [plan] } : {}) });
    }
    for (const kind of Object.keys(members)) {
        const ctx = await context(kind);
        assert.deepEqual((await service.listForMember(ctx)).announcements.map(a => a.title).sort(), expected[kind].slice().sort(), `${kind} feed`);
        for (const [key, update] of Object.entries(updates)) {
            if (expected[kind].includes(key)) await service.getForMember(update.id, ctx);
            else await assert.rejects(service.getForMember(update.id, ctx), e => e.statusCode === 404, `${kind} cannot open ${key}`);
        }
    }
    for (let i = 0; i < 20; i++) await broadcast.processBatch();
    for (const kind of Object.keys(members)) {
        assert.equal(await Notification.countDocuments({ user: members[kind]._id }), expected[kind].length, `${kind} queued recipients`);
        const result = await notifications.getUserNotifications(members[kind]._id, 1, 100, await context(kind));
        assert.equal(result.notifications.length, expected[kind].length, `${kind} notification visibility`);
        for (const row of await Notification.find({ user: members[kind]._id }).lean()) assert.equal(await push.stillVisible(row), true);
    }
    // Mutable profile changes and unconfirmed payments cannot change purchased-plan targeting.
    await Member.updateOne({ _id: members.student._id }, { $set: { memberType: 'business' } });
    await Order.collection.insertOne({ memberId: members.student._id, orderId: 'pending-upgrade', orderType: 'membership', status: 'created',
        planId: 'intermediate', planAudience: 'business', paidAt: new Date(Date.now() + 10000) });
    contexts.invalidateMemberContext(members.student._id);
    assert.equal((await context('student')).paidPlanKey, 'student');
    await assert.rejects(service.getForMember(updates['plans:intermediate'].id, await context('student')), e => e.statusCode === 404);
    // Lifetime grants supersede prior annual receipts even without a new receipt.
    await Order.collection.insertOne({ memberId: members.lifetime._id, orderId: 'old-annual', orderType: 'membership', status: 'paid', planId: 'basic', planAudience: 'business', paidAt: new Date() });
    contexts.invalidateMemberContext(members.lifetime._id);
    assert.equal((await context('lifetime')).paidPlanKey, 'platinum');
    await assert.rejects(service.getForMember(updates['plans:basic'].id, await context('lifetime')), e => e.statusCode === 404);
    // A real upgrade changes feed, existing notification visibility and send-time eligibility.
    const oldStudentNotice = await Notification.findOne({ user: members.student._id, 'data.sourceId': updates['plans:student'].id }).lean();
    await Order.collection.insertOne({ memberId: members.student._id, orderId: 'paid-upgrade', orderType: 'membership', status: 'paid', planId: 'intermediate', planAudience: 'business', paidAt: new Date(Date.now() + 20000) });
    contexts.invalidateMemberContext(members.student._id);
    assert.equal((await context('student')).paidPlanKey, 'intermediate');
    assert.equal(await push.stillVisible(oldStudentNotice), false);
    assert(!(await notifications.getUserNotifications(members.student._id, 1, 100, await context('student'))).notifications.some(n => n.data.sourceId === updates['plans:student'].id));
    await service.getForMember(updates['plans:intermediate'].id, await context('student'));

    // JSON/multipart keys, multiple selections, editing and catalog validation.
    const multiple = await service.create({ title: 'Selected business plans', body: 'Thank you.', audience: 'plans', planKeys: '["basic","intermediate"]', status: 'published' });
    assert.deepEqual(multiple.planKeys, ['basic', 'intermediate']);
    assert.deepEqual((await service.update(multiple.id, { title: 'Edited selected plans' })).planKeys, multiple.planKeys);
    assert.deepEqual((await service.update(multiple.id, { audience: 'all' })).planKeys, []);
    for (const planKeys of [[], ['missing'], ['basic', 'basic'], ['basic', 'BASIC'], 'bad json', [null]]) {
        await assert.rejects(service.create({ title: 'Invalid selection', audience: 'plans', planKeys }), e => e.statusCode === 400);
    }
    for (const value of ['javascript:alert(1)', 'data:image/png;base64,x', '//example.test/x.png', '/uploads/../private.png', 'file:///private.png']) {
        for (const key of ['bannerUrl', 'attachmentUrl']) await assert.rejects(service.create({ title: 'Invalid media', [key]: value }), e => e.statusCode === 400);
    }
    const draft = await service.create({ title: 'Title-only draft' });
    assert.equal(draft.status, 'draft');
    assert.equal(await Job.countDocuments({ sourceId: draft.id }), 0);
    await assert.rejects(service.setStatus(draft.id, 'published'), e => e.statusCode === 400);
    await service.update(draft.id, { bannerUrl: '/uploads/poster.png', bannerAlt: 'Membership workshop poster' });
    await service.setStatus(draft.id, 'published');
    assert.equal(await Job.countDocuments({ sourceId: draft.id }), 1);
    await service.update(draft.id, { bannerUrl: '/uploads/revised-poster.png' });
    assert.equal(await Job.countDocuments({ sourceId: draft.id }), 2, 'media-only edit queues revised update');
    await service.update(draft.id, { attachmentUrl: 'https://example.test/circular.pdf', attachmentLabel: 'Circular' });
    assert.equal(await Job.countDocuments({ sourceId: draft.id }), 3, 'document-only edit queues revised update');
    await assert.rejects(service.update(draft.id, { bannerUrl: '', attachmentUrl: '' }), e => e.statusCode === 400, 'published updates cannot become empty');
    await service.setStatus(draft.id, 'draft');
    await assert.rejects(service.getForMember(draft.id, await context('basic')), e => e.statusCode === 404);
    // Exercise the real authenticated route and its multipart array contract.
    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json());
    app.use('/announcements', require('../src/modules/announcements/announcement.routes'));
    app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ message: err.message }));
    const jwt = require('jsonwebtoken');
    const adminToken = jwt.sign({ userId: String(new mongoose.Types.ObjectId()), role: 'super_admin' }, process.env.JWT_SECRET);
    const created = await request(app).post('/announcements').set('Authorization', `Bearer ${adminToken}`)
        .field('title', 'Multipart selected plans').field('audience', 'plans').field('planKeys', '["basic","aspirant"]');
    assert.equal(created.status, 201); assert.deepEqual(created.body.data.planKeys, ['basic', 'aspirant']);
    const invalidPublish = await request(app).patch(`/announcements/${created.body.data.id}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'published' });
    assert.equal(invalidPublish.status, 400);
    const memberToken = jwt.sign({ userId: String(members.basic._id), role: 'member' }, process.env.JWT_SECRET);
    const forbidden = await request(app).post('/announcements').set('Authorization', `Bearer ${memberToken}`).send({ title: 'Member cannot publish' });
    assert.equal(forbidden.status, 403);
    console.log('PASS: catalog plan audiences, non-student targeting, expired and upgraded memberships, feed/direct/queue/send visibility, media edits and publish validation. No external delivery.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
