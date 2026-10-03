const config = require('../../config');
const { accountFor } = require('./emailAccounts');
const base = () => String(config.frontendUrl || '').replace(/\/+$/, '');

const publicReply = command => {
    switch (command) {
        case 'LOGIN': return `Sign in to your ACTIV account here:\n${base()}/login\n\nUse your registered email and password, or Google when available. If you do not have an account, register here:\n${base()}/register\n\nTell me the error message if you cannot sign in. Please do not share passwords or OTPs here.`;
        case 'RESET': return `Reset your password using your registered email:\n${base()}/forgot-password\n\nOpen the reset link sent to that email, set your new password and sign in. Check your spam folder if the email is missing. If you no longer have access to that email, contact ${accountFor('membership').supportAddress}.`;
        case 'ABOUT': return `ACTIV is the Adidravidar Confederation of Trade & Industrial Vision. Learn about the association here:\n${base()}/about\n\nYou can ask me about joining, your application, membership payments or upcoming events in normal sentences.`;
        case 'THANKS': return 'You’re welcome! Send me a message whenever you need help with your ACTIV account, membership or events.';
        case 'ACK': return 'Okay. If you need anything else, tell me what you would like to check or complete.';
        case 'SOCIAL': return 'Hello! I’m here to help with your ACTIV account, membership and events. How can I help you?';
        default: return null;
    }
};

const accountReply = async (command, identity) => {
    const membership = require('./membershipBot');
    if (command === 'FORMS') {
        const next = await membership.reply(identity, 'STATUS');
        if (identity.application) return next;
        return next + `\n\nComplete these sections in order after signing in:\n1. Personal details: ${base()}/member/forms/personal\n2. Business, student or aspirant details: ${base()}/member/forms/business\n3. Declaration and submission: ${base()}/member/forms/declaration\n\nSaving a section does not submit the application. Submit it from the declaration page for review.`;
    }
    if (command === 'PROFILE') return `Sign in to review or update your account details:\n${base()}/member/profile\n\nFor corrections to a submitted application, check its status first:\n${base()}/member/application-status\n\nIf a field cannot be edited, contact ${accountFor('membership').supportAddress} from your registered email.`;
    if (command === 'CARD') return `Your membership dashboard shows the membership and payment documents available for your account:\n${base()}/payment/member-dashboard\n\n` + await membership.reply(identity, 'STATUS');
    if (command === 'PAYMENT_ISSUE') return `If money was deducted or a payment failed, check your dashboard before paying again:\n${base()}/payment/member-dashboard\n\nFor help, email the payment reference, amount and date to ${accountFor('membership').supportAddress}. The office must verify direct transfers; sending a UTR here does not mark a payment as successful.\n\n` + await membership.reply(identity, 'STATUS');
    return null;
};

const plansReply = async (command) => {
    try {
        const plans = await require('../members/membershipplan.service').listActive();
        const offered = plans.filter(plan => plan.audience !== 'platinum');
        if (!offered.length) throw new Error('No published plans');
        const lines = offered.map(plan => {
            const price = Number(plan.price);
            const fee = Number.isFinite(price) ? `Rs ${price.toLocaleString('en-IN')}` : 'See website for price';
            const benefits = command === 'BENEFITS' && Array.isArray(plan.features) && plan.features.length
                ? `\n${plan.features.map(feature => `• ${feature}`).join('\n')}` : '';
            return `*${plan.name}*: ${fee}${plan.membershipType === 'annual' ? ' / year' : ''}${plan.experience ? ` (${plan.experience})` : ''}${benefits}`;
        });
        return `*Current ACTIV membership ${command === 'BENEFITS' ? 'plans and benefits' : 'fees'}*\n\n${lines.join('\n\n')}\n\nYour eligible plan depends on your business/student/aspirant details. Application approval is required before payment.\n${base()}/payment/membership-plans`;
    } catch {
        return `See the current membership plans and benefits here:\n${base()}/payment/membership-plans\n\nComplete your application first. Payment is available after approval; your details determine the eligible plan.`;
    }
};

const previousCommand = async phone => {
    try {
        const normalized = require('./botbee.service').normalizePhoneNumber(phone);
        if (!normalized) return null;
        const Log = require('./notificationLog.model');
        const row = await Log.findOne({ event: 'BOT_REPLY', channel: 'whatsapp', recipient: normalized, status: 'sent',
            mock: { $ne: true }, 'data.command': { $in: [...require('./chatIntent').CONTEXT_COMMANDS] },
            createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) }
        }).sort({ createdAt: -1 }).select('data.command').lean();
        return row && row.data && row.data.command || null;
    } catch { return null; }
};

module.exports = { publicReply, accountReply, plansReply, previousCommand };
