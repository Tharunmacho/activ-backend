// Isolated state fixtures: no database, SMTP, WhatsApp or scheduler starts.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const Member = require('../src/modules/members/memberdetails.model');
const Application = require('../src/modules/applications/application.model');
const Order = require('../src/modules/payment/paymentorder.model');
const { reasonToSkip, snapshotActivation } = require('../src/modules/notifications/retryEligibility');
const now = Date.now(), decisionAt = new Date(now - 5000), sentAt = new Date(now - 1000);
let member, linkedMember, application, order, failedRead = false;
const query = value => ({ lean: async () => { if (failedRead) throw Error('offline fixture'); return value; } });
Member.findById = () => query(member);
Member.findOne = filter => { assert.deepEqual(filter, { userId: 'member' }); return query(linkedMember); };
Application.findById = () => query(application);
Order.findOne = () => query(order);
const row = (event, data = {}) => ({ event, user: 'member', createdAt: sentAt,
    data: { lifecycleData: { applicationId: 'application', ...data } } });
const verdict = (decision = 'approved') => ({ decision, decidedAt: decisionAt, auto: false });
const reset = () => {
    member = { _id: 'member', isActive: true, membershipStatus: 'pending' };
    application = { _id: 'application', userId: 'member', status: 'Pending', reviews: {} };
    order = null; linkedMember = null; failedRead = false;
};
async function main() {
    reset();
    assert.equal(await reasonToSkip(row('APPLICATION_SUBMITTED')), '');
    linkedMember = { ...member, _id: 'profile', userId: 'member' }; member = null;
    assert.equal(await reasonToSkip(row('APPLICATION_SUBMITTED')), '', 'legacy linked profile remains eligible');
    application.status = 'Approved'; application.reviews.state = verdict();
    assert.equal(await reasonToSkip(row('APPLICATION_APPROVED', { reviewDecision: 'approved', reviewDecidedAt: decisionAt.toISOString() })), '',
        'legacy linked profile receives its current final decision');
    application.userId = 'different-owner';
    assert.match(await reasonToSkip(row('APPLICATION_APPROVED')), /no longer matches/, 'legacy fallback does not weaken application ownership');
    application.userId = 'member'; linkedMember = null;
    assert.match(await reasonToSkip(row('APPLICATION_APPROVED')), /no longer active/, 'no direct or linked profile remains ineligible');
    reset();
    application.status = 'Approved';
    assert.match(await reasonToSkip(row('APPLICATION_SUBMITTED')), /progressed/);
    reset();
    application.reviews.block = verdict();
    const endorsed = row('APPLICATION_ENDORSED', { tier: 'block', reviewDecision: 'approved', reviewDecidedAt: decisionAt.toISOString() });
    assert.equal(await reasonToSkip(endorsed), '');
    application.reviews.district = verdict();
    assert.match(await reasonToSkip(endorsed), /superseded/);
    delete application.reviews.district;
    application.reviews.block.auto = true;
    assert.match(await reasonToSkip(endorsed), /no longer current/);
    reset();
    application.status = 'Approved'; application.reviews.state = verdict();
    const approved = row('APPLICATION_APPROVED', { tier: 'super', reviewDecision: 'approved', reviewDecidedAt: decisionAt.toISOString() });
    assert.equal(await reasonToSkip(approved), '');
    application.reviews.state.decidedAt = new Date(now);
    assert.match(await reasonToSkip(approved), /newer review/);
    application.reviews.state.decidedAt = decisionAt;
    member.membershipStatus = 'active';
    assert.match(await reasonToSkip(approved), /completed membership payment/);
    member.membershipStatus = 'pending'; application.status = 'Rejected';
    assert.match(await reasonToSkip(approved), /decision has changed/);
    application.reviews.state = verdict('rejected'); application.rejectionReason = 'Correct the address';
    const rejected = row('CORRECTION_REQUESTED', { reason: 'Correct the address', reviewDecision: 'rejected', reviewDecidedAt: decisionAt.toISOString() });
    assert.equal(await reasonToSkip(rejected), '');
    application.rejectionReason = 'Different decision';
    assert.match(await reasonToSkip(rejected), /reason has changed/);
    application.userId = 'another-member';
    assert.match(await reasonToSkip(rejected), /no longer matches/);
    failedRead = true;
    assert.match(await reasonToSkip(rejected), /could not be checked/);

    reset();
    member = { ...member, membershipStatus: 'active', membershipType: 'annual', membershipTier: 'standard',
        membershipActivatedAt: new Date(now - 86400000), membershipExpiresAt: new Date(now + 300 * 86400000),
        paymentId: 'receipt-one', lastPaymentDate: decisionAt };
    order = { orderId: 'receipt-one', orderType: 'membership', status: 'paid', memberId: 'member' };
    const activated = row('MEMBERSHIP_ACTIVATED', { activationState: snapshotActivation(member), orderId: 'receipt-one' });
    assert.equal(await reasonToSkip(activated), '');
    member.paymentId = 'receipt-two';
    assert.match(await reasonToSkip(activated), /Membership has changed/);
    member.paymentId = 'receipt-one';
    member.membershipExpiresAt = new Date(now + 365 * 86400000);
    assert.match(await reasonToSkip(activated), /Membership has changed/);
    member.membershipExpiresAt = new Date(now + 300 * 86400000);
    order.status = 'cancelled';
    assert.match(await reasonToSkip(activated), /no longer confirmed/);
    order.status = 'paid';
    assert.match(await reasonToSkip(row('MEMBERSHIP_ACTIVATED')), /original activation period/);
    member.membershipStatus = 'expired';
    assert.match(await reasonToSkip(activated), /no longer current/);
    member.membershipStatus = 'active'; member.deletedAt = new Date();
    assert.match(await reasonToSkip(activated), /no longer current/);
    console.log('PASS: direct/legacy linked application ownership, stale decisions, superseded endorsements, changed reasons, activation periods and fail-closed reads.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
