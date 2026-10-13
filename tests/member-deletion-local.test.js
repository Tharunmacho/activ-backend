// Local, disposable Mongo only. No production data or message delivery.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'local-deletion-access-test';
process.env.JWT_REFRESH_SECRET = 'local-deletion-refresh-test';
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Auth = require('../src/modules/auth/auth.model');
    await Promise.all([Member.createIndexes(), Auth.createIndexes()]);
    require('../src/modules/notifications/notification.service').dispatchInBackground = () => {};
    require('../src/modules/regions/region.service').validateRegion = async input => ({ ok: true, region: input });
    const auth = require('../src/modules/auth/auth.service');
    const deletion = require('../src/modules/members/memberDeletion.service');
    const registry = require('../src/modules/admin/membershipIdRegister.service');
    const cache = require('../src/core/cache/cacheClient');
    const { CACHE_KEYS } = require('../src/core/cache/cacheKeys');
    const { verifyToken, optionalAuth } = require('../src/core/middleware/auth');
    const actor = { role: 'super_admin', userId: new mongoose.Types.ObjectId().toString() };
    const layout = require('../src/config/dataLayout');
    const raw = name => {
        const [area, table] = layout.MODELS[name];
        return mongoose.connection.getClient().db(layout.dbName(area)).collection(table);
    };
    const input = { fullName: 'Deletion fixture', email: 'delete-me@example.test', password: 'Old-password-123!', phoneNumber: '9123456780', state: 'Test', district: 'District', block: 'Block' };
    const first = await auth.register(input);
    const id = String(first.user.id);
    const member = await Member.findById(id);
    const tokens = auth.generateTokens(member);
    await Member.updateOne({ _id: id }, { $set: { membershipNumber: 'ACTIV-STU-20261013-001' } });
    const credential = await Auth.findOne({ email: input.email });
    const companyId = new mongoose.Types.ObjectId();
    const conversationId = new mongoose.Types.ObjectId();
    const unrelatedId = new mongoose.Types.ObjectId();
    const fixtures = {
        Application: { userId: member._id },
        PersonalInfo1: { userId: String(credential._id) },
        MemberDeclaration: { memberId: id },
        BusinessInfo: { userId: credential._id },
        MemberFinancialInfo: { memberId: id },
        Company: { _id: companyId, userId: id },
        Product: { companyId },
        StockMovement: { companyId },
        TrustedCompany: { companyId, userId: String(unrelatedId) },
        Engagement: { ownerId: id },
        Conversation: { _id: conversationId, participants: [member._id, unrelatedId] },
        Message: { conversationId, senderId: unrelatedId },
        Connection: { recipientId: member._id },
        PlatinumRequest: { memberId: id },
        Activity: { memberId: id },
        Notification: { user: member._id },
        NotificationLog: { data: { memberId: id } },
        PaymentOrder: { memberId: id, orderType: 'membership' },
    };
    for (const [name, data] of Object.entries(fixtures)) {
        await raw(name).insertOne({ ...data, testMarker: 'remove' });
        await raw(name).insertOne({ userId: unrelatedId, memberId: unrelatedId, testMarker: 'keep' });
    }
    await raw('PaymentOrder').insertOne({ memberId: id, orderType: 'event_booking', testMarker: 'event-payment' });
    await raw('EventBooking').insertOne({ memberId: id, testMarker: 'keep-event' });
    const middleware = (handler, token) => new Promise((resolve, reject) => {
        const req = { headers: { authorization: `Bearer ${token}` } };
        handler(req, {}, error => error ? reject(error) : resolve(req));
    });
    await middleware(verifyToken, tokens.accessToken);
    await assert.rejects(deletion.remove(id, { role: 'state_admin' }), e => e.statusCode === 403);
    await Promise.all([deletion.remove(id, actor), deletion.remove(id, actor)]);
    assert.equal(await Member.findById(id), null);
    assert.equal(await Auth.findOne({ email: input.email }), null);
    assert.equal(await cache.get(CACHE_KEYS.USER(id)), null);
    await assert.rejects(auth.login(input.email, input.password), e => e.statusCode === 401);
    await assert.rejects(auth.refreshToken(tokens.refreshToken), e => e.statusCode === 401);
    await assert.rejects(middleware(verifyToken, tokens.accessToken), e => e.statusCode === 401);
    assert.equal((await middleware(optionalAuth, tokens.accessToken)).user, null);
    await assert.rejects(registry.detail(id, actor), e => e.statusCode === 404);
    assert.equal(await Member.collection.findOne({ _id: member._id }), null, 'no archived member remains in MongoDB');
    for (const name of Object.keys(fixtures)) {
        assert.equal(await raw(name).countDocuments({ testMarker: 'remove' }), 0, `${name} owned data removed`);
        assert.equal(await raw(name).countDocuments({ testMarker: 'keep' }), 1, `${name} unrelated data preserved`);
    }
    assert.equal(await raw('PaymentOrder').countDocuments({ testMarker: 'event-payment' }), 1);
    assert.equal(await raw('EventBooking').countDocuments({ testMarker: 'keep-event' }), 1);
    assert(await layout.collection('membershipCounters').findOne({ _id: 'number:ACTIV-STU-20261013-001' }));
    const next = await auth.register({ ...input, password: 'New-password-123!' });
    assert.notEqual(String(next.user.id), id);
    assert.equal(next.memberDetails.membershipStatus, 'pending');
    assert.equal(next.memberDetails.membershipType, 'none');
    assert(!next.memberDetails.membershipNumber);
    await assert.rejects(require('../src/modules/members/memberNumber').reserveMembershipNumber(
        { _id: new mongoose.Types.ObjectId(String(next.user.id)) }, 'ACTIV-STU-20261013-001'
    ), e => e.statusCode === 409);
    await auth.login(input.email, 'New-password-123!');
    await assert.rejects(auth.login(input.email, input.password), e => e.statusCode === 401);
    await deletion.remove(id, actor); // A repeated old delete cannot erase the new login.
    await auth.login(input.email, 'New-password-123!');
    await assert.rejects(middleware(verifyToken, tokens.accessToken), e => e.statusCode === 401);
    // Accounts archived by previous releases also free their email safely.
    const old = await auth.register({ ...input, email: 'legacy-delete@example.test', phoneNumber: '9234567801' });
    await Member.updateOne({ _id: old.user.id }, { $set: { deletedAt: new Date(), isActive: false } });
    const fresh = await auth.register({ ...input, email: 'legacy-delete@example.test', phoneNumber: '9234567801' });
    assert.notEqual(String(fresh.user.id), String(old.user.id));
    assert.equal(await Member.collection.findOne({ _id: new mongoose.Types.ObjectId(String(old.user.id)) }), null);
    // A failed dependent delete must fail the request, lock login immediately,
    // and retain a root that an administrator can safely retry.
    const retry = await auth.register({ ...input, email: 'retry@example.test', phoneNumber: '9345678012' });
    const retryId = new mongoose.Types.ObjectId(String(retry.user.id));
    await raw('Application').insertOne({ userId: retryId });
    const prototype = Object.getPrototypeOf(raw('Application'));
    const originalDeleteMany = prototype.deleteMany;
    let failOnce = true;
    prototype.deleteMany = function (...args) {
        if (this.collectionName === layout.MODELS.Application[1] && failOnce) {
            failOnce = false;
            return Promise.reject(new Error('Simulated dependent write failure'));
        }
        return originalDeleteMany.apply(this, args);
    };
    try {
        await assert.rejects(deletion.remove(retryId, actor), /Simulated dependent write failure/);
        const locked = await Member.collection.findOne({ _id: retryId });
        assert(locked.deletedAt);
        assert.equal(locked.isActive, false);
        await assert.rejects(auth.login('retry@example.test', input.password), e => e.statusCode === 401 || e.statusCode === 403);
        await deletion.remove(retryId, actor);
        assert.equal(await Member.collection.findOne({ _id: retryId }), null);
        assert.equal(await raw('Application').countDocuments({ userId: retryId }), 0);
    } finally { prototype.deleteMany = originalDeleteMany; }
    console.log('PASS permanent deletion: Super Admin only; related rows physically removed; unrelated/event records preserved; concurrent and failed deletions retry safely; sessions revoked; IDs reserved; fresh registration works.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
