// No database or provider calls: current records are isolated in-memory fixtures.
const assert = require('assert/strict');
const Member = require('../src/modules/members/memberdetails.model');
const Order = require('../src/modules/payment/paymentorder.model');
const Booking = require('../src/modules/events/eventbooking.model');
const Request = require('../src/modules/members/platinumrequest.model');
const { reasonToSkip } = require('../src/modules/notifications/retryEligibility');
const { expiryBoundary } = require('../src/modules/members/membershipDates');
const members = new Map(), orders = new Map(), bookings = new Map();
const requests = new Map();
let readError = false, reads = 0;
const query = value => ({ lean: async () => { reads++; if (readError) throw Error('Fixture read failed'); return value; } });
Member.findById = id => query(members.get(String(id)) || null);
Order.findOne = filter => query(orders.get(filter.orderId) || null);
Booking.findOne = filter => query(bookings.get(filter.bookingRef) || null);
Request.findOne = filter => {
    const request = requests.get(String(filter._id));
    return query(request?.memberId === filter.memberId ? request : null);
};
const now = Date.now(), day = 86400000;
const future = days => expiryBoundary(new Date(now + days * day));
const recipient = () => ({ _id: 'member-one', membershipStatus: 'pending', isActive: true });
const payment = () => ({ orderId: 'ord_one', memberId: 'member-one', status: 'created', orderType: 'membership',
    createdAt: new Date(now - 10000), expiresAt: new Date(now + 60000) });
const row = (event, data = {}) => ({ event, user: 'member-one', createdAt: new Date(now - 5000), data });
const orderRow = event => row(event, { lifecycleData: { orderId: 'ord_one', paymentId: 'provider-attempt' } });
const renewal = (extra = {}) => ({ ...recipient(), membershipStatus: 'active', membershipType: 'annual',
    membershipExpiresAt: future(7), lastPaymentDate: new Date(now - 350 * day), ...extra });
async function main() {
    assert.equal(await reasonToSkip(row('EVENT_BOOKING_CONFIRMED')), '');
    assert.equal(reads, 0, 'other event notices remain on their existing resend path');
    assert.match(await reasonToSkip(row('PAYMENT_REQUIRED')), /no longer active/);
    members.set('member-one', recipient());
    assert.equal(await reasonToSkip(row('PAYMENT_REQUIRED')), '', 'legacy unpaid member notice remains eligible');
    members.set('member-one', { ...recipient(), membershipStatus: 'active' });
    assert.match(await reasonToSkip(row('PAYMENT_REQUIRED')), /already been completed/);
    members.set('member-one', { ...recipient(), deletedAt: new Date() });
    assert.match(await reasonToSkip(row('PAYMENT_REQUIRED')), /no longer active/);
    members.set('member-one', recipient());
    readError = true;
    assert.match(await reasonToSkip(row('PAYMENT_REQUIRED')), /could not be checked/);
    readError = false;
    assert.match(await reasonToSkip(row('PAYMENT_FAILED')), /could not be verified/);
    assert.match(await reasonToSkip(orderRow('PAYMENT_FAILED')), /no longer exists/);
    orders.set('ord_one', { ...payment(), status: 'paid' });
    assert.match(await reasonToSkip(orderRow('PAYMENT_FAILED')), /already paid or closed/);
    orders.set('ord_one', { ...payment(), expiresAt: new Date(now - 1) });
    assert.match(await reasonToSkip(orderRow('PAYMENT_FAILED')), /expired/);
    orders.set('ord_one', payment());
    assert.equal(await reasonToSkip(orderRow('PAYMENT_FAILED')), '', 'open current failed attempt may retry');
    members.set('member-one', renewal());
    assert.equal(await reasonToSkip(orderRow('PAYMENT_FAILED')), '', 'active member can have a legitimate failed renewal checkout');
    members.set('member-one', renewal({ lastPaymentDate: new Date(now - 3000) }));
    assert.match(await reasonToSkip(orderRow('PAYMENT_FAILED')), /paid since this checkout/);
    orders.set('ord_one', { ...payment(), orderType: 'company_listing' });
    assert.equal(await reasonToSkip(orderRow('PAYMENT_FAILED')), '', 'unrelated renewal does not pay company publishing order');
    orders.set('ord_one', { ...payment(), failedPaymentNoticeIds: ['provider-attempt'] });
    members.set('member-one', recipient());
    assert.match(await reasonToSkip(orderRow('PAYMENT_REQUIRED')), /replaced this pending reminder/);
    orders.set('ord_one', { ...payment(), memberId: 'different-member' });
    assert.match(await reasonToSkip(orderRow('PAYMENT_FAILED')), /no longer matches/);

    const renewalRow = row('MEMBERSHIP_RENEWAL_DUE', { lifecycleData: { expiresAt: future(7).toISOString() } });
    members.set('member-one', renewal());
    assert.equal(await reasonToSkip(renewalRow), '');
    members.set('member-one', renewal({ membershipType: 'lifetime' }));
    assert.match(await reasonToSkip(renewalRow), /no longer due/);
    members.set('member-one', renewal({ membershipExpiresAt: future(90) }));
    assert.match(await reasonToSkip(renewalRow), /no longer due/);
    members.set('member-one', renewal({ membershipExpiresAt: future(8) }));
    assert.match(await reasonToSkip(renewalRow), /validity has changed/);
    members.set('member-one', renewal({ lastPaymentDate: new Date(now - 3000) }));
    assert.match(await reasonToSkip(row('MEMBERSHIP_RENEWAL_DUE')), /paid since this reminder/);
    members.set('member-one', renewal());
    assert.equal(await reasonToSkip(row('MEMBERSHIP_RENEWAL_DUE')), '', 'legacy reminder verifies current renewal window');
    assert.match(await reasonToSkip({ ...row('MEMBERSHIP_RENEWAL_DUE'), createdAt: '' }), /could not be verified/);
    assert.match(await reasonToSkip(row('MEMBERSHIP_RENEWAL_DUE', { expiresAt: 'invalid-date' })), /validity has changed/);

    const eventRow = { ...orderRow('EVENT_PAYMENT_FAILED'), user: undefined };
    orders.set('ord_one', { ...payment(), memberId: null, orderType: 'event_booking', bookingRef: 'BOOK-ONE' });
    bookings.set('BOOK-ONE', { bookingRef: 'BOOK-ONE', userId: '', payment: { status: 'pending' } });
    assert.equal(await reasonToSkip(eventRow), '', 'guest event failure needs no membership record');
    bookings.get('BOOK-ONE').payment.status = 'paid';
    assert.match(await reasonToSkip(eventRow), /already been paid/);
    bookings.get('BOOK-ONE').payment.status = 'pending';
    bookings.get('BOOK-ONE').status = 'cancelled';
    assert.match(await reasonToSkip(eventRow), /no longer active/);
    bookings.get('BOOK-ONE').status = 'pending';
    bookings.get('BOOK-ONE').userId = 'deleted-member';
    assert.match(await reasonToSkip(eventRow), /member account is no longer active/);
    readError = true;
    assert.match(await reasonToSkip(eventRow), /could not be checked/);
    readError = false;

    members.set('member-one', { ...renewal(), membershipTier: 'standard' });
    const declineRow = row('MEMBERSHIP_STATUS_CHANGED', { lifecycleData: {
        change: 'lifetime_request_declined', requestId: 'request-one'
    } });
    requests.set('request-one', { memberId: 'member-one', status: 'declined' });
    assert.equal(await reasonToSkip(declineRow), '');
    requests.get('request-one').status = 'converted';
    assert.match(await reasonToSkip(declineRow), /no longer current/);
    requests.get('request-one').status = 'declined';
    requests.get('request-one').memberId = 'another-member';
    assert.match(await reasonToSkip(declineRow), /no longer current/);
    requests.get('request-one').memberId = 'member-one';
    members.get('member-one').membershipTier = 'platinum';
    assert.match(await reasonToSkip(declineRow), /no longer current/);
    assert.match(await reasonToSkip(row('MEMBERSHIP_STATUS_CHANGED')), /could not be verified/);

    members.set('member-one', { ...renewal(), membershipTier: 'standard' });
    orders.set('ord_one', { ...payment(), status: 'cancelled' });
    const revokeRow = row('MEMBERSHIP_STATUS_CHANGED', { lifecycleData: { change: 'lifetime_revoked',
        orderId: 'ord_one', membershipTier: 'standard', membershipStatus: 'active', membershipType: 'annual'
    } });
    assert.equal(await reasonToSkip(revokeRow), '', 'intentional receipt cancellation does not block correct revocation update');
    members.get('member-one').membershipStatus = 'expired';
    assert.match(await reasonToSkip(revokeRow), /Membership has changed/);
    members.get('member-one').membershipStatus = 'active';
    members.get('member-one').membershipTier = 'platinum';
    assert.match(await reasonToSkip(revokeRow), /Membership has changed/);
    assert.match(await reasonToSkip(row('MEMBERSHIP_STATUS_CHANGED', { lifecycleData: { change: 'lifetime_revoked' } })), /could not be verified/);

    members.set('member-one', { ...renewal(), membershipTier: 'standard', planNotificationState: { planId: 'intermediate' } });
    const planRow = row('MEMBERSHIP_PLAN_ADVANCED', { lifecycleData: { planId: 'intermediate' } });
    assert.equal(await reasonToSkip(planRow), '');
    members.get('member-one').planNotificationState.planId = 'ideal';
    assert.match(await reasonToSkip(planRow), /different membership plan/);
    members.get('member-one').planNotificationState.planId = 'intermediate';
    members.get('member-one').membershipExpiresAt = future(-1);
    assert.match(await reasonToSkip(planRow), /no longer current/);
    assert.match(await reasonToSkip(row('MEMBERSHIP_PLAN_ADVANCED')), /no longer current/);
    readError = true;
    assert.match(await reasonToSkip(planRow), /could not be checked/);
    assert.match(await reasonToSkip(revokeRow), /could not be checked/);
    assert.match(await reasonToSkip(declineRow), /could not be checked/);
    console.log('Retry eligibility checks passed: paid/renewed/deleted members, expired/closed/superseded orders, legacy metadata, event guests and fail-closed reads.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
