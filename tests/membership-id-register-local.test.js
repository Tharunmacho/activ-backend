// Isolated local Mongo: no real accounts, gateway calls or notification delivery.
const assert = require('node:assert/strict');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
process.env.NODE_ENV = 'test';
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Auth = require('../src/modules/auth/auth.model');
    const Order = require('../src/modules/payment/paymentorder.model');
    const registry = require('../src/modules/admin/membershipIdRegister.service');
    const numbers = require('../src/modules/members/memberNumber');
    const catalogue = require('../src/modules/members/membershipplan.service');
    const category = require('../src/modules/members/membershipIdCategory');
    catalogue.listAll = async () => [
        { key: 'student', name: 'Student', audience: 'student', price: 1000, active: true },
        { key: 'basic', name: 'Beginner', audience: 'business', minYears: 0, maxYears: 5, active: true },
        { key: 'intermediate', name: 'Intermediate', audience: 'business', minYears: 5, maxYears: 10, active: true },
        { key: 'ideal', name: 'Ideal', audience: 'business', minYears: 10, maxYears: null, active: true }
    ];
    const actor = { role: 'super_admin', email: 'admin@example.test' };
    const make = async extra => {
        const member = await Member.create({ fullName: 'Fixture Member', email: new mongoose.Types.ObjectId() + '@example.test', phoneNumber: '9000000000', state: 'Tamil Nadu', district: 'Chennai', block: 'Kodambakkam',
            memberType: 'student', membershipStatus: 'active', membershipType: 'annual', membershipActivatedAt: new Date('2026-10-12T10:00:00+05:30'), membershipExpiresAt: new Date('2027-10-12T00:00:00+05:30'), ...extra });
        return member;
    };
    assert.equal(category.membershipIdCategory({}, { key: 'basic' }), 'BEG');
    assert.equal(category.membershipIdCategory({}, { key: 'intermediate' }), 'INT');
    assert.equal(category.membershipIdCategory({}, { key: 'ideal' }), 'IDL');
    assert.equal(category.membershipIdCategory({}, { key: 'student' }), 'STU');
    assert.equal(category.membershipIdCategory({}, { key: 'aspirant' }), 'ASP');
    assert.equal(category.membershipIdCategory({ membershipTier: 'platinum' }, { key: 'student' }), 'LIF');
    assert.notEqual(category.membershipIdCategory({}, { key: 'custom-a' }), category.membershipIdCategory({}, { key: 'custom-b' }));
    const a = await make({ membershipNumber: 'ACTIV-2026-006' });
    const b = await make({ membershipNumber: 'ACTIV-STU-20261012-002' });
    await Auth.create({ email: a.email, password: 'Local-fixture-123' });
    await assert.rejects(registry.list({}, { role: 'state_admin' }), e => e.statusCode === 403);
    await assert.rejects(registry.detail(String(a._id), { role: 'member' }), e => e.statusCode === 403);
    await assert.rejects(registry.update(String(a._id), {}, { role: 'member' }), e => e.statusCode === 403);
    const initial = await registry.detail(String(a._id), actor);
    assert.equal(initial.validUntil, '2027-10-11');
    const body = { updatedAt: initial.updatedAt, note: 'Correct identity', membershipNumber: 'activ-stu-20261012-010', fullName: 'Corrected Member', city: 'Chennai' };
    const updated = await registry.update(String(a._id), body, actor);
    assert.equal(updated.membershipNumber, 'ACTIV-STU-20261012-010');
    assert.equal(updated.fullName, 'Corrected Member');
    assert.deepEqual(updated.previousIds, ['ACTIV-2026-006']);
    assert.equal(updated.history.length, 1);
    assert.equal(updated.history[0].changes.membershipNumber.before, 'ACTIV-2026-006');
    assert.equal((await registry.list({ search: 'ACTIV-2026-006' }, actor)).rows[0].id, String(a._id));
    assert.equal((await registry.list({ search: '.*' }, actor)).total, 0, 'search treats regex metacharacters as literal text');
    await assert.rejects(registry.update(String(a._id), body, actor), e => e.statusCode === 409);
    await assert.rejects(registry.update(String(a._id), { updatedAt: updated.updatedAt, note: 'Invalid grant', membershipStatus: 'active' }, actor), e => e.statusCode === 400);
    await assert.rejects(registry.update(String(a._id), { updatedAt: updated.updatedAt, note: 'Duplicate', membershipNumber: b.membershipNumber }, actor), e => e.statusCode === 409 && /already exists/i.test(e.message));
    assert.equal((await Member.findById(a._id).lean()).membershipNumber, updated.membershipNumber);
    const bRow = await registry.detail(String(b._id), actor);
    const raceBody = { note: 'Concurrent ID correction', membershipNumber: 'ACTIV-STU-20261012-099' };
    const results = await Promise.allSettled([
        registry.update(String(a._id), { ...raceBody, updatedAt: updated.updatedAt }, actor),
        registry.update(String(b._id), { ...raceBody, updatedAt: bRow.updatedAt }, actor)
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'only one admin write can own a given ID');
    const denied = results.find(r => r.status === 'rejected');
    assert.equal(denied.reason.statusCode, 409);
    assert.equal(await Member.collection.countDocuments({ membershipNumber: raceBody.membershipNumber }), 1);
    const latestA = await registry.detail(String(a._id), actor);
    const contact = await registry.update(String(a._id), { updatedAt: latestA.updatedAt, note: 'Correct login', email: 'corrected@example.test', phoneNumber: '9173652408', validUntil: '2027-12-31' }, actor);
    assert.equal(contact.email, 'corrected@example.test');
    assert.equal(contact.validUntil, '2027-12-31');
    assert(await Auth.findOne({ email: contact.email }));
    assert.equal(await Auth.countDocuments({ email: a.email }), 0, 'login and profile move together');
    assert.equal(+new Date((await Member.findById(a._id)).membershipExpiresAt), +new Date('2028-01-01T00:00:00+05:30'));
    assert.equal(await Order.countDocuments(), 0, 'identity corrections never fabricate or alter payments');
    const generated = await registry.update(String(a._id), { updatedAt: contact.updatedAt, note: 'Issue category ID', generateId: true }, actor);
    assert.match(generated.membershipNumber, /^ACTIV-STU-20261012-\d{3}$/);
    assert.equal(generated.membershipNumber, 'ACTIV-STU-20261012-100');
    await Member.updateOne({ _id: b._id }, { $set: { deletedAt: new Date() } });
    await assert.rejects(registry.detail(String(b._id), actor), e => e.statusCode === 404);
    await assert.rejects(registry.update(String(b._id), { note: 'Edit archived', updatedAt: bRow.updatedAt }, actor), e => e.statusCode === 404);
    const archived = await Member.collection.findOne({ _id: b._id });
    await assert.rejects(numbers.reserveMembershipNumber(a, archived.membershipNumber), e => e.statusCode === 409);
    assert.equal((await registry.list({}, actor)).total, 1, 'deleted accounts leave the active register; previous IDs remain reserved');
    console.log('PASS: category IDs; Super Admin authorization; corrected identity and login; case-normalized duplicates; concurrent reservation; stale edit rejection; inclusive validity; previous-ID search; audit history; archived IDs retained; no payment changes.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
