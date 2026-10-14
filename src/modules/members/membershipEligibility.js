const Member = require('./memberdetails.model');
const Business = require('./businessinfo.model');
const Order = require('../payment/paymentorder.model');
const catalogue = require('./membershipplan.service');
const rules = require('./membershipPlanRules');
const ApiError = require('../../core/utils/ApiError');

async function load(memberOrId, paidOrder) {
    const member = memberOrId?._id ? memberOrId : await Member.findById(memberOrId).lean();
    if (!member) throw ApiError.notFound('Member not found.');
    const [business, paid, plans] = await Promise.all([
        Business.findOne({ userId: member._id }).lean(),
        paidOrder === undefined ? Order.findOne({ memberId: member._id, orderType: 'membership', status: 'paid' }).sort({ paidAt: -1, createdAt: -1 }).lean() : paidOrder,
        catalogue.listAll()
    ]);
    return { member, business, paid, plans };
}
async function forMember(memberOrId) {
    const data = await load(memberOrId);
    const info = rules.officeOptions(data.member, data.business, data.paid, data.plans);
    const progress = rules.progression(data.member, data.business, data.paid, data.plans);
    // A duration edit never moves an existing paid business member backwards.
    if (info.kind === 'business' && progress.held && info.plans[0]
        && Number(info.plans[0].minYears || 0) < Number(progress.held.minYears || 0)) {
        info.plans = data.plans.filter(p => p.active !== false && p.key === progress.held.key).map(p => rules.withYears(p));
    }
    const needsYear = info.kind === 'business' && !rules.validYear(info.commencementYear);
    const offered = needsYear ? [] : info.plans;
    return { ...info, plans: offered, matched: offered[0] || null, years: rules.validYear(info.commencementYear) ? rules.currentYear() - Number(info.commencementYear) : null,
        reason: needsYear ? 'no-year' : info.kind === 'business' ? offered.length ? 'band' : 'no-band' : info.kind, showAllPlans: false };
}
async function validatePurchase(memberOrId, planId) {
    const offer = await forMember(memberOrId);
    if (!offer.plans.some(p => p.key === planId)) throw ApiError.badRequest(offer.reason === 'no-year'
        ? 'Add your business commencement year before paying for membership.'
        : 'This plan does not match your membership category and business commencement year. Refresh your eligible plan.');
    return { membershipCommencementYear: offer.kind === 'business' ? offer.commencementYear : '' };
}
async function currentMembership(member, paidOrder) {
    if (!paidOrder || member.membershipTier === 'platinum' || member.membershipType === 'lifetime') return null;
    const data = await load(member, paidOrder);
    const progress = rules.progression(member, data.business, paidOrder, data.plans);
    if (!progress.effective) return null;
    const active = require('./membershipState').membershipState(member).state === 'active';
    if (active && process.env.MEMBERSHIP_PLAN_NOTICES !== 'false') {
        require('../notifications/membershipProgression.service').observe(member, progress).catch(error =>
            require('../../config/logger').warn('Membership plan notification failed', { error: error.message }));
    }
    return { planId: progress.effective.key, planName: progress.effective.name, kind: progress.kind,
        automaticallyAdvanced: progress.promoted, commencementYear: progress.commencementYear,
        nextPlanName: progress.next?.name || '', nextEligibleYear: progress.nextEligibleYear,
        message: progress.promoted ? `${active ? 'Congratulations! Your membership has advanced' : 'Your renewal plan has advanced'} to ${progress.effective.name}. Your paid validity is unchanged. The new fee applies at renewal.` : '' };
}
module.exports = { load, forMember, validatePurchase, currentMembership };
