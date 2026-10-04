// Office payments use the same owned-order and certificate endpoints as online payments.
// Models and message rendering are isolated: no database writes or deliveries.
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'office-document-test';
process.env.FRONTEND_URL = 'https://activ.org.in';
const express = require('express');
const request = require('supertest');
const Member = require('../src/modules/members/memberdetails.model');
const Order = require('../src/modules/payment/paymentorder.model');
const Financial = require('../src/modules/members/memberfinancialinfo.model');
const Business = require('../src/modules/members/businessinfo.model');
const memberId = '670000000000000000000001';
const paidAt = new Date('2026-10-04T06:30:00Z');
const member = { _id: memberId, fullName: 'Office Member', email: 'office@example.test', membershipNumber: 'ACTIV-2026-004', membershipStatus: 'active', membershipType: 'annual', membershipActivatedAt: paidAt, membershipExpiresAt: new Date('2027-10-04'), paymentAmount: 1000, paymentId: 'CASH-004', lastPaymentDate: paidAt };
const order = { memberId, orderId: 'ord_office_004', orderType: 'membership', provider: 'offline', status: 'paid', amount: 1000, currency: 'INR', planId: 'business', planName: 'Business', membershipType: 'annual', paymentMethod: 'cash', gatewayPaymentId: 'CASH-004', paidAt, expiresAt: member.membershipExpiresAt, manualConfirmation: { receiptNumber: 'CASH-004' } };
Member.findById = () => ({ lean: async() => ({ ...member }) });
Order.findOne = async({ orderId }) => orderId === order.orderId ? order : null;
Order.find = query => {
    assert.equal(query.memberId, memberId);
    assert.equal(query.status, 'paid');
    assert.equal(query.orderType, 'membership');
    return { sort: () => ({ limit: () => ({ lean: async() => [order] }) }) };
};
Financial.findOne = () => ({ lean: async() => null });
Business.findOne = () => ({ lean: async() => null });
const orderService = require('../src/modules/payment/paymentOrder.service');
const controller = require('../src/modules/members/memberExtras.controller');
const templates = require('../src/modules/notifications/notificationTemplates');

async function run() {
    const receipt = await orderService.getOrder({ userId: memberId }, order.orderId);
    for (const field of ['orderId', 'orderType', 'status', 'provider', 'amount', 'paymentMethod', 'gatewayPaymentId', 'paidAt', 'membershipType']) assert.equal(receipt[field], order[field], field);
    assert.equal(receipt.receiptNumber, 'CASH-004');
    await assert.rejects(orderService.getOrder({ userId: 'other-member' }, order.orderId), error => error.statusCode === 403);
    await assert.rejects(orderService.getOrder({ userId: memberId }, 'missing'), error => error.statusCode === 404);
    const app = express();
    app.get('/certificate/:kind', (req, res, next) => { req.user = { userId: memberId }; next(); }, controller.getCertificate);
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const membership = (await request(app).get('/certificate/membership').expect(200)).body.data;
    assert.equal(membership.member.membershipNumber, member.membershipNumber);
    assert.equal(membership.membershipType, 'annual');
    assert.equal(membership.contribution, null);
    const tax = (await request(app).get('/certificate/tax-exemption').expect(200)).body.data;
    assert.equal(tax.contribution.amount, 1000);
    assert.deepEqual(tax.contribution.payments, [{ date: paidAt.toISOString(), amount: 1000, mode: 'Cash', reference: 'CASH-004' }]);
    assert.equal(tax.financialYear, '2026-27');
    member.membershipStatus = 'pending';
    await request(app).get('/certificate/membership').expect(403);
    await request(app).get('/certificate/tax-exemption').expect(403);
    const receiptUrl = `https://activ.org.in/member/payment-success?view=receipt&orderId=${order.orderId}`;
    const message = templates.render('MEMBERSHIP_ACTIVATED', { name: member.fullName, email: member.email, membershipNumber: member.membershipNumber, planName: 'Business', amountLabel: 'Rs 1,000', paymentMode: 'cash', receiptUrl, orderId: order.orderId, activatedLabel: '4 October 2026', validUntilLabel: '4 October 2027' });
    const email = JSON.stringify(message.email);
    for (const value of ['ord_office_004', 'Payment mode', 'cash', 'member/certificate/membership', 'member/certificate/tax-exemption', 'member/documents']) assert.ok(email.includes(value), value);
    assert.ok(message.whatsapp.text.includes(receiptUrl));
    assert.ok(message.whatsapp.text.includes('/member/certificate/tax-exemption'));
    assert.ok(message.whatsapp.text.includes('/member/documents'));
    assert.ok(message.whatsapp.text.includes('member@activ.org.in'));
    console.log('PASS: cash receipts, owned-order checks, membership and tax documents, unpaid gating and activation message document links');
}
run().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
