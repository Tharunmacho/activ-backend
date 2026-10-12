// Real isolated MongoDB. No production connection, gateway or notification calls.
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
    const Business = require('../src/modules/members/businessinfo.model');
    const Plan = require('../src/modules/members/membershipplan.model');
    const Order = require('../src/modules/payment/paymentorder.model');
    const rules = require('../src/modules/members/membershipPlanRules');
    const plans = require('../src/modules/members/membershipplan.service');
    const eligibility = require('../src/modules/members/membershipEligibility');
    const upgrades = require('../src/modules/members/membershipUpgrade');
    const office = require('../src/modules/admin/adminMembershipDashboard.service');
    const orders = require('../src/modules/payment/paymentOrder.service');
    const dates = require('../src/modules/members/membershipDates');
    require('../src/modules/payment/payment.service').announceMembershipActivation = async () => {};
    const YEAR = rules.currentYear();
    await Plan.insertMany([
        ['basic', 'Beginner', 'business', 11000, 0, 5], ['intermediate', 'Intermediate', 'business', 22000, 5, 10],
        ['ideal', 'Ideal', 'business', 33000, 10, null], ['student', 'Student', 'student', 1000, 0, null],
        ['aspirant', 'Aspirant', 'aspirant', 2000, 0, null], ['platinum', 'Lifetime', 'platinum', 200000, 0, null]
    ].map(([key, name, audience, price, minYears, maxYears]) => ({ key, name, audience, amountPaise: price * 100, minYears, maxYears, memberType: audience === 'platinum' ? 'lifetime' : 'annual', isActive: true })));
    const actor = { role: 'super_admin', userId: new mongoose.Types.ObjectId().toString(), email: 'office@example.test' };
    const make = async (kind, year, paidKey) => {
        const _id = new mongoose.Types.ObjectId();
        const m = { _id, role: 'member', fullName: 'Fixture Member', email: `${_id}@example.test`, phoneNumber: '9000000000', memberType: kind,
            isActive: true, membershipStatus: paidKey ? 'active' : 'pending', membershipType: paidKey ? 'annual' : 'none',
            membershipActivatedAt: paidKey ? new Date() : null, membershipExpiresAt: paidKey ? dates.annualExpiry(new Date()) : null, createdAt: new Date(), updatedAt: new Date() };
        await Member.collection.insertOne(m);
        await Business.create({ userId: _id, doingBusiness: kind === 'business', registrationType: kind, businessCommencementYear: year || '' });
        if (paidKey) await Order.create({ memberId: _id, email: m.email, orderId: 'FIX-' + _id, planId: paidKey, planName: paidKey,
            planAudience: kind, amount: 1000, membershipType: 'annual', status: 'paid', orderType: 'membership', provider: 'offline',
            paidAt: new Date(), expiresAt: new Date(), membershipCommencementYear: year || '' });
        return m;
    };
    const pay = (planId, extra = {}) => ({ planId, mode: 'cash', amount: 1000, note: 'Fixture office receipt checked', manualAdmission: true, ...extra });
    const ideal = await make('business', String(YEAR - 12));
    const detail = await office.detail(String(ideal._id), actor);
    assert.deepEqual(detail.confirmation.plans.map(p => p.id), ['ideal']);
    assert.equal(detail.confirmation.plans[0].price, 33000);
    assert.equal(detail.confirmation.plans[0].commencementYears[0], String(YEAR - 10));
    const receiptCount = await Order.countDocuments();
    await assert.rejects(office.confirm(String(ideal._id), pay('basic', { commencementYear: String(YEAR - 1) }), actor), /eligible plan/);
    await assert.rejects(office.confirm(String(ideal._id), pay('ideal', { commencementYear: String(YEAR - 1) }), actor), /commencement year/);
    assert.equal(await Order.countDocuments(), receiptCount, 'wrong plans/years never create receipts');
    const admitted = await office.confirm(String(ideal._id), pay('ideal', { commencementYear: String(YEAR - 12), membershipNumber: `ACTIV-IDL-${YEAR}1012-701` }), actor);
    assert.equal(admitted.member.memberNumber, `ACTIV-IDL-${YEAR}1012-701`);
    assert.equal(admitted.payments[0].planId, 'ideal');
    assert.equal((await Business.findOne({ userId: ideal._id }).lean()).businessCommencementYear, String(YEAR - 12));

    const newBusiness = await make('business', '');
    const draft = await office.detail(String(newBusiness._id), actor);
    assert.deepEqual(draft.confirmation.plans.find(p => p.id === 'basic').commencementYears, Array.from({ length: 5 }, (_, i) => String(YEAR - i)));
    await assert.rejects(office.confirm(String(newBusiness._id), pay('basic'), actor), /commencement year/);
    await office.confirm(String(newBusiness._id), pay('basic', { commencementYear: String(YEAR - 2) }), actor);
    assert.equal((await Business.findOne({ userId: newBusiness._id }).lean()).businessCommencementYear, String(YEAR - 2));
    assert.deepEqual((await eligibility.forMember(newBusiness._id)).plans.map(p => p.key), ['basic']);

    for (const kind of ['student', 'aspirant']) {
        const m = await make(kind, '', kind);
        const choices = await upgrades.eligibility(m._id);
        assert.deepEqual(choices.plans.map(p => p.key), ['basic']);
        assert.equal(choices.canPurchase, true);
        assert.equal(choices.plans[0].commencementYears.length, 5);
        await assert.rejects(upgrades.validate(m._id, 'ideal', String(YEAR - 12)), /entry business plan/);
        await assert.rejects(upgrades.validate(m._id, 'basic', String(YEAR - 6)), /commencement year/);
        const snapshot = await upgrades.validate(m._id, 'basic', String(YEAR - 1));
        assert.equal(snapshot.upgradeKind, 'business');
        assert.equal((await Business.findOne({ userId: m._id }).lean()).registrationType, kind, 'checkout does not change the paid category');
        await upgrades.applyPaidProfile({ ...snapshot, memberId: m._id });
        assert.equal((await Business.findOne({ userId: m._id }).lean()).businessCommencementYear, String(YEAR - 1));
    }
    const advancing = await make('business', String(YEAR - 5), 'basic');
    const before = await Member.collection.findOne({ _id: advancing._id });
    const paid = await Order.findOne({ memberId: advancing._id }).lean();
    const identity = await eligibility.currentMembership(advancing, paid);
    assert.equal(identity.planId, 'intermediate'); assert.equal(identity.automaticallyAdvanced, true); assert.match(identity.message, /Congratulations/);
    const adminView = await office.overview(actor);
    assert.equal(adminView.rows.find(r => r.id === String(advancing._id)).planName, 'Intermediate');
    assert.equal(adminView.payments.find(r => r.memberId === String(advancing._id)).planId, 'basic', 'admin receipts preserve the plan paid for');
    const upgradeOffer = await upgrades.eligibility(advancing._id);
    assert.deepEqual(upgradeOffer.plans.map(p => p.key), ['intermediate']); assert.equal(upgradeOffer.canPurchase, false);
    await assert.rejects(upgrades.validate(advancing._id, 'intermediate', String(YEAR - 5)), /automatically/);
    assert.deepEqual(await Member.collection.findOne({ _id: advancing._id }), before, 'progression does not reset expiry, ID or membership dates');
    assert.deepEqual(await Order.findOne({ memberId: advancing._id }).lean(), paid, 'progression leaves historical receipts unchanged');
    const renewal = await eligibility.forMember(advancing._id);
    assert.deepEqual(renewal.plans.map(p => p.key), ['intermediate']); assert.equal(renewal.plans[0].price, 22000);
    await assert.rejects(eligibility.validatePurchase(advancing, 'basic'), /does not match/);
    await assert.rejects(orders.createOrder({ userId: advancing._id }, { planId: 'intermediate', upgrade: true }), /automatically/);
    await Member.collection.updateOne({ _id: advancing._id }, { $set: { membershipStatus: 'expired', membershipExpiresAt: new Date(Date.now() - 86400000) } });
    const renewed = await orders.createOrder({ userId: advancing._id }, { planId: 'intermediate' });
    assert.equal(renewed.receipt.amount, 22000); assert.equal(renewed.receipt.planId, 'intermediate');

    await Plan.updateOne({ key: 'basic' }, { $set: { maxYears: 3 } });
    await Plan.updateOne({ key: 'intermediate' }, { $set: { minYears: 3, maxYears: 7, amountPaise: 770000 } });
    await Plan.updateOne({ key: 'ideal' }, { $set: { minYears: 7 } });
    const ageThree = await make('business', String(YEAR - 3), 'basic');
    assert.equal((await eligibility.currentMembership(ageThree, await Order.findOne({ memberId: ageThree._id }).lean())).planId, 'intermediate');
    const newFee = await eligibility.forMember(ageThree._id);
    assert.equal(newFee.plans[0].price, 7700); assert.equal(newFee.plans[0].commencementYears.length, 4);
    const ageSeven = await make('business', String(YEAR - 7), 'intermediate');
    assert.equal((await eligibility.currentMembership(ageSeven, await Order.findOne({ memberId: ageSeven._id }).lean())).planId, 'ideal');
    const calendarPlans = await plans.listAll();
    assert.equal(rules.matchesYear(calendarPlans.find(p => p.key === 'intermediate'), '2024', new Date('2026-12-31T18:29:59Z')), false);
    assert.equal(rules.matchesYear(calendarPlans.find(p => p.key === 'intermediate'), '2024', new Date('2026-12-31T18:30:00Z')), true);
    const student = await make('student', '', 'student');
    await Plan.updateOne({ key: 'basic' }, { $set: { isActive: false } });
    assert.equal((await upgrades.eligibility(student._id)).plans.length, 0, 'retiring Beginner must not offer an advanced tier to students');
    console.log('PASS: office plan/year/ID confirmation, student entry-only upgrades, automatic business progression, unchanged validity and receipts, renewal-only charges, configurable ranges/prices, retired plans and IST year boundary.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
