const crypto = require('crypto');

// The code records the membership category when the ID is issued. Renewals and
// automatic plan progression keep the member's identity; an admin can correct it.
function membershipIdCategory(member = {}, plan = {}) {
    if (member.membershipType === 'lifetime' || member.membershipTier === 'platinum' || plan.membershipType === 'lifetime') return 'LIF';
    const key = String(plan.key || plan.planId || plan.id || '').toLowerCase();
    const named = { basic: 'BEG', beginner: 'BEG', begginer: 'BEG', intermediate: 'INT', ideal: 'IDL', student: 'STU', aspirant: 'ASP', lifetime: 'LIF', platinum: 'LIF' };
    if (named[key]) return named[key];
    const kind = plan.audience || plan.planAudience || member.memberType || member.registrationType;
    if (kind === 'student') return 'STU';
    if (kind === 'aspirant') return 'ASP';
    // Custom business plans have stable codes independent of editable names/bands.
    if (key) return 'B' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 6).toUpperCase();
    return kind === 'business' ? 'BUS' : 'MEM';
}

async function resolveMembershipIdCategory(member) {
    if (member.membershipTier === 'platinum' || member.membershipType === 'lifetime') return 'LIF';
    const paid = await require('../payment/paymentorder.model').findOne({ memberId: member._id, orderType: 'membership', status: 'paid' })
        .sort({ paidAt: -1, createdAt: -1 }).select('planId planAudience membershipType').lean();
    return membershipIdCategory(member, paid || {});
}
module.exports = { membershipIdCategory, resolveMembershipIdCategory };
