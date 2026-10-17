// Exercise the production service using isolated fixtures; never connect to Mongo or send messages.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Member = require('../src/modules/members/memberdetails.model');
const Application = require('../src/modules/applications/application.model');
const Order = require('../src/modules/payment/paymentorder.model');
const plans = require('../src/modules/members/membershipplan.service');
const appsService = require('../src/modules/applications/application.service');
const paymentService = require('../src/modules/payment/payment.service');
const service = require('../src/modules/admin/adminMembershipDashboard.service');
const submittedApplication = require('./fixtures/membershipApplication');
const members = [], apps = [], orders = [], notices = [], reviews = [];
const actor = { role: 'super_admin', userId: new mongoose.Types.ObjectId().toString(), email: 'office@example.test' };
const clone = x => x == null ? x : structuredClone(x);
const matches = (row, f) => Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some(p => matches(row, p));
    if (v === null) return row[k] == null;
    if (v instanceof Date) return +row[k] === +v;
    if (v && typeof v === 'object') {
        if ('$nin' in v) return !v.$nin.includes(row[k]);
        if ('$in' in v) return v.$in.map(String).includes(String(row[k]));
        if ('$ne' in v) return row[k] !== v.$ne;
        if ('$exists' in v) return (row[k] !== undefined) === v.$exists;
    }
    return String(row[k]) === String(v);
});
const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => clone(value), then: (r, e) => Promise.resolve(clone(value)).then(r, e) });
Member.find = f => query(members.filter(m => matches(m, f)));
Member.findOne = f => query(members.find(m => matches(m, f)));
Member.findById = id => query(members.find(m => String(m._id) === String(id)));
let failWrite = false;
Member.findOneAndUpdate = (f, p) => {
    if (failWrite) { failWrite = false; return Promise.reject(new Error('Temporary member write failure')); }
    const m = members.find(m => matches(m, f));
    if (!m) return query(null);
    Object.assign(m, p.$set, { updatedAt: new Date(+m.updatedAt + 1) });
    return query(m);
};
Member.collection.findOne = async f => clone(members.find(m => matches(m, f)));
Member.collection.updateOne = async (f, p) => {
    const member = members.find(m => matches(m, f));
    if (member) Object.assign(member, p.$set);
    return { matchedCount: member ? 1 : 0 };
};
require('../src/modules/auth/auth.model').findOne = () => query(null);
Application.find = f => query(apps.filter(a => matches(a, f)).sort((a, b) => +b.updatedAt - +a.updatedAt));
Application.findById = async id => { const row = apps.find(a => a._id === String(id)); return row ? new Application(row) : null; };
require('../src/modules/members/personalinfo1.model').findOne = () => query(null);
Order.find = f => query(orders.filter(o => matches(o, f)).sort((a, b) => +b.createdAt - +a.createdAt));
Order.create = async o => { const receipt = { ...clone(o), _id: new mongoose.Types.ObjectId().toString(), createdAt: new Date() }; orders.push(receipt); return receipt; };
Order.updateOne = async (f, p) => Object.assign(orders.find(o => matches(o, f)), p.$set);
plans.listActive = async () => [{ key: 'student', id: 'db-id', name: 'Student', price: 1000, audience: 'student', membershipType: 'annual' }, { key: 'platinum', audience: 'platinum' }];
plans.listAll = () => plans.listActive();
require('../src/modules/members/businessinfo.model').findOne = () => query(null);
require('../src/modules/members/businessinfo.model').find = () => query([]);
plans.getPlanForPayment = async id => id === 'student' ? { id, name: 'Student', amount: 1000, membershipType: 'annual' } : null;
appsService.reviewApplication = async (id, action, user) => { const a = apps.find(a => a._id === id); assert.equal(action, 'approve'); assert.equal(user.role, 'super_admin'); a.status = 'Approved'; reviews.push(id); };
require('../src/modules/members/memberNumber').prepareMembershipNumber = async (m, requested) => m.membershipNumber || requested || 'ACTIV-20261012-001';
require('../src/modules/members/memberNumber').assignMembershipNumber = async m => m.membershipNumber;
paymentService.announceMembershipActivation = async (m, payload) => notices.push({ member: m, payload });
const fixture = (status = 'Approved', overrides = {}) => {
    const _id = new mongoose.Types.ObjectId().toString();
    const m = { _id, fullName: 'Test Member', email: `${_id}@example.test`, phoneNumber: '9000000000', role: 'member', memberType: 'student', membershipStatus: 'pending', isActive: true, createdAt: new Date(), updatedAt: new Date(), ...overrides };
    members.push(m);
    if (status) apps.push({ ...submittedApplication(m, { status }), _id: new mongoose.Types.ObjectId().toString() });
    return m;
};
const body = { planId: 'student', mode: 'waived', note: 'Office fee exemption approved.' };

async function main() {
    await assert.rejects(service.overview({ role: 'district_admin' }), e => e.statusCode === 403);
    await assert.rejects(service.confirm(new mongoose.Types.ObjectId().toString(), body, { role: 'member' }), e => e.statusCode === 403);
    await assert.rejects(service.detail('invalid', actor), e => e.statusCode === 400);
    const unsubmitted = fixture(null);
    await assert.rejects(service.confirm(unsubmitted._id, body, actor), /submit their application/);
    await assert.rejects(service.confirm(unsubmitted._id, { ...body, manualAdmission: true }, actor), /submit their application/);
    const missingConsent = fixture('Pending');
    delete apps.find(a => a.userId === missingConsent._id).data.declaration;
    await assert.rejects(service.confirm(missingConsent._id, { ...body, manualAdmission: true }, actor), /declaration/i);
    assert.equal(orders.length, 0, 'incomplete submissions never create a receipt');
    assert.equal(reviews.length, 0, 'incomplete submissions are not approved');
    const wrongOwner = fixture(null);
    apps.push({ ...submittedApplication(wrongOwner), _id: new mongoose.Types.ObjectId().toString(), userId: new mongoose.Types.ObjectId().toString() });
    await assert.rejects(service.confirm(wrongOwner._id, { ...body, manualAdmission: true }, actor), /submit their application/);
    const rejected = fixture('Rejected');
    await assert.rejects(service.confirm(rejected._id, body, actor), /Review the application/);
    const blocked = fixture('Approved', { isActive: false });
    await assert.rejects(service.confirm(blocked._id, body, actor), /Unblock/);
    const waived = fixture('Pending');
    await assert.rejects(service.confirm(waived._id, { ...body, note: '' }, actor), /reason/);
    await assert.rejects(service.confirm(waived._id, { ...body, planId: 'platinum' }, actor), /active membership plan/);
    const result = await service.confirm(waived._id, { ...body, amount: 9999 }, actor);
    assert.equal(result.member.status, 'active');
    assert.equal(result.member.collected, 0, 'client amount cannot fake a waived receipt');
    assert.equal(result.member.confirmation, 'Fee waived');
    assert.equal(result.payments[0].manual.waivedAmount, 1000);
    assert.equal(result.payments[0].manual.by, actor.userId);
    assert.equal(result.member.applicationStatus, 'Approved');
    assert.equal(reviews.length, 1);
    assert.equal(notices[0].payload.amount, 0);
    assert.equal(notices[0].payload.paymentMode, 'waived');
    assert.equal(waived.membershipExpiresAt.getFullYear(), new Date().getFullYear() + 1);
    await assert.rejects(service.confirm(waived._id, body, actor), /already active/);
    const offline = fixture();
    await assert.rejects(service.confirm(offline._id, { ...body, mode: 'upi', amount: 0 }, actor), /actual amount/);
    const paid = await service.confirm(offline._id, { ...body, mode: 'upi', amount: 1000, receiptNumber: 'UTR-TEST' }, actor);
    assert.equal(paid.member.collected, 1000);
    assert.equal(paid.payments[0].paymentId, 'UTR-TEST');
    assert.equal(notices.find(n => n.member._id === offline._id).payload.paymentMode, 'upi');
    assert.equal(notices.find(n => n.member._id === offline._id).payload.orderId, paid.payments[0].orderId);
    const concurrent = fixture();
    const attempts = await Promise.allSettled([service.confirm(concurrent._id, body, actor), service.confirm(concurrent._id, body, actor)]);
    assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1, 'only one concurrent grant wins');
    assert.equal(orders.filter(o => o.memberId === concurrent._id && o.status === 'paid').length, 1);
    assert.equal(notices.filter(n => n.member._id === concurrent._id).length, 1);
    const retry = fixture(); failWrite = true;
    await assert.rejects(service.confirm(retry._id, body, actor), /Temporary member write/);
    assert.equal(orders.find(o => o.memberId === retry._id).status, 'cancelled');
    assert.equal(retry.membershipStatus, 'pending');
    await service.confirm(retry._id, body, actor);
    // Expiring membership renewal extends from the existing end, not today.
    const end = new Date(Date.now() + 10 * 86400000);
    const renew = fixture('Approved', { membershipStatus: 'active', membershipType: 'annual', membershipExpiresAt: end });
    await service.confirm(renew._id, body, actor);
    const extended = require('../src/modules/members/membershipDates').annualExpiry(end);
    assert.equal(+renew.membershipExpiresAt, +extended);
    fixture(null, { role: 'super_admin' });
    orders.push({ _id: 'event', orderType: 'event_booking', status: 'paid', amount: 9000, createdAt: new Date() });
    const dashboard = await service.overview(actor);
    assert.equal(dashboard.summary.registered, members.length - 1, 'include unsubmitted accounts but exclude administrators');
    assert.equal(dashboard.summary.collected, 1000, 'waivers, cancelled grants and event money are excluded');
    assert.equal(dashboard.payments.some(p => p.id === 'event'), false);
    assert.equal(dashboard.plans[0].id, 'student', 'UI submits the plan key, not the database ID');
    assert.equal(dashboard.plans.length, 1, 'Platinum uses its existing grant page');
    assert.equal(service.memberRow(unsubmitted, null, []).status, 'registered');
    await assert.rejects(service.confirm(unsubmitted._id, { ...body, mode: 'cash', amount: 1000, manualAdmission: true, note: 'Identity checked at the office.' }, actor), /submit their application/);
    assert.equal(service.memberRow(unsubmitted, null, []).canConfirm, false);
    assert.equal(notices.filter(n => n.member._id === unsubmitted._id).length, 0);
    const legacyRenewal = fixture(null, { membershipStatus: 'expired', membershipType: 'annual', membershipExpiresAt: new Date(Date.now() - 86400000) });
    await service.confirm(legacyRenewal._id, body, actor);
    assert.equal(legacyRenewal.membershipStatus, 'active', 'an established member may renew without a new application');
    await assert.rejects(service.remove(offline._id, { role: 'state_admin' }), e => e.statusCode === 403);
    // The destructive database workflow is exercised against disposable Mongo
    // in member-deletion-local.test.js. Here verify delegation and fresh totals.
    require('../src/modules/members/memberDeletion.service').remove = async (id, user) => {
        assert.equal(id, offline._id);
        assert.equal(user.role, 'super_admin');
        members.splice(members.findIndex(m => m._id === id), 1);
        for (const rows of [apps, orders]) {
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].userId === id || rows[i].memberId === id) rows.splice(i, 1);
            }
        }
        return { deleted: true };
    };
    await service.remove(offline._id, actor);
    assert.equal(members.some(m => m._id === offline._id), false);
    await assert.rejects(service.confirm(offline._id, body, actor), /Member not found/);
    await assert.rejects(service.detail(offline._id, actor), /Member not found/);
    const afterDelete = await service.overview(actor);
    assert.equal(afterDelete.rows.some(r => r.id === offline._id), false);
    assert.equal(afterDelete.summary.collected, 0, 'permanently removed membership payments leave current totals');
    assert.equal(afterDelete.payments.some(p => p.memberId === offline._id), false);
    const authoritative = fixture('Approved');
    apps.push({ _id: new mongoose.Types.ObjectId().toString(), userId: authoritative._id, email: authoritative.email, status: 'Rejected', updatedAt: new Date(Date.now() + 1000) });
    assert.equal((await service.detail(authoritative._id, actor)).member.applicationStatus, 'Approved', 'approved applications match the existing member directory');
    console.log('Membership registrations: permissions, submitted application approval, waivers, offline receipts, duplicate grants, write recovery, renewal and financial totals passed.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
