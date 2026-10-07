const crypto = require('crypto');
const mongoose = require('mongoose');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const Order = require('../payment/paymentorder.model');
const plans = require('../members/membershipplan.service');
const ApiError = require('../../core/utils/ApiError');
const { normalizeStatus } = require('../common/applicationStatus');
const { membershipState, renewalFor, renewalBase } = require('../members/membershipState');
const { invalidateMemberContext } = require('../common/memberContext');
const { membershipNumberFor } = require('../members/memberNumber');

const MEMBER_FILTER = { deletedAt: null, role: { $nin: ['super_admin', 'state_admin', 'district_admin', 'block_admin', 'cms_admin', 'events_admin', 'admin'] } };
const MEMBER_FIELDS = 'fullName email phoneNumber whatsappNumber role memberType registrationType state district block membershipNumber membershipStatus membershipType membershipTier membershipActivatedAt membershipExpiresAt paymentId paymentAmount lastPaymentDate isActive createdAt updatedAt';
const superOnly = (actor) => { if (actor?.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can manage membership registrations.'); };
const validId = (id) => { if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid member ID.'); };
const appFor = (member, apps) => {
    const own = apps.filter(a => String(a.userId) === String(member._id) || (a.email && a.email.toLowerCase() === member.email?.toLowerCase()));
    // Match the existing directory: an approved application remains authoritative.
    return own.find(a => normalizeStatus(a.status) === 'Approved') || own[0];
};
const paymentRow = (o, member) => ({
    id: String(o._id), memberId: String(o.memberId || ''), name: member?.fullName || 'Deleted account', email: o.email, registrationDeleted: !member,
    orderId: o.orderId, planId: o.planId, planName: o.planName, amount: Number(o.amount || 0),
    status: o.status, provider: o.provider, mode: o.paymentMethod || o.provider,
    paymentId: o.gatewayPaymentId || '', createdAt: o.createdAt, paidAt: o.paidAt || null,
    expiresAt: o.expiresAt, manual: o.manualConfirmation || null
});
const memberRow = (m, app, orders = []) => {
    const outcome = app ? normalizeStatus(app.status) : 'Not submitted';
    const state = membershipState(m, { outcome });
    const paid = orders.filter(o => o.status === 'paid');
    const latest = paid[0];
    const blocked = m.isActive === false;
    const canConfirm = !blocked && (!app || ['Pending', 'Approved'].includes(outcome))
        && (state.state !== 'active' || renewalFor(m).canRenew);
    return {
        id: String(m._id), name: m.fullName || '', email: m.email || '', phone: m.phoneNumber || m.whatsappNumber || '',
        kind: m.memberType || m.registrationType || 'member', region: [m.block, m.district, m.state].filter(Boolean).join(', '),
        registeredAt: m.createdAt, memberNumber: membershipNumberFor(m), applicationId: app ? String(app._id) : '',
        applicationStatus: outcome, submittedAt: app?.submittedAt || app?.createdAt || null,
        status: blocked ? 'blocked' : state.state === 'none' ? (outcome === 'Not submitted' ? 'registered' : outcome.toLowerCase()) : state.state,
        membershipType: m.membershipType || 'none', planName: latest?.planName || '',
        activatedAt: m.membershipActivatedAt || null, expiresAt: state.expiresAt, lifetime: state.lifetime,
        collected: paid.reduce((n, o) => n + Number(o.amount || 0), 0),
        confirmation: latest?.paymentMethod === 'waived' ? 'Fee waived' : latest?.provider === 'offline' ? 'Office payment' : latest ? 'Online payment' : '',
        canConfirm, requiresManualAdmission: !app,
        blockedReason: canConfirm ? '' : blocked ? 'Unblock this account before confirming membership.' : !app ? 'The member must submit their application first.' : !['Pending', 'Approved'].includes(outcome) ? 'Review the application before confirming membership.' : 'This membership is already active. Renewal opens during its final 30 days.'
    };
};

class MembershipDashboardService {
    async overview(actor) {
        superOnly(actor);
        const [members, apps, orders, activePlans] = await Promise.all([
            Member.find(MEMBER_FILTER).select(MEMBER_FIELDS).sort({ createdAt: -1 }).lean(),
            Application.find({}).select('userId email status submittedAt createdAt updatedAt').sort({ updatedAt: -1 }).lean(),
            Order.find({ orderType: 'membership' }).sort({ createdAt: -1 }).lean(), plans.listActive()
        ]);
        const byMember = new Map();
        for (const o of orders) { const id = String(o.memberId); if (!byMember.has(id)) byMember.set(id, []); byMember.get(id).push(o); }
        const rows = members.map(m => memberRow(m, appFor(m, apps), byMember.get(String(m._id)) || []));
        const lookup = new Map(members.map(m => [String(m._id), m]));
        const now = Date.now();
        return {
            rows, payments: orders.map(o => paymentRow(o, lookup.get(String(o.memberId)))),
            plans: activePlans.filter(p => p.audience !== 'platinum').map(p => ({ id: p.key, name: p.name, price: p.price, membershipType: p.membershipType })),
            summary: {
                registered: rows.length, submitted: rows.filter(r => r.applicationId).length,
                active: rows.filter(r => r.status === 'active').length,
                awaiting: rows.filter(r => r.status === 'awaiting_payment').length,
                pendingReview: rows.filter(r => r.applicationStatus === 'Pending').length,
                expired: rows.filter(r => r.status === 'expired').length,
                collected: orders.filter(o => o.status === 'paid').reduce((n, o) => n + Number(o.amount || 0), 0),
                waived: orders.filter(o => o.status === 'paid' && o.paymentMethod === 'waived').length,
                openOrders: orders.filter(o => o.status === 'created' && new Date(o.expiresAt).getTime() > now).length
            }
        };
    }

    async detail(id, actor) {
        superOnly(actor); validId(id);
        const m = await Member.findOne({ ...MEMBER_FILTER, _id: id }).select(MEMBER_FIELDS).lean();
        if (!m) throw ApiError.notFound('Member not found.');
        const [apps, orders] = await Promise.all([
            Application.find({ $or: [{ userId: id }, { email: m.email }] }).select('userId email status submittedAt createdAt updatedAt').sort({ updatedAt: -1 }).lean(),
            Order.find({ memberId: id, orderType: 'membership' }).sort({ createdAt: -1 }).lean()
        ]);
        return { member: memberRow(m, appFor(m, apps), orders), payments: orders.map(o => paymentRow(o, m)) };
    }

    async confirm(id, body, actor) {
        superOnly(actor); validId(id);
        const mode = String(body.mode || 'cash');
        if (!['waived', 'cash', 'upi', 'bank_transfer', 'cheque'].includes(mode)) throw ApiError.badRequest('Choose a valid confirmation mode.');
        const note = String(body.note || '').trim().slice(0, 500);
        if (!note) throw ApiError.badRequest('Enter the reason or payment receipt details for this confirmation.');
        const plan = await plans.getPlanForPayment(body.planId);
        if (!plan) throw ApiError.badRequest('Choose an active membership plan. Use the Lifetime page for Lifetime grants.');
        const amount = mode === 'waived' ? 0 : Number(body.amount);
        if (!Number.isFinite(amount) || (mode !== 'waived' && amount <= 0)) throw ApiError.badRequest('Enter the actual amount received. Use fee waiver when no payment was received.');
        let detail = await this.detail(id, actor);
        if (!detail.member.canConfirm) throw ApiError.badRequest(detail.member.blockedReason);
        if (detail.member.requiresManualAdmission && body.manualAdmission !== true) {
            throw ApiError.badRequest('The member must submit their application, or the Super Admin must explicitly confirm office admission after checking their details.');
        }
        // Use the same reviewed approval workflow as the application queue.
        if (detail.member.applicationStatus === 'Pending') {
            await require('../applications/application.service').reviewApplication(detail.member.applicationId, 'approve', actor);
        }
        const member = await Member.findById(id).select(MEMBER_FIELDS).lean();
        if (!member || member.isActive === false) throw ApiError.badRequest('This account is unavailable.');
        const current = membershipState(member);
        if (current.state === 'active' && !renewalFor(member).canRenew) throw ApiError.conflict('Membership is already active.');
        const now = new Date();
        const expiry = plan.membershipType === 'lifetime' ? null : renewalBase(member, { now });
        if (expiry) expiry.setFullYear(expiry.getFullYear() + 1);
        const orderId = `OFF-${now.getFullYear()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        // Keep the receipt before granting access, so paymentReconcile can find it.
        const receipt = await Order.create({
            orderId, memberId: member._id, email: member.email, planId: plan.id, planName: plan.name, planAudience: plan.audience,
            amount, currency: 'INR', orderType: 'membership', membershipType: plan.membershipType,
            provider: 'offline', status: 'paid', paymentMethod: mode, paidAt: now, expiresAt: now,
            applicationId: detail.member.applicationId, gatewayPaymentId: String(body.receiptNumber || '').trim().slice(0, 120) || orderId,
            manualConfirmation: { by: String(actor.userId || actor.id || actor._id || ''), byName: actor.email || 'Super Admin', at: now, note, admission: detail.member.requiresManualAdmission,
                expectedAmount: plan.amount, waivedAmount: Math.max(0, plan.amount - amount), receiptNumber: String(body.receiptNumber || '').trim().slice(0, 120) }
        });
        let activated;
        try {
            // Optimistic compare prevents simultaneous clicks from granting two periods.
            activated = await Member.findOneAndUpdate({ _id: id, updatedAt: member.updatedAt, isActive: { $ne: false } }, { $set: {
                membershipStatus: 'active', membershipType: plan.membershipType, membershipExpiresAt: expiry,
                membershipActivatedAt: member.membershipActivatedAt || now, paymentId: orderId, paymentAmount: amount, lastPaymentDate: now
            } }, { new: true });
            if (!activated) throw ApiError.conflict('Member details changed. Refresh and check their membership before confirming again.');
        } catch (error) {
            await Order.updateOne({ _id: receipt._id }, { $set: { status: 'cancelled' } });
            throw error;
        }
        invalidateMemberContext(id);
        // A post-activation side effect cannot invalidate an already confirmed grant.
        const assigned = await require('../members/memberNumber').assignMembershipNumber(activated).catch(() => '');
        if (assigned) activated.membershipNumber = assigned;
        await require('../payment/payment.service').announceMembershipActivation(activated, { amount, orderId, planName: plan.name, paymentMode: mode }).catch(() => {});
        return this.detail(id, actor);
    }

    async remove(id, actor) {
        superOnly(actor); validId(id);
        // Archive rather than erase receipts. The model excludes archived accounts
        // from login, profile/payment writes and registration directories.
        const removed = await Member.findOneAndUpdate({ ...MEMBER_FILTER, _id: id }, { $set: {
            deletedAt: new Date(), deletedBy: String(actor.userId || actor.id || actor._id || ''),
            isActive: false, membershipStatus: 'cancelled'
        } }, { new: true });
        if (!removed) throw ApiError.notFound('Member not found.');
        invalidateMemberContext(id);
        return { id: String(removed._id), deleted: true };
    }
}
module.exports = new MembershipDashboardService();
module.exports.memberRow = memberRow;
