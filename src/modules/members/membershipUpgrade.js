const Member = require('./memberdetails.model');
const Business = require('./businessinfo.model');
const Order = require('../payment/paymentorder.model');
const plans = require('./membershipplan.service');
const { membershipState } = require('./membershipState');
const ApiError = require('../../core/utils/ApiError');

async function eligibility(memberId) {
    const member = await Member.findById(memberId).lean();
    if (!member || member.isActive === false) throw ApiError.forbidden('This member account is unavailable.');
    const state = membershipState(member);
    if (!['active', 'expired'].includes(state.state)) throw ApiError.badRequest('Complete your first membership payment before upgrading.');
    if (state.lifetime || member.membershipTier === 'platinum') throw ApiError.badRequest('Your lifetime membership already includes paid access. Contact the office to change your profile.');
    const [business, current, active] = await Promise.all([
        Business.findOne({ userId: member._id }).lean(),
        Order.findOne({ memberId: member._id, orderType: 'membership', status: 'paid' }).sort({ paidAt: -1, createdAt: -1 }).lean(),
        plans.listActive()
    ]);
    const declared = String(member.memberType || member.registrationType || '').toLowerCase();
    const kind = business ? business.doingBusiness === true ? 'business' : business.registrationType === 'student' ? 'student' : 'aspirant'
        : ['student', 'aspirant', 'business'].includes(declared) ? declared : 'aspirant';
    const year = business?.businessCommencementYear || business?.commencementYear || '';
    const choices = active.filter(p => p.audience !== 'platinum' && p.key !== current?.planId);
    return { currentPlan: current?.planName || '', currentPlanId: current?.planId || '', kind,
        commencementYear: year, plans: choices, canUpgrade: !!choices.length,
        reason: choices.length ? 'Choose your new plan. The full plan fee is charged; your category changes after verified payment. Annual upgrades are valid for one year from payment.' : 'No other active plans are available. Please contact ACTIV Membership.' };
}
async function validate(memberId, planId, commencementYear) {
    const result = await eligibility(memberId);
    const selected = result.plans.find(p => p.key === planId);
    if (!selected) throw ApiError.badRequest('Choose a different active plan. Platinum membership is confirmed by the office.');
    const kind = selected.audience;
    if (!['student', 'aspirant', 'business'].includes(kind)) throw ApiError.badRequest('This plan is unavailable for an online upgrade.');
    let year = '';
    if (kind === 'business') {
        year = String(commencementYear ?? result.commencementYear).trim();
        const numeric = Number(year), now = new Date().getFullYear();
        if (!/^\d{4}$/.test(year) || !Number.isInteger(numeric) || numeric < 1800 || numeric > now) throw ApiError.badRequest('Enter a valid business commencement year.');
        const years = now - numeric;
        if (years < Number(selected.minYears || 0) || (selected.maxYears != null && years >= Number(selected.maxYears))) throw ApiError.badRequest('The commencement year does not match this plan. Select the plan for your business age.');
    }
    return { purchasePurpose: 'upgrade', upgradeKind: kind, upgradeCommencementYear: year, previousPlanId: result.currentPlanId };
}
// Called only by verified settlement. Keep company details and login credentials;
// write just the classification snapshot stored on the server-priced order.
async function applyPaidProfile(order) {
    if (order.purchasePurpose !== 'upgrade') return;
    if (!['student', 'aspirant', 'business'].includes(order.upgradeKind)) throw ApiError.badRequest('The upgrade classification is unavailable.');
    const set = { doingBusiness: order.upgradeKind === 'business', registrationType: order.upgradeKind };
    if (order.upgradeKind === 'business') set.businessCommencementYear = order.upgradeCommencementYear;
    await Business.updateOne({ userId: order.memberId }, { $set: set, $setOnInsert: { userId: order.memberId } }, { upsert: true, runValidators: true });
}
module.exports = { eligibility, validate, applyPaidProfile };
