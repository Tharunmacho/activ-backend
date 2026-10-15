const { membershipState } = require('../members/membershipState');

const AUDIENCES = ['all', 'paid', 'unpaid', 'student', 'lifetime'];
const STUDENT_UPGRADE_MESSAGE = 'Dear member, your Student membership includes events and learning opportunities. Please upgrade your membership to connect and chat with business members.';
const normal = value => String(value || '').trim().toLowerCase();

function memberAccess(member = {}, paidOrder) {
    const state = membershipState(member);
    // A profile edit must not change the benefits of the plan that was paid for.
    const kind = normal(paidOrder?.upgradeKind || paidOrder?.planAudience || member.paidAudience
        || member.memberType || member.registrationType);
    const isPaid = state.state === 'active' && member.isActive !== false && !member.deletedAt;
    const isLifetime = isPaid && state.lifetime;
    const isStudent = kind === 'student' && !isLifetime;
    return { memberType: kind, isPaid, isLifetime, isStudent, canNetwork: isPaid && !isStudent };
}

async function paidAudience(member) {
    if (!member?._id || !['active', 'completed', 'expired'].includes(normal(member.membershipStatus))) return '';
    const order = await require('../payment/paymentorder.model').findOne({
        memberId: member._id, orderType: 'membership', status: 'paid',
    }).sort({ paidAt: -1, createdAt: -1 }).select('upgradeKind planAudience planId').lean();
    if (order?.upgradeKind || order?.planAudience) return order.upgradeKind || order.planAudience;
    if (order?.planId) {
        const plan = await require('../members/membershipplan.model').findOne({ key: order.planId }).select('audience').lean();
        if (plan?.audience) return plan.audience;
    }
    return '';
}

function allowedAudiences(context = {}) {
    return ['all', context.isPaid ? 'paid' : 'unpaid',
        ...(context.isStudent ? ['student'] : []), ...(context.isLifetime ? ['lifetime'] : [])];
}
function matchesAudience(audience, context = {}) {
    return !!context.isAdmin || allowedAudiences(context).includes(audience || 'all');
}
module.exports = { AUDIENCES, STUDENT_UPGRADE_MESSAGE, memberAccess, paidAudience, allowedAudiences, matchesAudience };
