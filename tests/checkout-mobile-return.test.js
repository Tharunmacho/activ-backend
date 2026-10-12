// Real service/router with in-memory records and a fake gateway; no DB or messages.
process.env.FRONTEND_URL = 'https://activ.example.test';
process.env.PUBLIC_API_URL = 'https://api.example.test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const express = require('express');
const request = require('supertest');
const payment = require('../src/modules/payment/payment.service');
const donations = require('../src/modules/donations/donation.service');
const Donation = require('../src/modules/donations/donation.model');
const Donor = require('../src/modules/donations/donor.model');
const Order = require('../src/modules/payment/paymentorder.model');
const booking = require('../src/modules/events/eventbooking.service');
const gateway = [], orders = [];
let donation;
payment.isConfigured = () => true;
payment.createPaymentRequest = async body => {
    gateway.push(body);
    return { payment_url: 'https://gateway.example.test/checkout', payment_request_id: 'request-test' };
};
Order.create = async body => { const row = { _id: new mongoose.Types.ObjectId(), ...body }; orders.push(row); return row; };
Donor.findOneAndUpdate = async () => ({ _id: 'donor-fixture', statementToken: 'statement-fixture' });
Donor.findById = () => ({ select() { return this; }, lean: async () => ({ statementToken: 'statement-fixture' }) });
Donation.create = async body => (donation = { _id: 'donation-fixture', ...body });
Donation.findById = async () => donation;
const payableBooking = {
    totalAmount: 1500, eventId: new mongoose.Types.ObjectId().toString(),
    status: 'active', payment: { status: 'pending' }, expiresAt: new Date(Date.now() + 600000),
    bookedBy: { name: 'Fixture Member', email: 'fixture@example.test', phone: '9000000001' },
};
let selectedBooking = payableBooking;
booking.getBooking = async () => selectedBooking;
const form = { amount: 500, fullName: 'Fixture Donor', email: 'fixture@example.test', phone: '9000000001', address: {} };
async function main() {
    for (const client of ['app', 'web', 'https://evil.test']) {
        await donations.create({ ...form, client }, { origin: 'https://evil.test' });
        const redirect = new URL(gateway.at(-1).redirectUrl);
        assert.equal(redirect.origin, 'https://activ.example.test', 'Client cannot select a redirect origin');
        assert.equal(redirect.pathname, '/donate/thank-you');
        assert.equal(redirect.searchParams.get('orderId'), orders.at(-1).orderId);
        assert.equal(redirect.searchParams.get('client'), client === 'app' ? 'app' : null);
    }
    const app = express(); app.use(express.json());
    app.use('/payment', require('../src/modules/payment/payment.routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    for (const client of ['app', 'web', { url: 'https://evil.test' }]) {
        const response = await request(app).post('/payment/create-request').set('Origin', 'https://evil.test')
            .send({ client, orderType: 'event_booking', bookingRef: 'FIXTURE-BOOKING' });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        const redirect = new URL(gateway.at(-1).redirectUrl);
        assert.equal(redirect.origin, 'https://activ.example.test');
        assert.equal(redirect.pathname, '/payment-success');
        assert.equal(redirect.searchParams.get('client'), client === 'app' ? 'app' : null);
        assert.equal(gateway.at(-1).amount, 1500, 'Booking total is server priced');
    }
    for (const state of [
        { status: 'cancelled' }, { status: 'expired' }, { status: 'waitlist' },
        { payment: { status: 'paid' } }, { payment: { status: 'not_required' } },
        { expiresAt: new Date(Date.now() - 1000) }, { eventArchived: true },
        { eventEndAt: new Date(Date.now() - 1000) }, { totalAmount: 0 },
    ]) {
        selectedBooking = { ...payableBooking, ...state };
        const charges = gateway.length, savedOrders = orders.length;
        const response = await request(app).post('/payment/create-request')
            .send({ client: 'app', orderType: 'event_booking', bookingRef: 'FIXTURE-BOOKING' });
        assert.equal(response.status, 409, JSON.stringify(state));
        assert.equal(gateway.length, charges, 'Unavailable or settled bookings cannot start a charge');
        assert.equal(orders.length, savedOrders, 'Rejected checkout cannot create an order');
    }
    selectedBooking = payableBooking;
    let checks = 0, settlements = 0, verified = false;
    donations.orderFor = async () => ({ orderId: 'ord_fixture', donationId: 'donation-fixture', gatewayPaymentId: 'request-test', amount: 500 });
    payment.verifyPaymentWithGateway = async (requestId, paymentId, amount) => {
        checks++; assert.equal(requestId, 'request-test'); assert.equal(amount, 500);
        return { paid: verified, paymentId: 'MOJO-verified' };
    };
    donations.settleOrder = async (order, paymentId) => {
        settlements++; assert.equal(paymentId, 'MOJO-verified');
        donation = { ...donation, status: 'paid', receiptToken: 'receipt-fixture' };
        return donation;
    };
    donation = { _id: 'donation-fixture', status: 'pending', amountPaise: 50000, donorId: 'donor-fixture' };
    assert.equal((await donations.resolveReturn('ord_fixture', { gatewayStatus: 'Credit' })).status, 'pending');
    assert.equal(settlements, 0, 'URL Credit never settles a gift');
    verified = true;
    assert.equal((await donations.resolveReturn('ord_fixture', { gatewayStatus: 'Failed', paymentId: 'stale' })).status, 'paid');
    assert.equal(checks, 2, 'URL Failed cannot suppress gateway verification');
    assert.equal(settlements, 1);
    await donations.resolveReturn('ord_fixture', { gatewayStatus: 'Failed' });
    assert.equal(settlements, 1, 'Reopening a paid return never settles it again');
    console.log('PASS: mobile/web checkout redirects, trusted origins, server pricing, unavailable-booking guards and verified donation returns.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
