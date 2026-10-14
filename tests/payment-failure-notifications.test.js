// Exercise real gateway parsing and failure claims with isolated in-memory data.
// No MongoDB, Instamojo, email or WhatsApp calls are made by this test.
const assert = require('assert/strict');
const crypto = require('crypto');
delete process.env.PAYMENT_FAILURE_NOTICES_FROM;
const startedAt = Date.now();
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Order = require('../src/modules/payment/paymentorder.model');
const Member = require('../src/modules/members/memberdetails.model');
const Booking = require('../src/modules/events/eventbooking.model');
const Event = require('../src/modules/events/event.model');
const Company = require('../src/modules/members/company.model');
const notifications = require('../src/modules/notifications/notification.service');
const axios = require('axios');
const service = require('../src/modules/payment/payment.service');
const settleRealOrder = service.settleMembershipOrder;
service.apiKey = 'test-only'; service.authToken = 'test-only'; service.privateSalt = 'test-only';
const orders = new Map(), members = new Map(), bookings = new Map(), gateway = new Map(), notices = [];
const companies = new Map();
let settleAtClaim = false;
const clone = value => value == null ? value : structuredClone(value);
const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(part => matches(row, part));
    const value = row[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return Object.entries(expected).every(([op, v]) => {
        if (op === '$ne') return Array.isArray(value) ? !value.includes(v) : value !== v;
        if (op === '$exists') return (value !== undefined) === v;
        if (op === '$gte') return +value >= +v;
        if (op === '$lt') return +value < +v;
        if (op === '$in') return v.includes(value);
        if (op === '$nin') return !v.includes(value);
        if (op === '$not') return !v.test(value);
        throw Error(`Unexpected fixture filter: ${op}`);
    });
    return expected === null ? value == null : String(value) === String(expected);
});
const query = value => ({
    lean: () => Promise.resolve(clone(value)), select() { return this; }, sort() { return this; }, limit() { return this; },
    then(resolve, reject) { return Promise.resolve(clone(value)).then(resolve, reject); },
    catch(reject) { return Promise.resolve(clone(value)).catch(reject); }
});
Order.findOne = filter => query([...orders.values()].find(row => matches(row, filter)) || null);
Order.find = filter => query([...orders.values()].filter(row => matches(row, filter)));
Order.findById = id => query(orders.get(String(id)) || null);
const updateOrder = (row, patch) => {
    Object.assign(row, patch.$set || (Object.keys(patch).some(key => key.startsWith('$')) ? {} : patch));
    for (const key of Object.keys(patch.$unset || {})) delete row[key];
    return clone(row);
};
Order.updateOne = async (filter, patch) => {
    const row = [...orders.values()].find(item => matches(item, filter));
    if (row) updateOrder(row, patch);
};
Order.findOneAndUpdate = async (filter, patch) => {
    if (settleAtClaim) { settleAtClaim = false; orders.get(filter._id).status = 'paid'; }
    const row = [...orders.values()].find(item => matches(item, filter));
    if (!row) return null;
    if (!patch.$addToSet) return updateOrder(row, patch);
    assert.deepEqual(Object.keys(patch), ['$addToSet'], 'failure notification never rewrites financial state');
    row.failedPaymentNoticeIds ||= [];
    const id = patch.$addToSet.failedPaymentNoticeIds;
    if (!row.failedPaymentNoticeIds.includes(id)) row.failedPaymentNoticeIds.push(id);
    return clone(row);
};
Member.findById = id => query(members.get(String(id)) || null);
Booking.findOne = filter => query(bookings.get(filter.bookingRef) || null);
Event.findById = () => query({ slug: 'test-event' });
Company.findOneAndUpdate = async (filter, patch) => {
    const company = companies.get(String(filter._id));
    if (!company || company.userId !== String(filter.userId)) return null;
    Object.assign(company, patch.$set);
    return clone(company);
};
notifications.dispatchInBackground = (event, recipient, payload) => notices.push({ event, recipient, payload });
axios.get = async url => {
    const [, requestId, paymentId] = new URL(url).pathname.match(/payment-requests\/([^/]+)(?:\/([^/]+))?\//) || [];
    const request = gateway.get(requestId) || { status: 'Sent', payments: [] };
    if (request.error) throw Error('Test gateway unavailable');
    if (paymentId) {
        const payment = (request.details || request.payments || []).find(p => p.payment_id === paymentId);
        if (!payment) throw Error('No payment on this stored request');
        return { data: { success: true, payment_request: { payment: clone(payment) } } };
    }
    return { data: { success: true, payment_request: clone(request) } };
};
service.settleMembershipOrder = async (order, paymentId) => {
    orders.get(order._id).status = 'paid';
    orders.get(order._id).gatewayPaymentId = paymentId;
    return { success: true };
};
service.settleEventBookingOrder = async (order, paymentId) => {
    orders.get(order._id).status = 'paid';
    bookings.get(order.bookingRef).payment.status = 'paid';
    return { payment: { status: 'paid', paymentId } };
};
const fixture = (key, extra = {}) => {
    const memberId = new mongoose.Types.ObjectId().toString(), id = new mongoose.Types.ObjectId().toString();
    const order = { _id: id, orderId: `ord_${key}`, memberId, email: 'owner@example.test',
        orderType: 'membership', provider: 'instamojo', status: 'created', amount: 10, currency: 'INR',
        planId: 'student', planName: 'Student', membershipType: 'annual',
        gatewayPaymentId: `request-${key}`, gatewayRequestId: `request-${key}`,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 60000), ...extra };
    orders.set(id, order);
    members.set(memberId, { _id: memberId, fullName: 'Account owner', email: 'owner@example.test',
        phoneNumber: '9000000000', whatsappNumber: '9000000001', membershipStatus: 'pending' });
    if (extra.orderType === 'event_booking') bookings.set(extra.bookingRef, { bookingRef: extra.bookingRef,
        eventId: new mongoose.Types.ObjectId().toString(), eventTitle: 'ACTIV workshop', userId: '',
        bookedBy: { name: 'Booking owner', email: 'booker@example.test', phone: '9000000002' }, payment: { status: 'pending' } });
    return order;
};
const failed = (id = 'failed-attempt') => ({ payment_id: id, status: 'Failed', amount: '10.00' });
const credited = (id = 'paid-attempt') => ({ payment_id: id, status: 'Credit', amount: '10.00' });
const webhook = (order, extra = {}) => {
    const data = { payment_request_id: order.gatewayRequestId, payment_id: 'failed-attempt', status: 'Failed',
        buyer: 'untrusted-buyer@example.test', buyer_phone: '9999999999', amount: '10.00', ...extra };
    data.mac = crypto.createHmac('sha1', service.privateSalt)
        .update(Object.keys(data).sort().map(key => String(data[key])).join('|')).digest('hex');
    return data;
};
const failureCount = () => notices.filter(n => n.event.endsWith('PAYMENT_FAILED')).length;
async function main() {
    assert.ok(Order.schema.path('failedPaymentNoticeIds'));
    const signed = fixture('signed');
    await Promise.all([service.processPaymentWebhook(webhook(signed)), service.processPaymentWebhook(webhook(signed))]);
    assert.equal(failureCount(), 1, 'concurrent delivery of one failure claims once');
    assert.equal(signed.status, 'created', 'request remains payable after failed attempt');
    assert.equal(notices[0].recipient.email, 'owner@example.test');
    assert.equal(notices[0].recipient.whatsapp, '9000000001');
    assert.equal(notices[0].payload.amountLabel, '₹10');
    assert.equal(notices[0].payload.paymentId, 'failed-attempt');
    assert.match(notices[0].payload.retryUrl, /payment-success\?orderId=ord_signed$/);
    await service.processPaymentWebhook(webhook(signed, { payment_id: 'second-failure' }));
    assert.equal(failureCount(), 2, 'different definitive attempts are individually identified');
    const current = failureCount();
    await assert.rejects(service.processPaymentWebhook({ ...webhook(signed), mac: 'invalid' }), /signature/);
    await assert.rejects(service.processPaymentWebhook(webhook(signed, { payment_request_id: 'unknown' })), /Matching order/);
    await service.processPaymentWebhook(webhook(signed, { status: 'Pending' }));
    await service.processPaymentWebhook(webhook(signed, { status: 'Unknown' }));
    assert.equal(failureCount(), current);

    const client = fixture('client');
    await service.resolveReturn(client.orderId, { gatewayStatus: 'Failed', paymentId: 'invented' });
    gateway.set(client.gatewayRequestId, { status: 'Failed', payments: [] });
    await service.resolveReturn(client.orderId);
    assert.equal(failureCount(), current, 'client text and request notification status never prove failed payment');
    gateway.set(client.gatewayRequestId, { payments: [failed('api-failure')] });
    await service.resolveReturn(client.orderId);
    await service.resolveReturn(client.orderId);
    assert.equal(failureCount(), current + 1, 'verified API failure and repeated return notify once');

    const pending = fixture('pending');
    gateway.set(pending.gatewayRequestId, { payments: [failed(), { payment_id: 'ongoing', status: 'Pending' }] });
    assert.deepEqual(await service.verifyPaymentWithGateway(pending.gatewayRequestId), { paid: false });
    gateway.set(pending.gatewayRequestId, { payments: [failed(), credited()] });
    assert.equal((await service.verifyPaymentWithGateway(pending.gatewayRequestId)).paid, true, 'credit wins over prior failed attempt');
    gateway.set(pending.gatewayRequestId, { payments: ['only-id'], details: [failed('only-id')] });
    assert.deepEqual((await service.verifyPaymentWithGateway(pending.gatewayRequestId)).failedPaymentIds, ['only-id']);
    gateway.set(pending.gatewayRequestId, { error: true });
    assert.deepEqual(await service.verifyPaymentWithGateway(pending.gatewayRequestId), { paid: false }, 'API outage never announces failure');

    const late = fixture('late');
    gateway.set(late.gatewayRequestId, { payments: [failed(), credited('retry-paid')] });
    const beforeLate = failureCount();
    await service.processPaymentWebhook(webhook(late));
    assert.equal(late.status, 'paid');
    assert.equal(failureCount(), beforeLate, 'delayed failure webhook respects successful retry');
    gateway.set(signed.gatewayRequestId, { payments: [failed(), credited('retry-after-notice')] });
    await service.processPaymentWebhook(webhook(signed, { status: 'Credit', payment_id: 'retry-after-notice' }));
    assert.equal(signed.status, 'paid', 'sending failed-attempt notice does not prevent subsequent settlement');

    const race = fixture('race');
    settleAtClaim = true;
    await service.processPaymentWebhook(webhook(race));
    assert.equal(failureCount(), beforeLate, 'atomic claim skips order paid after initial lookup');
    const settling = fixture('settling', { settlementStartedAt: new Date() });
    await service.processPaymentWebhook(webhook(settling));
    const cancelled = fixture('cancelled', { status: 'cancelled' });
    await service.processPaymentWebhook(webhook(cancelled));
    const deleted = fixture('deleted'); members.delete(deleted.memberId);
    await service.processPaymentWebhook(webhook(deleted));
    assert.equal(failureCount(), beforeLate, 'settling, cancelled and deleted accounts stay silent');

    const event = fixture('event', { orderType: 'event_booking', bookingRef: 'ACTIV-TEST' });
    await service.processPaymentWebhook(webhook(event));
    const eventNotice = notices.at(-1);
    assert.equal(eventNotice.event, 'EVENT_PAYMENT_FAILED');
    assert.equal(eventNotice.recipient.email, 'booker@example.test', 'guest payer comes from saved booking');
    assert.equal(eventNotice.recipient.phone, '9000000002');
    assert.equal(eventNotice.payload.eventTitle, 'ACTIV workshop');
    assert.equal(eventNotice.payload.data.bookingRef, 'ACTIV-TEST');
    bookings.get(event.bookingRef).payment.status = 'paid';
    const beforePaidEvent = failureCount();
    await service.processPaymentWebhook(webhook(event, { payment_id: 'other-failed-attempt' }));
    assert.equal(failureCount(), beforePaidEvent, 'paid booking suppresses other abandoned order failure');

    orders.clear(); gateway.clear();
    const old = fixture('old', { createdAt: new Date(startedAt - 60000) });
    const newOrder = fixture('new');
    gateway.set(old.gatewayRequestId, { payments: [failed('old-failure')] });
    gateway.set(newOrder.gatewayRequestId, { payments: [failed('new-failure')] });
    const beforeSweep = failureCount();
    await service.reconcilePendingOrders();
    assert.equal(failureCount(), beforeSweep + 1, 'deployment never blasts historical failed checkout notices');
    assert.equal(notices.at(-1).payload.orderId, newOrder.orderId);
    await service.reconcilePendingOrders();
    assert.equal(failureCount(), beforeSweep + 1, 'repeat reconcile remains idempotent');
    await service.resolveReturn(old.orderId);
    assert.equal(failureCount(), beforeSweep + 2, 'returning member can check older authoritative failure');

    const orderService = require('../src/modules/payment/paymentOrder.service');
    const pendingCount = () => notices.filter(n => n.event === 'PAYMENT_REQUIRED').length;
    const pendingPaid = fixture('pending-paid');
    gateway.set(pendingPaid.gatewayRequestId, { payments: [credited('completed-before-webhook')] });
    await orderService.notifyPaymentPending(pendingPaid.orderId);
    assert.equal(pendingPaid.status, 'paid');
    assert.equal(pendingCount(), 0, 'delayed success webhook cannot cause a false payment nudge');
    const pendingFailed = fixture('pending-failed');
    gateway.set(pendingFailed.gatewayRequestId, { payments: [failed('nudge-time-failure')] });
    await orderService.notifyPaymentPending(pendingFailed.orderId);
    await orderService.notifyPaymentPending(pendingFailed.orderId);
    assert.equal(pendingCount(), 0, 'failed attempt notice replaces pending nudge');
    const pendingEvent = fixture('pending-event', { orderType: 'event_booking', bookingRef: 'ACTIV-PENDING' });
    await orderService.notifyPaymentPending(pendingEvent.orderId);
    const pendingCompany = fixture('pending-company', { orderType: 'company_listing' });
    await orderService.notifyPaymentPending(pendingCompany.orderId);
    assert.equal(pendingCount(), 0, 'membership pending reminder excludes company/event checkouts');
    const pendingUnpaid = fixture('pending-unpaid');
    await orderService.notifyPaymentPending(pendingUnpaid.orderId);
    assert.equal(pendingCount(), 1, 'verified unfinished membership checkout can receive its pending reminder');

    const companyId = new mongoose.Types.ObjectId().toString();
    const companyOrder = fixture('company-success', { orderType: 'company_listing', companyId });
    const companyMember = members.get(companyOrder.memberId);
    Object.assign(companyMember, { membershipStatus: 'active', membershipType: 'annual',
        membershipNumber: 'ACTIV-BEG-20261001-001', membershipExpiresAt: new Date('2027-10-01'),
        paymentId: 'original-membership-payment', paymentAmount: 10000, lastPaymentDate: new Date('2026-10-01') });
    const originalMember = clone(companyMember);
    companies.set(companyId, { _id: companyId, userId: companyOrder.memberId, businessName: 'Member second company', isActive: false, status: 'draft' });
    const companyBefore = notices.length;
    const companyRace = await Promise.allSettled([
        settleRealOrder.call(service, clone(companyOrder), 'company-paid'),
        settleRealOrder.call(service, clone(companyOrder), 'company-paid')
    ]);
    assert.ok(companyRace.some(result => result.status === 'fulfilled'));
    assert.equal(companyOrder.status, 'paid');
    assert.equal(companies.get(companyId).status, 'active');
    assert.deepEqual(companyMember, originalMember, 'company publishing payment does not renew/reassign membership');
    assert.equal(notices.length, companyBefore + 1, 'settlement race emits one company receipt');
    assert.equal(notices.at(-1).event, 'COMPANY_PAYMENT_CONFIRMED');
    assert.equal(notices.at(-1).payload.companyName, 'Member second company');
    assert.equal(notices.at(-1).payload.data.companyId, companyId);
    assert.equal(notices.at(-1).payload.amountLabel, '₹10');
    assert.equal(notices.at(-1).recipient.email, 'owner@example.test');
    await settleRealOrder.call(service, clone(companyOrder), 'company-paid');
    assert.equal(notices.length, companyBefore + 1, 'paid order cannot emit company receipt again');

    const signedCompanyId = new mongoose.Types.ObjectId().toString();
    const signedCompany = fixture('company-signed', { orderType: 'company_listing', companyId: signedCompanyId, provider: 'mock' });
    companies.set(signedCompanyId, { _id: signedCompanyId, userId: signedCompany.memberId, businessName: 'Signed company', isActive: false, status: 'draft' });
    const signedOwnerBefore = clone(members.get(signedCompany.memberId));
    process.env.PAYMENT_SIGNING_SECRET = 'test-only-signing-secret';
    await orderService.completePayment({ userId: signedCompany.memberId }, { orderId: signedCompany.orderId,
        gatewayPaymentId: 'signed-company-payment', signature: orderService.sign(signedCompany.orderId, 'signed-company-payment'), paymentMethod: 'test' });
    assert.equal(notices.at(-1).event, 'COMPANY_PAYMENT_CONFIRMED');
    assert.equal(notices.at(-1).payload.data.orderId, signedCompany.orderId);
    assert.deepEqual(members.get(signedCompany.memberId), signedOwnerBefore, 'alternate verified company checkout preserves membership');
    console.log('Payment failure notification checks passed: signed/API verification, contact ownership, pending suppression, deduplication, retry credit, settlement races, event routing and rollout boundary.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
