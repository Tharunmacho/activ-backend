const { membershipState } = require('../members/membershipState');

const AUDIENCES = ['all', 'paid', 'unpaid', 'student', 'lifetime', 'paid_non_student', 'business', 'aspirant', 'plans'];
const STUDENT_UPGRADE_MESSAGE = 'Dear member, your Student membership includes events and learning opportunities. Please upgrade your membership to connect and chat with business members.';
const normal = value => String(value || '').trim().toLowerCase();

function memberAccess(member = {}, paidOrder) {
    const state = membershipState(member);
    // A profile edit must not change the benefits of the plan that was paid for.
    const purchasedAudience = normal(paidOrder?.upgradeKind || paidOrder?.planAudience || member.paidAudience);
    const kind = normal(purchasedAudience
        || member.memberType || member.registrationType);
    const isPaid = state.state === 'active' && member.isActive !== false && !member.deletedAt;
    const isLifetime = isPaid && state.lifetime;
    const isStudent = kind === 'student' && !isLifetime;
    // A lifetime grant supersedes an earlier annual receipt. Profile fields
    // never select a paid plan: annual plans require their payment receipt.
    const paidPlanKey = isPaid ? (isLifetime ? 'platinum' : normal(paidOrder?.planId || member.paidPlanKey)) : '';
    return { memberType: kind, purchasedAudience: isLifetime ? 'platinum' : purchasedAudience,
        paidPlanKey, isPaid, isLifetime, isStudent, canNetwork: isPaid && !isStudent };
}

async function paidMembership(member) {
    if (!member?._id || !['active', 'completed', 'expired'].includes(normal(member.membershipStatus))) return {};
    const order = await require('../payment/paymentorder.model').findOne({
        memberId: member._id, orderType: 'membership', status: 'paid',
    }).sort({ paidAt: -1, createdAt: -1 }).select('upgradeKind planAudience planId').lean();
    const result = { paidPlanKey: normal(order?.planId), paidAudience: normal(order?.upgradeKind || order?.planAudience) };
    if (result.paidAudience) return result;
    if (order?.planId) {
        const plan = await require('../members/membershipplan.model').findOne({ key: order.planId }).select('audience').lean();
        if (plan?.audience) result.paidAudience = plan.audience;
    }
    return result;
}
async function paidAudience(member) { return (await paidMembership(member)).paidAudience || ''; }

function allowedAudiences(context = {}) {
    return ['all', context.isPaid ? 'paid' : 'unpaid',
        ...(context.isPaid && context.isStudent ? ['student'] : []), ...(context.isLifetime ? ['lifetime'] : []),
        ...(context.isPaid && !context.isStudent ? ['paid_non_student'] : []),
        ...(context.isPaid && !context.isLifetime && ['business', 'aspirant'].includes(context.purchasedAudience) ? [context.purchasedAudience] : [])];
}
function matchesAudience(audience, context = {}, planKeys = []) {
    if (audience === 'plans') return !!context.isAdmin || !!(context.isPaid && context.paidPlanKey && Array.isArray(planKeys) && planKeys.includes(context.paidPlanKey));
    return !!context.isAdmin || allowedAudiences(context).includes(audience || 'all');
}
function announcementAudienceClause(context = {}) {
    if (context.isAdmin) return {};
    const alternatives = [{ audience: { $in: allowedAudiences(context) } }, { audience: { $exists: false } }];
    if (context.isPaid && context.paidPlanKey) alternatives.push({ audience: 'plans', planKeys: context.paidPlanKey });
    return { $or: alternatives };
}
module.exports = { AUDIENCES, STUDENT_UPGRADE_MESSAGE, memberAccess, paidMembership, paidAudience, allowedAudiences, matchesAudience, announcementAudienceClause };
