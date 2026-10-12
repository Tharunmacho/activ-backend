// Real Mongo on loopback, no gateway/email/WhatsApp and no production writes.
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
    const Order = require('../src/modules/payment/paymentorder.model');
    const numbers = require('../src/modules/members/memberNumber');
    const dates = require('../src/modules/members/membershipDates');
    const { membershipState, renewalBase } = require('../src/modules/members/membershipState');
    const migration = require('../src/modules/members/memberNumberMigration');
    const join = '2026-10-12T10:00:00+05:30';
    const make = async extra => {
        const row = { _id: new mongoose.Types.ObjectId(), fullName: 'Fixture Member', email: new mongoose.Types.ObjectId() + '@example.test',
            phoneNumber: '9000000000', role: 'member', memberType: 'student', isActive: true, createdAt: new Date(join), updatedAt: new Date(join),
            membershipStatus: 'active', membershipType: 'annual', membershipActivatedAt: new Date(join), ...extra };
        await Member.collection.insertOne(row); return row;
    };
    const members = await Promise.all(Array.from({ length: 24 }, () => make({})));
    const ids = await Promise.all(members.map(m => numbers.assignMembershipNumber(m)));
    assert.equal(new Set(ids).size, 24, 'concurrent registrations must each get a different ID');
    assert(ids.every(id => /^ACTIV-STU-20261012-\d{3}$/.test(id)), 'all IDs use the same IST joining day');
    const same = await make({});
    const repeated = await Promise.all(Array.from({ length: 8 }, () => numbers.assignMembershipNumber(same)));
    assert.equal(new Set(repeated).size, 1, 'concurrent callbacks for one member retain one ID');
    const midnight = await make({ membershipActivatedAt: new Date('2026-10-12T18:30:00Z') });
    assert.equal(await numbers.assignMembershipNumber(midnight), 'ACTIV-STU-20261013-001');
    const legacy = await make({ membershipNumber: 'ACTIV-2026-006' });
    assert.equal(await numbers.assignMembershipNumber(legacy), legacy.membershipNumber, 'renewals do not implicitly renumber a member');
    for (const bad of ['ACTIV-STU-20260230-001', 'ACTIV-STU-20261012-000', 'ACTIV-STU-20261012-0001', 'ACTIV-2026-001', '=BAD', {}]) {
        assert.throws(() => numbers.validateMembershipNumber(bad));
    }
    assert.equal(numbers.validateMembershipNumber(' activ-stu-20261012-099 '), 'ACTIV-STU-20261012-099');
    const end = dates.annualExpiry(join);
    assert.equal(end.toISOString(), '2027-10-11T18:30:00.000Z');
    assert.equal(dates.indiaDayKey(dates.lastValidDay(end)), '20271011');
    const member = { membershipStatus: 'active', membershipType: 'annual', membershipExpiresAt: end };
    assert.equal(membershipState(member, { now: new Date('2027-10-11T18:29:59.999Z') }).state, 'active');
    assert.equal(membershipState(member, { now: end }).state, 'expired');
    assert.equal(dates.annualExpiry(renewalBase(member, { now: new Date(join) })).toISOString(), '2028-10-11T18:30:00.000Z', 'early renewal keeps remaining paid days');
    assert.equal(dates.indiaDayKey(dates.lastValidDay(dates.annualExpiry('2024-02-29T09:00:00+05:30'))), '20250228');
    assert.equal(membershipState({ ...member, membershipType: 'lifetime' }, { now: new Date('2035-01-01') }).state, 'active');

    const plans = require('../src/modules/members/membershipplan.service');
    plans.listAll = async () => [{ key: 'student', name: 'Student', audience: 'student', price: 1000, membershipType: 'annual', active: true }];
    plans.getPlanForPayment = async () => ({ id: 'student', name: 'Student', audience: 'student', amount: 1000, membershipType: 'annual' });
    require('../src/modules/payment/payment.service').announceMembershipActivation = async () => {};
    const service = require('../src/modules/admin/adminMembershipDashboard.service');
    const actor = { role: 'super_admin', userId: new mongoose.Types.ObjectId().toString(), email: 'office@example.test' };
    const fresh = await make({ membershipStatus: 'pending', membershipActivatedAt: null });
    const payment = { mode: 'cash', amount: 1000, planId: 'student', note: 'Fixture cash receipt', receiptNumber: 'FIXTURE-CASH', manualAdmission: true, membershipNumber: 'ACTIV-STU-20261014-040' };
    const confirmed = await service.confirm(String(fresh._id), payment, actor);
    assert.equal(confirmed.member.memberNumber, payment.membershipNumber);
    assert.equal(confirmed.payments[0].manual.membershipNumber, payment.membershipNumber);
    const later = await make({ membershipActivatedAt: new Date('2026-10-14T12:00:00+05:30') });
    assert.equal(await numbers.assignMembershipNumber(later), 'ACTIV-STU-20261014-041', 'automatic numbering continues after the office number');
    const duplicate = await make({ membershipStatus: 'pending', membershipActivatedAt: null });
    const receiptsBefore = await Order.countDocuments();
    await assert.rejects(service.confirm(String(duplicate._id), payment, actor), e => e.statusCode === 409);
    assert.equal(await Order.countDocuments(), receiptsBefore, 'duplicate IDs must not create receipts or activate members');
    assert.equal((await Member.findById(duplicate._id).lean()).membershipStatus, 'pending');

    const old = await make({ membershipNumber: 'ACTIV-2025-004', membershipActivatedAt: new Date('2025-02-10T07:00:00+05:30') });
    const original = await Member.collection.findOne({ _id: old._id });
    const reservations = await require('../src/config/dataLayout').collection('membershipCounters').find({ _id: /^number:/ }).toArray();
    const changes = migration.planMembershipNumberMigration([old, legacy, ...await Member.collection.find({ membershipNumber: /^ACTIV-STU-20261012-/ }).toArray()], reservations);
    assert(changes.some(c => c.membershipNumber === 'ACTIV-STU-20250210-001'));
    await migration.applyMembershipNumberMigration(changes);
    await migration.applyMembershipNumberMigration(changes);
    const converted = await Member.collection.findOne({ _id: old._id });
    assert.equal(converted.membershipNumber, 'ACTIV-STU-20250210-001');
    assert.deepEqual(converted.legacyMembershipNumbers, ['ACTIV-2025-004']);
    delete converted.membershipNumber; delete converted.legacyMembershipNumbers; delete original.membershipNumber;
    assert.deepEqual(converted, original, 'conversion changes only the ID and preserves its prior reference');
    assert.equal(await Order.countDocuments(), receiptsBefore, 'conversion never modifies receipts');
    console.log('PASS: concurrent daily IDs, midnight reset, manual cash ID and duplicate protection, original-date conversion with legacy references, annual validity, leap day and renewal boundaries.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
