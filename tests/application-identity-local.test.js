// Disposable loopback Mongo: no credentials, notifications or external writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false', REDIS_ENABLED: 'false' });
require('dotenv').config = () => ({ parsed: {} });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Application = require('../src/modules/applications/application.model');
    const { Claim, reserveApplicationId } = require('../src/modules/applications/applicationSubmissionClaim');
    const identity = require('../src/modules/applications/applicationIdentity');
    const service = require('../src/modules/applications/application.service');
    const region = { state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur' };
    const a = await Member.create({ ...region, fullName: 'Identity A', email: 'owner-a@example.test', phoneNumber: '9123456780' });
    const b = await Member.create({ ...region, fullName: 'Identity B', email: 'owner-b@example.test', phoneNumber: '9123456781' });
    // Corrupt legacy alias must not let B borrow A's identity or vice versa.
    await Member.collection.updateOne({ _id: b._id }, { $set: { memberId: a._id } });
    const file = (owner, status, createdAt, email = a.email) => Application.create({ userId: owner, ...region, fullName: 'Application', email, phone: '9123456780', status, createdAt });
    const approved = await file(a._id, 'Approved', new Date('2026-01-01'));
    const duplicate = await file(a.userId, 'Pending', new Date('2026-02-01'));
    const foreign = await file(b._id, 'Pending', new Date('2026-03-01'));
    const rejected1 = await file(a._id, 'Rejected', new Date('2025-01-01'));
    const rejected2 = await file(a._id, 'Rejected', new Date('2025-02-01'));
    const visible = await identity.filterCurrentApplications(await Application.find().lean());
    assert.deepEqual(visible.map(row => String(row._id)).sort(), [approved, foreign].map(row => String(row._id)).sort());
    const history = await service.getUserApplications(a._id);
    assert.deepEqual(history.map(row => String(row._id)).sort(), [approved, rejected1, rejected2].map(row => String(row._id)).sort());
    assert(!history.some(row => String(row._id) === String(foreign._id)), 'conflicting profile aliases never expose another owner history');
    const otherHistory = await service.getUserApplications(b._id);
    assert.deepEqual(otherHistory.map(row => String(row._id)), [String(foreign._id)], 'matching submitted email never adopts another owner application');
    const before = await Application.collection.findOne({ _id: approved._id });
    for (const tier of ['block', 'district', 'state', 'super']) {
        await assert.rejects(() => service.decide(duplicate._id, 'approve', tier, new mongoose.Types.ObjectId()), error => error.statusCode === 409);
    }
    await assert.rejects(() => service.updateApplicationStatus(duplicate._id, 'Approved', '', new mongoose.Types.ObjectId()), error => error.statusCode === 409);
    assert.deepEqual(await Application.collection.findOne({ _id: approved._id }), before, 'stale review links preserve approved membership');
    await Claim.create({ _id: String(b._id), applicationId: approved._id });
    await assert.rejects(() => reserveApplicationId(b._id), error => error.statusCode === 409 && /does not belong/.test(error.message));
    assert.equal(await Application.countDocuments(), 5, 'history and duplicates remain stored unchanged');
    const legacyId = new mongoose.Types.ObjectId();
    await Member.collection.updateOne({ _id: b._id }, { $set: { memberId: legacyId } });
    const legacyOwner = await identity.confirmedOwnerIds([String(legacyId)]);
    assert.equal(legacyOwner.ownerMap.get(String(legacyId)), String(b._id), 'undeclared legacy memberId ObjectIds must resolve from string token IDs');
    console.log('PASS confirmed owner aliases, conflicting identity isolation, same-email separation, retained rejection history, superseded review guards and foreign reservation protection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
