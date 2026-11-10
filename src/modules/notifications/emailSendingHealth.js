// An SMTP login can succeed while SES refuses every message because sending is
// paused. Preserve that provider evidence until a later real send is accepted.
const SENDING_RESTRICTED = /sending(?:\s+is)?\s+(?:paused|disabled)|account.{0,40}(?:paused|suspended)|account.{0,40}under review/i;
const accountFingerprint = account => require('node:crypto').createHash('sha256')
    .update(JSON.stringify([account.host, account.port, account.secure, account.user, account.password])).digest('hex');

async function emailSendingHealth(category) {
    const NotificationLog = require('./notificationLog.model');
    const { accountFor } = require('./emailAccounts');
    const account = accountFor(category);
    const other = accountFor(category === 'events' ? 'membership' : 'events');
    const shared = account.isConfigured && other.isConfigured
        && account.transport === 'shared' && other.transport === 'shared'
        && accountFingerprint(account) === accountFingerprint(other);
    const categoryFilter = { $or: [
        { 'data.emailCategory': category },
        { 'data.emailCategory': { $exists: false }, event: category === 'events' ? /^EVENT_/ : { $not: /^EVENT_/ } },
    ] };
    const base = { channel: 'email', mock: { $ne: true }, $and: [categoryFilter] };
    const restriction = await NotificationLog.findOne({
        ...base,
        $and: [...base.$and,
            { $or: [{ status: 'failed' }, { deliveryStatus: 'failed' }] },
            { $or: ['failureReason', 'lastError', 'failureCode'].map(field => ({ [field]: SENDING_RESTRICTED })) },
        ],
    }).sort({ createdAt: -1, _id: -1 }).select('createdAt').maxTimeMS(5000).lean();
    if (!restriction) return { sendingBlocked: false };
    const accepted = await NotificationLog.findOne({
        ...base,
        // Cross-category recovery needs evidence tied to the exact current
        // credentials. Legacy rows cannot prove this after credential rotation.
        ...(shared ? { $and: [{ $or: [categoryFilter,
            { 'data.smtpAccountFingerprint': accountFingerprint(account) },
        ] }] } : {}),
        createdAt: { $gt: restriction.createdAt }, status: 'sent',
        deliveryStatus: { $in: ['accepted', 'delivered', 'read'] },
    }).sort({ createdAt: -1, _id: -1 }).select('createdAt').maxTimeMS(5000).lean();
    if (accepted) return { sendingBlocked: false };
    return {
        sendingBlocked: true,
        lastRejectedAt: restriction.createdAt,
        error: 'The email provider reported that sending is paused or disabled. SMTP login alone does not confirm recovery. Review this sender’s SES account in its configured AWS region, resolve the restriction, then confirm a controlled test is accepted.',
    };
}

module.exports = { emailSendingHealth, SENDING_RESTRICTED, accountFingerprint };
