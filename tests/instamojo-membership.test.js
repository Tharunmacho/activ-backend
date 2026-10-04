// No database or provider calls: exercise the real payment service and router.
const assert = require('assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Order = require('../src/modules/payment/paymentorder.model');
const Member = require('../src/modules/members/memberdetails.model');
const notifications = require('../src/modules/notifications/notification.service');
const axios = require('axios');
const service = require('../src/modules/payment/payment.service');
service.apiKey = 'test-key'; service.authToken = 'test-token'; service.privateSalt = 'test-salt';
const calls = [], notices = [], orders = new Map(), members = new Map(), gateway = new Map();
const businessProfiles = new Map();
require('../src/modules/members/businessinfo.model').updateOne = async (filter, patch) => { businessProfiles.set(String(filter.userId), { ...businessProfiles.get(String(filter.userId)), ...patch.$set }); return { modifiedCount: 1 }; };
let failFinalWrite = false, memberWrites = 0;
const clone = value => value == null ? value : structuredClone(value);
const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(row, part));
    const value = row[key];
    if (expected instanceof Date) return +value === +expected;
    if (expected && typeof expected === 'object') return Object.entries(expected).every(([op, v]) => {
        if (op === '$exists') return (value !== undefined) === v;
        if (op === '$lt') return +value < +v;
        if (op === '$gte') return +value >= +v;
        if (op === '$in') return v.includes(value);
        if (op === '$nin') return !v.includes(value);
        if (op === '$not') return !v.test(value);
        throw Error('Unsupported fixture filter: ' + op);
    });
    return expected === null ? value == null : String(value) === String(expected);
});
const query = value => ({
    lean: async () => clone(value), sort() { return this; }, limit() { return this; },
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
    catch(reject) { return Promise.resolve(clone(value)).catch(reject); }
});
const update = (row, patch) => {
    Object.assign(row, patch.$set || {});
    for (const key of Object.keys(patch.$unset || {})) delete row[key];
    return clone(row);
};
Order.findOne = filter => query([...orders.values()].find(row => matches(row, filter)) || null);
Order.find = filter => query([...orders.values()].filter(row => matches(row, filter)));
Order.findById = async id => clone(orders.get(String(id)) || null);
Order.findOneAndUpdate = async (filter, patch) => {
    const row = [...orders.values()].find(row => matches(row, filter));
    if (!row) return null;
    if (patch.$set?.status === 'paid' && failFinalWrite) { failFinalWrite = false; throw Error('Temporary write failure'); }
    return update(row, patch);
};
Order.updateOne = async (filter, patch) => {
    const row = [...orders.values()].find(row => matches(row, filter));
    if (row) update(row, patch);
};
Member.findById = async id => clone(members.get(String(id)) || null);
Member.findByIdAndUpdate = async (id, patch) => {
    const row = members.get(String(id));
    if (!row) return null;
    memberWrites++;
    return update(row, patch);
};
require('../src/modules/members/memberNumber').assignMembershipNumber = async () => 'ACTIV-2026-001';
require('../src/modules/members/memberIds').idsFor = async () => ({ memberId: 'ACTIV-2026-001', applicationRef: 'APP-1' });
notifications.dispatchInBackground = (event, recipient, payload) => notices.push({ event, recipient, payload });
axios.get = async url => {
    calls.push(url);
    const [, requestId, paymentId] = new URL(url).pathname.match(/payment-requests\/([^/]+)(?:\/([^/]+))?\//) || [];
    const request = gateway.get(requestId) || { status: 'Sent', payments: [] };
    if (paymentId) {
        const payment = (request.payments || []).find(p => p.payment_id === paymentId);
        if (!payment) throw Error('Payment not on this request');
        return { data: { success: true, payment_request: { payment } } };
    }
    return { data: { success: true, payment_request: clone(request) } };
};
const fixture = (key, options = {}) => {
    const memberId = new mongoose.Types.ObjectId().toString();
    const id = new mongoose.Types.ObjectId().toString();
    const requestId = 'request-' + key;
    const order = { _id: id, orderId: 'ord_' + key, memberId, email: 'owner@example.test',
        orderType: 'membership', provider: 'instamojo', status: 'created', amount: 10, currency: 'INR',
        planId: 'student', planName: 'Student', membershipType: options.lifetime ? 'lifetime' : 'annual',
        gatewayPaymentId: requestId, createdAt: new Date(), expiresAt: new Date(Date.now() - 60000) };
    orders.set(id, order);
    members.set(memberId, { _id: memberId, fullName: 'Owner', email: 'owner@example.test',
        phoneNumber: '9000000000', membershipStatus: 'pending', ...options.member });
    if (options.paid !== false) gateway.set(requestId, { status: 'Completed', amount: '10.00',
        payments: [{ payment_id: 'MOJO-' + key, status: 'Credit', amount: '13.90' }] });
    return order;
};
const webhook = (order, extra = {}) => {
    const body = { status: 'Credit', payment_id: 'MOJO-' + order.orderId.slice(4),
        payment_request_id: order.gatewayPaymentId, amount: '13.90', currency: 'INR',
        buyer: 'different-payer@example.test', ...extra };
    body.mac = crypto.createHmac('sha1', service.privateSalt)
        .update(Object.keys(body).sort().map(key => String(body[key])).join('|')).digest('hex');
    return body;
};
async function main() {
    const paid = fixture('return');
    const result = await service.resolveReturn(paid.orderId, { paymentId: 'stale-id', gatewayStatus: 'Failed' });
    assert.equal(result.status, 'paid', 'server credit overrides stale browser fields');
    assert.equal(members.get(paid.memberId).membershipStatus, 'active');
    assert.equal(members.get(paid.memberId).paymentAmount, 10, 'processing fees do not change plan price');
    assert.equal(paid.gatewayRequestId, 'request-return');
    assert.equal(notices.length, 1);
    await service.processPaymentWebhook(webhook({ ...paid, gatewayPaymentId: paid.gatewayRequestId }));
    await service.resolveReturn(paid.orderId);
    assert.equal(notices.length, 1, 'repeat webhook and return do not notify again');

    const pending = fixture('pending', { paid: false });
    assert.equal((await service.resolveReturn(pending.orderId, { gatewayStatus: 'Credit' })).status, 'created');
    assert.equal(members.get(pending.memberId).membershipStatus, 'pending', 'query Credit is not proof');
    gateway.set(pending.gatewayPaymentId, { status: 'Completed', amount: '10.00', payments: [] });
    assert.equal((await service.resolveReturn(pending.orderId)).status, 'created', 'Completed alone is not credit proof');
    gateway.set(pending.gatewayPaymentId, { payments: [{ status: 'Credit', payment_id: 'MOJO-low', amount: '1' }] });
    assert.equal((await service.resolveReturn(pending.orderId)).status, 'created', 'underpayment does not activate');

    const callback = fixture('callback', { lifetime: true });
    await service.processPaymentWebhook(webhook(callback));
    const activated = members.get(callback.memberId);
    assert.equal(activated.membershipType, 'lifetime', 'duration comes from stored order');
    assert.equal(activated.membershipExpiresAt, null);
    assert.equal(activated.email, 'owner@example.test', 'buyer email does not select the account');
    const invalid = fixture('invalid');
    await assert.rejects(service.processPaymentWebhook({ ...webhook(invalid), mac: 'invalid' }), /signature/);
    await assert.rejects(service.processPaymentWebhook(webhook(invalid, { amount: '1' })), /amount/);
    assert.equal(invalid.status, 'created');

    const retry = fixture('retry');
    failFinalWrite = true;
    const first = await service.resolveReturn(retry.orderId);
    assert.equal(first.status, 'created');
    const end = members.get(retry.memberId).membershipExpiresAt;
    const writes = memberWrites;
    assert.equal((await service.resolveReturn(retry.orderId)).status, 'paid');
    assert.equal(+members.get(retry.memberId).membershipExpiresAt, +end, 'retry does not renew twice');
    assert.equal(memberWrites, writes);

    const race = fixture('race');
    const before = notices.length;
    await Promise.all([service.resolveReturn(race.orderId), service.resolveReturn(race.orderId)]);
    assert.equal(race.status, 'paid');
    assert.equal(notices.length - before, 1, 'simultaneous return requests activate once');
    const delayed = fixture('scheduler');
    await service.reconcilePendingOrders();
    assert.equal(delayed.status, 'paid', 'closed browser and missing webhook still recover');

    const express = require('express'), request = require('supertest');
    const app = express(); app.use(express.urlencoded({ extended: false }));
    app.use('/webhook', require('../src/modules/payment/webhook.routes'));
    assert.equal((await request(app).post('/webhook/instamojo').type('form').send({ mac: 'bad' })).status, 401);
    const routed = fixture('form');
    assert.equal((await request(app).post('/webhook/instamojo').type('form').send(webhook(routed))).status, 200);
    assert.equal(routed.status, 'paid', 'actual form-encoded status callback activates');
    const upgrade = fixture('upgrade', { paid: false, member: {
        memberType: 'student', registrationType: 'student', membershipStatus: 'active',
        membershipActivatedAt: new Date('2020-01-01'),
        membershipExpiresAt: new Date(Date.now() + 200 * 86400000), paymentId: 'MOJO-existing'
    } });
    Object.assign(upgrade, { purchasePurpose: 'upgrade', upgradeKind: 'business',
        previousPlanId: 'student', planId: 'basic', planName: 'Business Starter', upgradeCommencementYear: '2024' });
    const originalMember = clone(members.get(upgrade.memberId));
    assert.equal((await service.resolveReturn(upgrade.orderId, { gatewayStatus: 'Credit' })).status, 'created');
    assert.deepEqual(members.get(upgrade.memberId), originalMember, 'an unverified upgrade keeps the existing paid membership');
    gateway.set(upgrade.gatewayPaymentId, { status: 'Completed', amount: '10.00',
        payments: [{ payment_id: 'MOJO-upgrade', status: 'Credit', amount: '13.90' }] });
    assert.equal((await service.resolveReturn(upgrade.orderId)).status, 'paid');
    const upgraded = members.get(upgrade.memberId);
    assert.equal(businessProfiles.get(upgrade.memberId).businessCommencementYear, '2024');
    assert.equal(businessProfiles.get(upgrade.memberId).doingBusiness, true);
    assert.equal(upgraded.memberType, 'business');
    assert.equal(upgraded.registrationType, 'business');
    assert.equal(upgraded._id, originalMember._id);
    assert.equal(upgraded.email, originalMember.email);
    assert.equal(upgraded.phoneNumber, originalMember.phoneNumber);
    assert.equal(+upgraded.membershipActivatedAt, +originalMember.membershipActivatedAt, 'member-since date stays unchanged');
    const expectedEnd = new Date(); expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);
    assert.ok(Math.abs(+upgraded.membershipExpiresAt - +expectedEnd) < 10000, 'an upgrade starts a new year from payment, rather than adding to old expiry');
    const upgradedEnd = +upgraded.membershipExpiresAt, noticesBeforeReplay = notices.length;
    await service.processPaymentWebhook(webhook({ ...upgrade, gatewayPaymentId: upgrade.gatewayRequestId }));
    await service.resolveReturn(upgrade.orderId);
    assert.equal(+members.get(upgrade.memberId).membershipExpiresAt, upgradedEnd);
    assert.equal(notices.length, noticesBeforeReplay, 'replay cannot extend membership or send another receipt');
    const original = service.processPaymentWebhook;
    service.processPaymentWebhook = async () => { throw Error('Database unavailable'); };
    assert.equal((await request(app).post('/webhook/instamojo').type('form').send({})).status, 500);
    service.processPaymentWebhook = original;
    assert.ok(notices.every(n => n.event === 'MEMBERSHIP_ACTIVATED' && n.recipient.email === 'owner@example.test'));
    console.log('Instamojo membership return, signed form callback, ownership, amount, retries, concurrency and reconciliation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
