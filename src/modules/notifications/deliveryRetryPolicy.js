const Log = require('./notificationLog.model');
const crypto = require('node:crypto');
const Notification = require('./notification.model');
const { VisitorDelivery, VisitorDevice, PublicNotice } = require('./visitorPush.models');
const idValid = value => /^[a-f\d]{24}$/i.test(String(value || ''));
const version = row => row?.updatedAt ? new Date(row.updatedAt).toISOString() : '';
const past = (value, age) => !value || !Number.isFinite(+new Date(value)) || +new Date(value) < Date.now() - age;
const failed = row => row?.deliveryStatus === 'failed' || (!row?.deliveryStatus && row?.status === 'failed');
const uncertain = value => /outcome.*(?:unknown|unconfirmed)|timed?\s*out|timeout|ECONNRESET|EPIPE|ESOCKET|socket (?:hang up|closed)|connection.*(?:closed|lost|terminated)/i.test(String(value || ''));

function basicLogReason(row) {
    if (!row || !['email', 'whatsapp'].includes(row.channel)) return 'This delivery has no external failed message to retry.';
    if (row.resentAs || row.mock || !failed(row) || row.readAt || row.deliveredAt) return 'This delivery is already accepted, delivered, read, replaced, or has no confirmed failure.';
    if (row.retryClaim?.token) return 'A retry is running or its outcome needs review.';
    if (row.data?.outcomeUnknown || ['partial', 'unknown', 'accepted'].includes(row.data?.smtpRecipientStatus)) return 'Provider acceptance is uncertain or partial; review provider history before sending again.';
    if (row.data?.autoRetryDisabled) return row.data.skipReason || 'Retries are disabled for this delivery.';
    if (['PASSWORD_RESET', 'ADMIN_WELCOME'].includes(row.event)) return 'This message contains an expired or one-time credential. Create a fresh credential through the account workflow.';
    // This refusal names the stored destination, which a retry deliberately
    // preserves. Editing a profile cannot safely retarget an old log entry.
    if (row.channel === 'whatsapp' && /^Not sent: this is ACTIV's own WhatsApp number\b/.test(String(row.failureReason || row.lastError || ''))) {
        return "This message is addressed to ACTIV's own WhatsApp number. Correct the person's saved number, then create a new alert. Resending this entry would use the old number.";
    }
    return '';
}

async function logReason(row) {
    const basic = basicLogReason(row);
    if (basic) return basic;
    if (past(row.createdAt, 30 * 86400000)) return 'This delivery is older than the 30-day retry window.';
    if (uncertain(row.failureReason || row.lastError)) return 'Provider acceptance could not be confirmed; review provider history before sending again.';
    if (row.event === 'ASSOCIATION_UPDATE') {
        if (!idValid(row.data?.notificationId)) return 'The original update delivery could not be verified.';
        const notice = await Notification.findById(row.data.notificationId).lean();
        const queue = notice?.updateDelivery?.[row.channel];
        if (!queue || !['failed', 'sent'].includes(queue.status) || String(queue.logId) !== String(row._id)) return 'This update is already queued, retried, or unavailable.';
        return (await require('./associationUpdateDelivery').current(notice, row.channel)).reason || '';
    }
    const stateReason = await require('./retryEligibility').reasonToSkip(row, { throwOnReadError: true });
    if (stateReason) return stateReason;
    const data = row.data || {}, context = data.lifecycleData || data;
    if (row.user) {
        const Member = require('../members/memberdetails.model');
        let member = await Member.findById(row.user).lean();
        // Application notices retain their original login ID. The state guard
        // above verifies its explicit profile link and application ownership;
        // resolve that same link here before treating the recipient as missing.
        if (!member && ['APPLICATION_SUBMITTED', 'APPLICATION_ENDORSED', 'APPLICATION_APPROVED', 'CORRECTION_REQUESTED'].includes(row.event)) {
            member = await Member.findOne({ userId: row.user }).lean();
        }
        if (member && (member.isActive === false || member.deletedAt)) return 'The recipient account is no longer active.';
        if (!member) {
            const admin = await require('../admin/admin.repository').findById(String(row.user));
            if (!admin?.active) return 'The recipient account no longer exists or is inactive.';
        }
    }
    const legacy = ['EVENT_REGISTERED', 'EVENT_REMINDER'].includes(row.event)
        || (row.event === 'EVENT_BOOKING_WAITLISTED' && context.registrationId);
    if (legacy) return require('../events/eventChanges.service').reasonToSkipRegistrationNotice(row);
    if (['EVENT_UPDATED', 'EVENT_CANCELLED'].includes(row.event)) {
        const current = await require('../events/eventChanges.service').reasonToSkipChange(row);
        if (current) return current;
        const eventId = context.eventId || row.eventId;
        const event = idValid(eventId) ? await require('../events/event.model').findById(eventId).lean() : null;
        return require('./contentBroadcast').published('event', event) ? '' : 'The source event is no longer current and published.';
    }
    if (/^EVENT_(BOOKING|PARTICIPANT|DOCUMENT|CHANNEL)_/.test(row.event)) {
        const service = require('../events/eventbooking.service');
        const reference = row.bookingRef || data.bookingRef || context.bookingRef;
        if (!reference) return 'The original booking reference was not retained.';
        const booking = await service.bookingForLogRow({ ...row, bookingRef: reference });
        if (!booking || booking.deletedAt || booking.eventArchived) return 'The original booking no longer exists or has been archived.';
        if ((row.eventId && String(row.eventId) !== String(booking.eventId))
            || (row.user && String(row.user) !== String(booking.userId))) return 'The original event or booking owner no longer matches.';
        const event = await require('../events/event.model').findById(booking.eventId).lean();
        if (!require('./contentBroadcast').published('event', event)) return 'The event is expired, archived, unpublished, or unavailable.';
        const kind = /CANCELLED$/.test(row.event) ? 'CANCELLED' : /WAITLISTED$/.test(row.event) ? 'WAITLISTED' : 'CONFIRMED';
        const removed = row.event === 'EVENT_PARTICIPANT_CANCELLED' && context.nominationChange?.kind === 'removed';
        const recipients = /^EVENT_BOOKING_/.test(row.event) ? [booking.bookedBy]
            : removed ? [context.nominationChange.participant]
                : /^EVENT_PARTICIPANT_/.test(row.event) ? booking.participants || [] : [booking.bookedBy, ...(booking.participants || [])];
        const normalize = value => row.channel === 'email' ? String(value || '').trim().toLowerCase() : String(value || '').replace(/\D/g, '').slice(-10);
        if (!recipients.some(person => person && normalize(row.channel === 'email' ? person.email : person.phone) === normalize(row.recipient))) return 'The original recipient is no longer on this booking.';
        const paid = ['paid', 'not_required'].includes(booking.payment?.status);
        if (!(kind === 'CANCELLED' ? booking.status === 'cancelled' || (removed && booking.status === 'active' && paid)
            : kind === 'WAITLISTED' ? booking.status === 'waitlist' : booking.status === 'active' && paid)) return 'The booking no longer supports this message.';
        return '';
    }
    if (row.event === 'DONATION_RECEIPT') {
        if (!idValid(data.donationId)) return 'The original donation could not be verified.';
        const donation = await require('../donations/donation.model').findById(data.donationId).lean();
        return donation?.status === 'paid' && donation.donorSnapshot?.email?.toLowerCase() === row.recipient?.toLowerCase()
            ? '' : 'The original paid donation or recipient no longer matches.';
    }
    if (row.event === 'DONATION_STATEMENT') return 'Generate a fresh donor statement from the donation workflow.';
    if (data.sourceId || data.broadcastKey) return 'The source of this message cannot be verified for a retry.';
    if (row.channel === 'email' && !data.emailHtml && !data.bodyHtml) return 'The original email content was not retained.';
    if (row.channel === 'whatsapp' && !row.templateId && row.event !== 'BOT_REPLY') return 'The original approved WhatsApp template was not retained.';
    return '';
}

async function resolve(id) {
    let match = /^log:([a-f\d]{24})$/i.exec(String(id));
    if (match) {
        const log = await Log.findById(match[1]).lean();
        return { id, kind: 'log', row: log, version: version(log), channel: log?.channel };
    }
    match = /^([a-f\d]{24}):(email|whatsapp|push|in_app)$/i.exec(String(id));
    if (match) {
        const row = await Notification.findById(match[1]).lean();
        const channel = match[2].toLowerCase();
        const log = ['email', 'whatsapp'].includes(channel) && row?.updateDelivery?.[channel]?.logId
            ? await Log.findById(row.updateDelivery[channel].logId).lean() : null;
        // Retrying email must not invalidate a separately reviewed WhatsApp
        // attempt on the same notice. Bind the selected channel and source only.
        const channelVersion = log ? crypto.createHash('sha256').update(JSON.stringify({
            user: row.user, data: row.data, queue: row.updateDelivery[channel], logVersion: version(log),
        })).digest('hex') : version(row);
        return { id, kind: channel === 'push' ? 'push' : channel === 'in_app' ? 'in_app' : 'log', row: log || row,
            notice: row, channel, version: channelVersion, missingLog: ['email', 'whatsapp'].includes(channel)
                && (!log || log.event !== 'ASSOCIATION_UPDATE' || log.channel !== channel || String(log.data?.notificationId) !== String(row?._id)) };
    }
    match = /^visitor:([a-f\d]{24}):(push|in_app)$/i.exec(String(id));
    if (match) {
        const row = await VisitorDelivery.findById(match[1]).lean();
        return { id, kind: match[2] === 'push' ? 'visitor' : 'in_app', row, channel: match[2], version: version(row) };
    }
    return { id, kind: 'invalid', row: null, version: '' };
}

// These are definite provider refusals. Unknown/network outcomes can include
// accepted tokens, so the report never requeues those blind.
const PUSH_REFUSALS = new Set(['messaging/quota-exceeded', 'messaging/message-rate-exceeded',
    'messaging/invalid-argument', 'messaging/invalid-registration-token', 'messaging/registration-token-not-registered',
    'messaging/authentication-error', 'messaging/mismatched-credential', 'messaging/third-party-auth-error']);
async function reason(record) {
    const row = record.row;
    if (!row) return 'This delivery no longer exists.';
    if (record.kind === 'in_app') return 'In-app notifications already exist and are not sent again.';
    if (record.kind === 'log') return record.missingLog ? 'The original failed delivery log is unavailable.' : logReason(row);
    if (!['push', 'visitor'].includes(record.kind)) return 'This report row cannot be retried.';
    const queue = record.kind === 'push' ? row.push : row;
    if (queue?.status !== 'failed' || queue.openedAt || queue.sentAt || queue.sentTokens?.length) return 'This alert is accepted, partially accepted, read, queued, or has no confirmed failure.';
    if (!PUSH_REFUSALS.has(queue.lastError)) return 'Push provider acceptance could not be confirmed; this outcome needs review.';
    if (past(row.createdAt, 86400000)) return 'This push delivery has expired.';
    if (record.kind === 'push') {
        if (!await require('./push.service').stillVisible(row)) return 'This notification is no longer applicable or its source has expired.';
        const found = await require('./pushDevice.model').exists({ user: row.user, enabled: true, lastSeenAt: { $gte: new Date(Date.now() - 90 * 86400000) } });
        return found ? '' : 'This recipient has no enabled push device.';
    }
    const [notice, device] = await Promise.all([PublicNotice.findById(row.notice).lean(), VisitorDevice.findById(row.device).select('+token').lean()]);
    if (!device?.enabled || !device.token || past(device.lastSeenAt, 90 * 86400000)) return 'This visitor has disabled notifications or has no active device.';
    if (await require('./pushDevice.model').exists({ token: device.token })) return 'This visitor device now belongs to a signed-in account.';
    return !past(notice?.createdAt, 86400000) && await require('./visitorPush.service').pushSource(notice)
        ? '' : 'This public notification is expired, unpublished, or has been replaced.';
}

module.exports = { basicLogReason, logReason, resolve, reason, failed, uncertain, version };
