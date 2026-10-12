const Member = require('./memberdetails.model');
const Business = require('./businessinfo.model');
const Order = require('../payment/paymentorder.model');
const plans = require('./membershipplan.service');
const rules = require('./membershipPlanRules');
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
        plans.listAll()
    ]);
    const progress = rules.progression(member, business, current, active);
    const enteringBusiness = progress.kind === 'student' || progress.kind === 'aspirant';
    const offer = enteringBusiness ? rules.entryPlan(active) : progress.promoted ? progress.effective : null;
    const canPurchase = enteringBusiness && !!offer;
    const reason = enteringBusiness
        ? offer ? `Start your business membership with ${offer.name}. Choose the year your business started. Your category changes after verified payment.` : 'No entry business plan is available. Please contact ACTIV Membership.'
        : progress.promoted ? `${state.state === 'active' ? 'Congratulations! Your membership has advanced' : 'Your renewal plan has advanced'} to ${progress.effective.name}. Your current paid validity is unchanged. The new fee is due only at renewal.`
        : progress.next ? `Your current plan is ${progress.effective?.name || current?.planName || 'Business'}. It advances automatically to ${progress.next.name}${progress.nextEligibleYear ? ` in ${progress.nextEligibleYear}` : ' when your business reaches its configured year range'}. The new fee applies at renewal.`
        : 'You already hold the highest available business plan. Continue with your current plan at renewal.';
    return { currentPlan: progress.effective?.name || current?.planName || '', currentPlanId: progress.effective?.key || current?.planId || '',
        kind: progress.kind, commencementYear: offer && rules.matchesYear(offer, progress.commencementYear) ? progress.commencementYear : '',
        plans: offer ? [rules.withYears(offer)] : [], canUpgrade: canPurchase, canPurchase,
        automaticallyAdvanced: progress.promoted, nextEligibleYear: progress.nextEligibleYear, reason };
}
async function validate(memberId, planId, commencementYear) {
    const result = await eligibility(memberId);
    if (!result.canPurchase) throw ApiError.badRequest('Business plans advance automatically. Pay the new fee only when renewing your membership.');
    const selected = result.plans.find(p => p.key === planId);
    if (!selected) throw ApiError.badRequest('Choose the eligible entry business plan. Other tiers follow your business commencement year.');
    const year = String(commencementYear ?? result.commencementYear).trim();
    if (!rules.matchesYear(selected, year)) throw ApiError.badRequest('Choose a business commencement year from the selected plan’s year range.');
    return { purchasePurpose: 'upgrade', upgradeKind: 'business', upgradeCommencementYear: year,
        membershipCommencementYear: year, previousPlanId: result.currentPlanId };
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
