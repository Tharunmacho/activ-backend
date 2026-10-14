// Execute the actual request-decision/revocation paths with no DB/provider writes.
const assert = require('assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Member = require('../src/modules/members/memberdetails.model');
const Request = require('../src/modules/members/platinumrequest.model');
const Order = require('../src/modules/payment/paymentorder.model');
const Application = require('../src/modules/applications/application.model');
const notificationService = require('../src/modules/notifications/notification.service');
const members = new Map(), requests = new Map(), orders = new Map(), notices = [];
let cancelWriteFails = false;
const clone = value => structuredClone(value);
Member.findById = async id => members.has(String(id)) ? new Member(clone(members.get(String(id)))) : null;
Request.findById = async id => requests.has(String(id)) ? new Request(clone(requests.get(String(id)))) : null;
Request.findOneAndUpdate = async (filter, update) => {
    const row = requests.get(String(filter._id));
    if (!row || row.status !== filter.status || +new Date(row.updatedAt) !== +new Date(filter.updatedAt)) return null;
    Object.assign(row, update.$set, { updatedAt: new Date(+new Date(row.updatedAt) + 1) });
    return new Request(clone(row));
};
Member.findOneAndUpdate = async (filter, update) => {
    const row = members.get(String(filter._id));
    if (!row || row.membershipTier !== filter.membershipTier || (row.platinumGrant?.orderId ?? null) !== filter['platinumGrant.orderId']) return null;
    Object.assign(row, update.$set);
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    return new Member(clone(row));
};
Order.updateOne = async (filter, update) => {
    if (cancelWriteFails) throw Error('Fixture receipt write failed');
    const order = orders.get(filter.orderId);
    assert.deepEqual(update, { $set: { status: 'cancelled' } }, 'revocation only cancels the existing receipt, never invents a refund');
    if (order && order.provider === filter.provider) Object.assign(order, update.$set);
    return { matchedCount: order ? 1 : 0 };
};
Application.find = () => ({ select() { return this; }, sort() { return this; }, lean: async () => [] });
notificationService.dispatchInBackground = (event, recipient, payload) => notices.push({ event, recipient, payload });
const service = require('../src/modules/members/platinum.service');
const actor = { role: 'super_admin', email: 'office@example.test' };
const fixture = () => {
    const id = new mongoose.Types.ObjectId().toString();
    const member = { _id: id, fullName: 'Current member', email: 'current@example.test', phoneNumber: '9000000000',
        whatsappNumber: '9000000001', membershipTier: 'standard', membershipType: 'annual', membershipStatus: 'active',
        paymentId: 'original-payment', paymentAmount: 1000, lastPaymentDate: new Date('2026-01-01'),
        membershipActivatedAt: new Date('2026-01-01'), membershipExpiresAt: new Date('2027-01-01'),
        membershipNumber: 'ACTIV-BEG-20260101-001', isActive: true, updatedAt: new Date('2026-01-01') };
    members.set(id, member);
    const request = { _id: new mongoose.Types.ObjectId().toString(), memberId: id,
        name: 'Old request name', email: 'old-address@example.test', phone: '9000000002', status: 'new',
        createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') };
    requests.set(request._id, request);
    return { member, request };
};
const lifetime = () => {
    const pair = fixture();
    const m = pair.member;
    const orderId = `OFF-${m._id}`;
    m.platinumGrant = { orderId, grantedAt: new Date(), amount: 200000, paymentMode: 'cash',
        previous: { membershipStatus: m.membershipStatus, membershipType: m.membershipType,
            membershipExpiresAt: m.membershipExpiresAt, membershipActivatedAt: m.membershipActivatedAt } };
    Object.assign(m, { membershipTier: 'platinum', membershipType: 'lifetime', membershipExpiresAt: null,
        paymentId: orderId, paymentAmount: 200000, lastPaymentDate: new Date('2026-10-01') });
    orders.set(orderId, { orderId, provider: 'offline', status: 'paid', amount: 200000, memberId: m._id });
    return pair;
};
async function main() {
    const first = fixture(), originalMembership = clone(first.member);
    const declined = await service.updateRequest(first.request._id, { status: 'declined', notes: 'Private office discussion' }, actor);
    assert.equal(declined.status, 'declined');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].event, 'MEMBERSHIP_STATUS_CHANGED');
    assert.equal(notices[0].recipient.email, 'current@example.test', 'current account owns delivery, not old request snapshot');
    assert.equal(notices[0].recipient.whatsapp, '9000000001');
    assert.equal(notices[0].payload.data.change, 'lifetime_request_declined');
    assert.equal(notices[0].payload.reference, first.request._id);
    assert.ok(!JSON.stringify(notices[0]).includes('Private office discussion'), 'internal notes never leave the office');
    assert.deepEqual(first.member, originalMembership, 'declining request does not alter membership or money');
    await service.updateRequest(first.request._id, { status: 'declined' }, actor);
    await service.updateRequest(first.request._id, { notes: 'More internal notes' }, actor);
    assert.equal(notices.length, 1, 'repeated status or notes edits do not repeat a decision notice');
    await assert.rejects(service.updateRequest(first.request._id, { status: 'unsupported' }, actor), /Unknown status/);
    assert.equal(notices.length, 1);

    const concurrent = fixture();
    const changed = await Promise.allSettled([
        service.updateRequest(concurrent.request._id, { status: 'declined' }, actor),
        service.updateRequest(concurrent.request._id, { status: 'declined' }, actor)
    ]);
    assert.equal(changed.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(notices.length, 2, 'one actual concurrent decision, one notice');
    const handled = fixture();
    await service.updateRequest(handled.request._id, { status: 'contacted' }, actor);
    await service.updateRequest(handled.request._id, { status: 'converted' }, actor);
    assert.equal(notices.length, 2, 'internal queue states do not announce a membership grant');
    const deleted = fixture(); members.delete(deleted.member._id);
    await service.updateRequest(deleted.request._id, { status: 'declined' }, actor);
    assert.equal(notices.length, 2, 'deleted account receives no stale request decision');

    const granted = lifetime(), original = clone(granted.member), receiptId = original.platinumGrant.orderId;
    const restored = await service.revoke(granted.member._id, actor);
    assert.equal(restored.membershipTier, 'standard');
    assert.equal(restored.membershipType, 'annual');
    assert.equal(restored.membershipStatus, 'active');
    assert.equal(+new Date(granted.member.membershipExpiresAt), +new Date(original.platinumGrant.previous.membershipExpiresAt));
    assert.equal(+new Date(granted.member.membershipActivatedAt), +new Date(original.platinumGrant.previous.membershipActivatedAt));
    assert.equal(granted.member.platinumGrant, undefined);
    assert.equal(orders.get(receiptId).status, 'cancelled');
    assert.equal(orders.get(receiptId).amount, 200000);
    assert.equal(granted.member.paymentId, original.paymentId);
    assert.equal(granted.member.paymentAmount, original.paymentAmount);
    assert.equal(+new Date(granted.member.lastPaymentDate), +new Date(original.lastPaymentDate));
    assert.equal(notices.length, 3);
    assert.equal(notices.at(-1).payload.data.change, 'lifetime_revoked');
    assert.equal(notices.at(-1).payload.reference, receiptId);
    assert.doesNotMatch(JSON.stringify(notices.at(-1)), /refund|cancellation fee/i);
    await assert.rejects(service.revoke(granted.member._id, actor), /not a Lifetime/);
    assert.equal(notices.length, 3);

    const revokeRace = lifetime();
    const removals = await Promise.allSettled([service.revoke(revokeRace.member._id, actor), service.revoke(revokeRace.member._id, actor)]);
    assert.equal(removals.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(notices.length, 4, 'one actual concurrent revocation, one notice');
    const failedWrite = lifetime(); cancelWriteFails = true;
    await assert.rejects(service.revoke(failedWrite.member._id, actor), /Fixture receipt write/);
    assert.equal(failedWrite.member.membershipTier, 'platinum');
    assert.equal(notices.length, 4, 'failed state change never announces success');
    console.log('Lifetime lifecycle checks passed: actual decisions only, duplicate/concurrent suppression, current member contacts, private notes, restored membership and preserved receipt history.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
