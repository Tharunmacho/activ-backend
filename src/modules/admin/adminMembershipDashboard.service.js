const crypto = require('crypto');
const mongoose = require('mongoose');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const Order = require('../payment/paymentorder.model');
const plans = require('../members/membershipplan.service');
const Business = require('../members/businessinfo.model');
const planRules = require('../members/membershipPlanRules');
const ApiError = require('../../core/utils/ApiError');
const { normalizeStatus } = require('../common/applicationStatus');
const { membershipState, renewalFor, renewalBase } = require('../members/membershipState');
const { invalidateMemberContext } = require('../common/memberContext');
const { membershipNumberFor } = require('../members/memberNumber');
const { displayPlanName } = require('../members/membershipLabels');

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
    orderId: o.orderId, planId: o.planId, planName: displayPlanName(o.planName, o.planId, o.planAudience), amount: Number(o.amount || 0),
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
        registeredAt: m.createdAt, memberNumber: membershipNumberFor(m), assignedMemberNumber: String(m.membershipNumber || ''), applicationId: app ? String(app._id) : '',
        applicationStatus: outcome, submittedAt: app?.submittedAt || app?.createdAt || null,
        status: blocked ? 'blocked' : state.state === 'none' ? (outcome === 'Not submitted' ? 'registered' : outcome.toLowerCase()) : state.state,
        membershipType: m.membershipType || 'none', planName: displayPlanName(latest?.planName, m.membershipTier, latest?.planId, latest?.planAudience),
        activatedAt: m.membershipActivatedAt || null, expiresAt: state.expiresAt, lifetime: state.lifetime,
        collected: paid.reduce((n, o) => n + Number(o.amount || 0), 0),
        confirmation: latest?.paymentMethod === 'waived' ? 'Fee waived' : latest?.provider === 'offline' ? 'Office payment' : latest ? 'Online payment' : '',
        canConfirm, requiresManualAdmission: !app,
        blockedReason: canConfirm ? '' : blocked ? 'Unblock this account before confirming membership.' : !app ? 'The member must submit their application first.' : !['Pending', 'Approved'].includes(outcome) ? 'Review the application before confirming membership.' : 'This membership is already active. Renewal opens during its final 30 days.'
    };
};
const currentMemberRow = (member, application, orders, business, catalogue) => {
    const row = memberRow(member, application, orders);
    if (row.lifetime) return row;
    const paid = orders.find(o => o.status === 'paid');
    const progression = planRules.progression(member, business, paid, catalogue);
    const options = planRules.officeOptions(member, business, paid, catalogue);
    return { ...row, kind: progression.kind, planName: progression.effective?.name || (options.plans.length === 1 ? options.plans[0].name : row.planName) };
};

class MembershipDashboardService {
    async overview(actor) {
        superOnly(actor);
        const [members, apps, orders, activePlans, businesses] = await Promise.all([
            Member.find(MEMBER_FILTER).select(MEMBER_FIELDS).sort({ createdAt: -1 }).lean(),
            Application.find({}).select('userId email status submittedAt createdAt updatedAt').sort({ updatedAt: -1 }).lean(),
            Order.find({ orderType: 'membership' }).sort({ createdAt: -1 }).lean(), plans.listAll(),
            Business.find({}).select('userId doingBusiness registrationType businessCommencementYear').lean()
        ]);
        const byMember = new Map();
        for (const o of orders) { const id = String(o.memberId); if (!byMember.has(id)) byMember.set(id, []); byMember.get(id).push(o); }
        const byBusiness = new Map(businesses.map(b => [String(b.userId), b]));
        const rows = members.map(m => currentMemberRow(m, appFor(m, apps), byMember.get(String(m._id)) || [], byBusiness.get(String(m._id)), activePlans));
        const lookup = new Map(members.map(m => [String(m._id), m]));
        const now = Date.now();
        return {
            rows, payments: orders.map(o => paymentRow(o, lookup.get(String(o.memberId)))),
            plans: activePlans.filter(p => p.active !== false && p.audience !== 'platinum').map(p => ({ id: p.key, name: p.name, price: p.price, membershipType: p.membershipType })),
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
        const [business, catalogue] = await Promise.all([Business.findOne({ userId: m._id }).lean(), plans.listAll()]);
        const confirmation = planRules.officeOptions(m, business, orders.find(o => o.status === 'paid'), catalogue);
        return { member: currentMemberRow(m, appFor(m, apps), orders, business, catalogue), payments: orders.map(o => paymentRow(o, m)), confirmation };
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
        const selected = detail.confirmation.plans.find(p => p.key === body.planId);
        if (!selected) throw ApiError.badRequest('Choose the eligible plan for this member’s category and business commencement year.');
        const commencementYear = String(body.commencementYear ?? detail.confirmation.commencementYear).trim();
        if (selected.audience === 'business' && !planRules.matchesYear(selected, commencementYear)) {
            throw ApiError.badRequest('Choose a business commencement year from the selected plan’s year range.');
        }
        if (detail.member.requiresManualAdmission && body.manualAdmission !== true) {
            throw ApiError.badRequest('The member must submit their application, or the Super Admin must explicitly confirm office admission after checking their details.');
        }
        let member = await Member.findById(id).select(MEMBER_FIELDS).lean();
        if (!member || member.isActive === false) throw ApiError.badRequest('This account is unavailable.');
        const current = membershipState(member);
        if (current.state === 'active' && !renewalFor(member).canRenew) throw ApiError.conflict('Membership is already active.');
        if (body.membershipNumber != null && typeof body.membershipNumber !== 'string') throw ApiError.badRequest('Enter a valid membership ID.');
        let membershipNumber = await require('../members/memberNumber').prepareMembershipNumber(member, body.membershipNumber || '', require('../members/membershipIdCategory').membershipIdCategory(member, selected));
        if (selected.audience === 'business') {
            await Business.updateOne({ userId: member._id }, { $set: { doingBusiness: true, registrationType: 'business', businessCommencementYear: commencementYear },
                $setOnInsert: { userId: member._id } }, { upsert: true, runValidators: true });
        }
        // Use the same reviewed approval workflow as the application queue.
        if (detail.member.applicationStatus === 'Pending') {
            await require('../applications/application.service').reviewApplication(detail.member.applicationId, 'approve', actor);
            member = await Member.findById(id).select(MEMBER_FIELDS).lean();
            if (!member || member.isActive === false) throw ApiError.badRequest('This account is unavailable.');
            if (member.membershipNumber) membershipNumber = await require('../members/memberNumber').prepareMembershipNumber(member, body.membershipNumber || '');
        }
        const now = new Date();
        const expiry = plan.membershipType === 'lifetime' ? null : require('../members/membershipDates').annualExpiry(renewalBase(member, { now }));
        const orderId = `OFF-${now.getFullYear()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        // Keep the receipt before granting access, so paymentReconcile can find it.
        const receipt = await Order.create({
            orderId, memberId: member._id, email: member.email, planId: plan.id, planName: plan.name, planAudience: plan.audience,
            amount, currency: 'INR', orderType: 'membership', membershipType: plan.membershipType,
            membershipCommencementYear: selected.audience === 'business' ? commencementYear : '',
            provider: 'offline', status: 'paid', paymentMethod: mode, paidAt: now, expiresAt: now,
            applicationId: detail.member.applicationId, gatewayPaymentId: String(body.receiptNumber || '').trim().slice(0, 120) || orderId,
            manualConfirmation: { by: String(actor.userId || actor.id || actor._id || ''), byName: actor.email || 'Super Admin', at: now, note, admission: detail.member.requiresManualAdmission,
                expectedAmount: plan.amount, waivedAmount: Math.max(0, plan.amount - amount), membershipNumber, receiptNumber: String(body.receiptNumber || '').trim().slice(0, 120) }
        });
        let activated;
        try {
            // Optimistic compare prevents simultaneous clicks from granting two periods.
            activated = await Member.findOneAndUpdate({ _id: id, updatedAt: member.updatedAt, isActive: { $ne: false } }, { $set: {
                membershipStatus: 'active', membershipType: plan.membershipType, membershipExpiresAt: expiry, membershipNumber,
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
        return require('../members/memberDeletion.service').remove(id, actor);
    }

    async removeArchivedPayment(id, body, actor) {
        return require('./archivedRecordDeletion.service').deleteMembershipPayment(id, body, actor);
    }
}
module.exports = new MembershipDashboardService();
module.exports.memberRow = memberRow;
