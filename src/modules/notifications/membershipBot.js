const config = require('../../config');
const { normalizeStatus } = require('../common/applicationStatus');
const { membershipState, renewalFor } = require('../members/membershipState');
const { dateLabel, membershipNumberOf } = require('./membershipContext');
const base = () => String(config.frontendUrl || '').replace(/\/+$/, '');

const upiLink = ({ amount, reference, name }) => {
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return '';
    const params = new URLSearchParams({
        pa: process.env.MEMBERSHIP_UPI_ID || 'mab.037244012240037@axisbank',
        pn: 'ACTIV', am: Number(amount).toFixed(2), cu: 'INR',
        tn: `Membership ${reference} ${name || ''}`.slice(0, 80),
    });
    return `upi://pay?${params.toString()}`;
};

const paymentGuidance = async ({ member, application }, direct = false) => {
    const checkout = `${base()}/payment/membership-plans`;
    let reply = `Open your membership payment page:\n${checkout}`;
    if (!direct) return reply + '\n\nReply UPI if you prefer a direct transfer.';
    const business = await require('../members/businessinfo.model').findOne({ userId: String(member._id) }).lean();
    const kind = !business ? 'aspirant' : business.doingBusiness === false
        ? business.registrationType === 'student' ? 'student' : 'aspirant' : 'business';
    const plans = require('../members/membershipplan.service');
    const resolved = await plans.resolveForMember({
        kind, commencementYear: business ? business.businessCommencementYear || business.commencementYear || '' : '',
    });
    const matched = resolved && resolved.matched;
    const plan = matched ? await plans.getPlanForPayment(matched.key || matched.id) : null;
    if (!plan || !(plan.amount > 0)) return reply + '\n\nChoose your eligible plan there to confirm the amount before paying.';
    const reference = membershipNumberOf(member);
    const uri = upiLink({ amount: plan.amount, reference, name: member.fullName });
    return `*Plan:* ${plan.name}\n*Amount:* Rs ${Number(plan.amount).toLocaleString('en-IN')}\n\n`
        + `*Direct UPI payment:*\n${uri}\n\n`
        + `If the link does not open, use UPI ID: ${process.env.MEMBERSHIP_UPI_ID || 'mab.037244012240037@axisbank'}\n`
        + `Note: Membership ${reference}\n\n`
        + `After paying, email the UTR/reference, payment date, amount and your membership reference to member@activ.org.in. `
        + `The office must verify a direct transfer before activating or renewing membership. Do not pay again while verification is pending.\n\n`
        + `For automatic payment confirmation:\n${checkout}`;
};

const reply = async (identity, command = 'STATUS') => {
    const { member, application } = identity;
    const name = String(member.fullName || '').trim().split(/\s+/)[0] || 'there';
    const outcome = normalizeStatus(application && application.status);
    const state = membershipState(member, { outcome });
    const ref = membershipNumberOf(member);
    if (String(member.membershipStatus).toLowerCase() === 'cancelled') {
        return `Hello ${name}, your membership is cancelled. Please contact member@activ.org.in before making another payment.`;
    }
    if (state.state === 'active' || state.state === 'expired') {
        let planName = member.membershipTier === 'platinum' ? 'Platinum' : '';
        if (!planName && member._id) {
            const order = await require('../payment/paymentorder.model').findOne({ memberId: member._id, orderType: 'membership', status: 'paid' })
                .sort({ paidAt: -1, createdAt: -1 }).lean();
            planName = order && order.planName || '';
        }
        let result = `Hello ${name}, your ACTIV membership is ${state.state.toUpperCase()}.\n\n`
            + `*Membership ID:* ${ref}\n*Type:* ${state.lifetime ? 'Lifetime' : 'Annual'}`
            + (planName ? `\n*Plan:* ${planName}` : '')
            + (state.expiresAt ? `\n*Valid until:* ${dateLabel(state.expiresAt)}` : '');
        if (state.lifetime) return result + `\n\nNo renewal is needed.\n${base()}/payment/member-dashboard`;
        const eligible = renewalFor(member);
        if (eligible.canRenew) {
            result += '\n\nYour renewal is available.\n' + await paymentGuidance(identity, command === 'UPI');
        } else {
            result += `\n\nNo payment is due now.${eligible.opensAt ? ` Renewal opens on ${dateLabel(eligible.opensAt)}.` : ''}`
                + `\n${base()}/payment/member-dashboard`;
        }
        return result + '\n\nReply EVENTS for events or HELP for assistance.';
    }
    if (!application) return `Hello ${name}, your account is registered, but your membership application has not been submitted.\n\n`
        + `Complete your personal details, business/student/aspirant details and declaration, then submit for review:\n${base()}/member/forms/personal`;
    if (outcome === 'Rejected') return `Hello ${name}, your application needs attention.\n\n`
        + (application.rejectionReason ? `Reason: ${application.rejectionReason}\n\n` : '')
        + `Review it here:\n${base()}/member/application-status\n\nReply HELP to contact your regional office before paying.`;
    if (outcome !== 'Approved') return `Hello ${name}, your application is with the administrators for review. No payment is due yet.\n\n`
        + `Track your application:\n${base()}/member/application-status\n\nReply HELP for your regional office.`;
    return `Hello ${name}, your application is approved. Complete your membership payment to activate it.\n\n`
        + await paymentGuidance(identity, command === 'UPI');
};

module.exports = { reply, paymentGuidance, upiLink };
