// Isolated fixtures: no MongoDB connection, gateway requests or notifications.
const assert = require('assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Member = require('../src/modules/members/memberdetails.model');
const Business = require('../src/modules/members/businessinfo.model');
const Order = require('../src/modules/payment/paymentorder.model');
const Auth = require('../src/modules/auth/auth.model');
const plans = require('../src/modules/members/membershipplan.service');
const upgrades = require('../src/modules/members/membershipUpgrade');
const orderService = require('../src/modules/payment/paymentOrder.service');
const paymentService = require('../src/modules/payment/payment.service');
const YEAR = new Date().getFullYear();
const catalogue = [
    ['student', 'student', 500, 0, null], ['aspirant', 'aspirant', 2000, 0, null],
    ['basic', 'business', 5000, 0, 5], ['intermediate', 'business', 10000, 5, 10],
    ['ideal', 'business', 20000, 10, null], ['platinum', 'platinum', 200000, 0, null]
].map(([key, audience, price, minYears, maxYears]) => ({ key, audience, price, minYears, maxYears, name: key, membershipType: 'annual' }));
const clone = value => structuredClone(value);
const query = value => ({ lean: async () => clone(value), sort() { return this; },
    select() { return this; }, catch(fn) { return Promise.resolve(clone(value)).catch(fn); },
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); } });
let member, business, history, created = [], available = catalogue;
const fixture = (prior = 'student', kind = 'aspirant', age = 2) => {
    member = { _id: new mongoose.Types.ObjectId().toString(), email: 'same@example.test',
        phoneNumber: '9000000000', fullName: 'Same member', isActive: true,
        memberType: prior === 'student' ? 'student' : 'business', membershipStatus: 'active',
        membershipType: 'annual', membershipActivatedAt: new Date(),
        membershipExpiresAt: new Date(Date.now() + 200 * 86400000), paymentId: 'MOJO-prior' };
    business = { userId: member._id, doingBusiness: kind === 'business', registrationType: kind,
        businessCommencementYear: String(YEAR - age) };
    history = { memberId: member._id, orderType: 'membership', status: 'paid', planId: prior, planName: prior };
    created = []; available = catalogue;
};
Member.findById = id => query(String(id) === String(member._id) ? member : null);
Member.findOne = () => query(member);
Business.findOne = () => query(business);
Business.updateOne = async (filter, patch) => { assert.equal(String(filter.userId), String(member._id)); Object.assign(business, patch.$set); return { modifiedCount: 1 }; };
Order.findOne = () => query(history);
Order.create = async data => { const row = { status: 'created', ...clone(data) }; created.push(row); return row; };
Auth.findByIdAndUpdate = Auth.updateOne = () => { throw Error('An upgrade must not change login credentials'); };
plans.listActive = async () => available;
plans.getPlanForPayment = async key => {
    const p = available.find(p => p.key === key && p.audience !== 'platinum');
    return p ? { ...p, id: p.key, amount: p.price } : null;
};
let gatewayCalls = [];
paymentService.createPaymentRequest = async input => {
    gatewayCalls.push(input);
    return { payment_request_id: 'request-test', payment_url: 'https://example.test/pay' };
};
const user = () => ({ userId: member._id, email: member.email, role: 'member' });
async function main() {
    for (const [prior, kind, age, expected] of [
        ['student', 'aspirant', 0, 'aspirant'], ['student', 'business', 2, 'basic'],
        ['aspirant', 'business', 5, 'intermediate'], ['basic', 'business', 10, 'ideal'],
        ['intermediate', 'business', 4, 'basic']
    ]) {
        fixture(prior, kind, age);
        const eligible = await upgrades.eligibility(member._id);
        assert.deepEqual(eligible.plans.map(p => p.key), catalogue.filter(p => p.key !== prior && p.audience !== 'platinum').map(p => p.key));
        const before = clone(member), oldReceipt = clone(history);
        const { receipt } = await orderService.createOrder(user(), { planId: expected, upgrade: true });
        assert.equal(receipt.amount, catalogue.find(p => p.key === expected).price);
        assert.equal(created[0].purchasePurpose, 'upgrade');
        assert.equal(created[0].previousPlanId, prior);
        assert.equal(created[0].upgradeKind, kind);
        assert.equal(created[0].memberId, before._id);
        assert.deepEqual(member, before, 'opening checkout must not activate or change the account');
        assert.deepEqual(history, oldReceipt, 'previous receipts stay intact');
        await assert.rejects(upgrades.validate(member._id, 'platinum'), /Platinum/);
        await assert.rejects(orderService.createOrder(user(), { planId: expected }), /active/);
    }
    fixture('basic', 'business', 2);
    assert.equal((await upgrades.eligibility(member._id)).canUpgrade, true);
    await assert.rejects(upgrades.validate(member._id, 'basic'), /different active plan/);
    for (const year of ['', 'NaN', '1799', String(YEAR + 1), '2020.5']) {
        fixture('student', 'business'); business.businessCommencementYear = year;
        assert.equal((await upgrades.eligibility(member._id)).canUpgrade, true);
        await assert.rejects(upgrades.validate(member._id, 'basic', year), /commencement year/);
    }
    fixture('student', 'business', 7); available = catalogue.filter(p => p.key !== 'intermediate');
    await assert.rejects(upgrades.validate(member._id, 'intermediate'), /different active plan/);
    fixture(); member.membershipStatus = 'pending';
    await assert.rejects(upgrades.eligibility(member._id), /first membership/);
    fixture(); member.isActive = false;
    await assert.rejects(upgrades.eligibility(member._id), /unavailable/);
    fixture(); member.membershipType = 'lifetime';
    await assert.rejects(upgrades.eligibility(member._id), /lifetime/);
    fixture(); member.membershipTier = 'platinum';
    await assert.rejects(upgrades.eligibility(member._id), /lifetime/);
    fixture(); member.membershipStatus = 'expired';
    assert.equal((await upgrades.eligibility(member._id)).canUpgrade, true);

    fixture('student', 'student', 0);
    const targetYear = String(YEAR - 6);
    const snapshot = await upgrades.validate(member._id, 'intermediate', targetYear);
    assert.equal(snapshot.upgradeKind, 'business');
    assert.equal(business.registrationType, 'student', 'choosing a new plan does not prematurely change the profile');
    await upgrades.applyPaidProfile({ ...snapshot, memberId: member._id });
    assert.equal(business.registrationType, 'business');
    assert.equal(business.businessCommencementYear, targetYear);
    await upgrades.applyPaidProfile({ purchasePurpose: 'upgrade', upgradeKind: 'aspirant', memberId: member._id });
    assert.equal(business.doingBusiness, false);
    assert.equal(business.registrationType, 'aspirant');

    const express = require('express'), request = require('supertest');
    const jwt = require('jsonwebtoken'), config = require('../src/config');
    const app = express(); app.use(express.json());
    app.use('/payment', require('../src/modules/payment/payment.routes'));
    // The profile service's unrelated cache owns a background cleanup timer.
    const cachePath = require.resolve('../src/core/cache/cacheClient');
    require.cache[cachePath] = { id: cachePath, filename: cachePath, loaded: true,
        exports: { get: async () => null, set: async () => {}, del: async () => {} } };
    require('../src/modules/members/personalinfo1.model').findOne = () => query(null);
    app.get('/profile', require('../src/core/middleware/auth').verifyToken,
        require('../src/modules/members/member.controller').getMyProfile);
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    fixture('student', 'business', 5);
    const token = jwt.sign(user(), config.jwt.secret);
    assert.equal((await request(app).get('/payment/upgrade/plans')).status, 401);
    assert.equal((await request(app).get('/payment/upgrade/plans').auth(token, { type: 'bearer' })).body.data.plans.some(p => p.key === 'intermediate'), true);
    const before = clone(member);
    const hosted = await request(app).post('/payment/create-request').auth(token, { type: 'bearer' })
        .send({ membershipType: 'intermediate', upgrade: true, amount: 10000 });
    assert.equal(hosted.status, 201, JSON.stringify(hosted.body));
    assert.equal(gatewayCalls.at(-1).amount, 10000);
    assert.equal(created.at(-1).purchasePurpose, 'upgrade');
    assert.equal(created.at(-1).planAudience, 'business');
    assert.deepEqual(member, before);
    const requests = gatewayCalls.length;
    const wrongPlan = await request(app).post('/payment/create-request').auth(token, { type: 'bearer' })
        .send({ membershipType: 'ideal', upgrade: true });
    assert.equal(wrongPlan.status, 400);
    const wrongPrice = await request(app).post('/payment/create-request').auth(token, { type: 'bearer' })
        .send({ membershipType: 'intermediate', upgrade: true, amount: 1 });
    assert.equal(wrongPrice.status, 400);
    const noUpgrade = await request(app).post('/payment/create-request').auth(token, { type: 'bearer' })
        .send({ membershipType: 'intermediate' });
    assert.equal(noUpgrade.status, 400, 'normal checkout cannot bypass the active-member upgrade validation');
    assert.equal(gatewayCalls.length, requests, 'invalid checkout never opens a gateway request');
    Object.assign(history, { planId: 'intermediate', planName: 'Business Professional', upgradeKind: 'business' });
    const profile = await request(app).get('/profile').auth(token, { type: 'bearer' });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.deepEqual(profile.body.data.paidMembership, { planId: 'intermediate', planName: 'Business Professional', kind: 'business' });
    console.log('Membership upgrades: categories, commencement bands, validation, server pricing, hosted checkout and account/history preservation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
