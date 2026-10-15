const crypto = require('node:crypto');
const Notification = require('./notification.model');
const Log = require('./notificationLog.model');
const Member = require('../members/memberdetails.model');
const Announcement = require('../announcements/announcement.model');
const broadcast = require('./contentBroadcast');
const { memberAccess } = require('../common/memberAudience');
const { preferences, phoneFor } = require('./updatePreferences');
const messages = require('./associationUpdateMessage');
const email = require('./email.service');
const whatsapp = require('./whatsappTemplate');
const channels = ['email', 'whatsapp'];
const AGE_LIMIT = 7 * 86400000;
const LEASE_MS = 5 * 60000;
const errorText = value => String(value || '').slice(0, 500);

// Read current documents without the member-context cache. A membership change,
// opt-out or withdrawn post must take effect before the next provider call.
async function current(row, channel) {
    if (!channels.includes(channel) || row.data?.kind !== 'announcement' || !row.data?.broadcastKey) return { reason: 'This is not a queued association update.' };
    if (!row.createdAt || +new Date(row.createdAt) < Date.now() - AGE_LIMIT) return { reason: 'This update delivery has expired.' };
    const [member, update] = await Promise.all([
        Member.findById(row.user).lean(), Announcement.findById(row.data.sourceId).lean(),
    ]);
    if (!member || member.isActive === false || member.deletedAt || /admin$/.test(member.role || '')) return { reason: 'The member account is unavailable.' };
    if (!update || !broadcast.published('announcement', update)) return { reason: 'The update is no longer published or has expired.' };
    if (broadcast.sourceKey('announcement', update) !== row.data.broadcastKey) return { reason: 'A newer version of this update has replaced this delivery.' };
    const receipt = await require('../payment/paymentorder.model').findOne({ memberId: member._id, orderType: 'membership', status: 'paid' })
        .sort({ paidAt: -1, createdAt: -1 }).select('planId planAudience upgradeKind').lean();
    if (receipt?.planId && !receipt.upgradeKind && !receipt.planAudience) {
        const plan = await require('../members/membershipplan.model').findOne({ key: receipt.planId }).select('audience').lean();
        if (plan) receipt.planAudience = plan.audience;
    }
    const profile = /^(pay_|OFF-)/.test(member.paymentId || '') && !receipt ? { ...member, membershipStatus: 'pending' } : member;
    if (!broadcast.visibleTo('announcement', update, { ...member, ...memberAccess(profile, receipt) })) return { reason: 'The update no longer applies to this membership or region.' };
    if (!preferences(member)[channel]) return { reason: channel === 'whatsapp' ? 'WhatsApp update messages are not enabled for this number.' : 'Email update messages are turned off.' };
    const recipient = channel === 'email' ? String(member.email || '').trim() : phoneFor(member);
    if (channel === 'email' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) : !/^\d{8,15}$/.test(recipient)) return { reason: 'No usable recipient address is available.' };
    return { member, update, recipient };
}

async function sendPrepared(channel, member, update, recipient) {
    if (!channels.includes(channel)) throw new Error('Unsupported association update channel.');
    const rendered = messages.render(update, member);
    if (channel === 'email') {
        if (!require('./emailAccounts').accountFor('membership').isConfigured) return { success: false, error: 'Membership email sender is not configured.' };
        return email.sendEmail({ category: 'membership', to: recipient, subject: rendered.subject, html: rendered.html, text: rendered.text });
    }
    if (!whatsapp.isConfigured()) return { success: false, error: 'WhatsApp sender is not configured.' };
    // Never fall back to free text outside a recipient-initiated session. This
    // template has a fixed greeting, summary and authenticated update link.
    return whatsapp.sendTemplateMessage(recipient, rendered.template, rendered.params, rendered.language);
}

async function finish(row, channel, worker, fields) {
    await Notification.updateOne({ _id: row._id, [`updateDelivery.${channel}.worker`]: worker }, {
        $set: Object.fromEntries(Object.entries({ ...fields, leaseUntil: null }).map(([key, value]) => [`updateDelivery.${channel}.${key}`, value])),
    });
}
async function run(row, channel, worker, resendOf) {
    resendOf ||= row.updateDelivery?.[channel]?.logId;
    let log;
    let contacted = false;
    let acceptedOutcome;
    try {
        const resolved = await current(row, channel);
        if (resolved.reason) {
            await finish(row, channel, worker, { status: 'skipped', lastError: resolved.reason });
            if (resendOf) await Log.updateOne({ _id: resendOf }, { $set: { 'data.autoRetryDisabled': true, 'data.skipReason': resolved.reason } });
            return { skipped: true, reason: resolved.reason };
        }
        const { member, update, recipient } = resolved;
        const rendered = messages.render(update, member);
        const path = `updateDelivery.${channel}`;
        log = await Log.create({ user: row.user, event: 'ASSOCIATION_UPDATE', channel, recipient,
            recipientName: member.fullName, status: 'queued', subject: rendered.subject,
            provider: channel === 'email' ? 'smtp' : whatsapp.providerName(),
            templateId: channel === 'whatsapp' ? rendered.template : undefined, resendOf,
            data: { notificationId: String(row._id), sourceId: String(update._id), broadcastKey: row.data.broadcastKey },
        });
        // Persist the audit link before touching a provider. An expired lease
        // can then recover an accepted result without sending it twice.
        const linked = await Notification.updateOne({ _id: row._id, [`${path}.worker`]: worker }, { $set: { [`${path}.logId`]: log._id } });
        if (!linked.matchedCount) return { skipped: true, reason: 'Another worker owns this delivery.' };
        contacted = true;
        const outcome = await sendPrepared(channel, member, update, recipient);
        const accepted = outcome.success && !outcome.mock;
        // All provider results are recorded, including missing credentials and
        // a rejected template. A successful mock is never called delivered.
        const failure = accepted ? '' : errorText(outcome.error || 'Provider did not send this message.');
        const uncertain = !accepted && /timed?\s*out|timeout|ECONNRESET|EPIPE|ESOCKET|socket (?:hang up|closed)|connection.*(?:closed|lost|terminated)/i.test(failure);
        log.status = accepted ? 'sent' : 'failed';
        log.deliveryStatus = accepted ? 'accepted' : 'failed';
        log.provider = outcome.provider || (channel === 'email' ? 'smtp' : whatsapp.providerName());
        log.sender = outcome.sender;
        log.replyTo = outcome.replyTo;
        log.providerMessageId = outcome.messageId;
        log.lastError = failure || undefined;
        log.failureReason = failure || undefined;
        if (uncertain) log.data = { ...log.data, autoRetryDisabled: true, outcomeUnknown: true };
        log.statusHistory = [{ status: log.deliveryStatus, at: new Date(), detail: failure || undefined }];
        await log.save();
        if (accepted) acceptedOutcome = outcome;
        const attempts = Number(row.updateDelivery?.[channel]?.attempts || 1);
        const retry = !accepted && !uncertain && attempts < 5 && require('./deliveryGuard').isHealable({ lastError: failure });
        await finish(row, channel, worker, { status: accepted ? 'sent' : retry ? 'pending' : 'failed', lastError: failure,
            nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)) });
        if (resendOf) await Log.updateOne({ _id: resendOf }, { $set: { resentAs: log._id } });
        return { row: log, outcome: { ...outcome, success: !!accepted } };
    } catch (error) {
        // The audit is the durable acceptance record. A later queue write can
        // fail without making that known provider result uncertain. Preserve it
        // so lease recovery can finish the row without another provider call.
        if (acceptedOutcome) {
            await finish(row, channel, worker, { status: 'sent', lastError: '' }).catch(() => null);
            return { row: log, outcome: { ...acceptedOutcome, success: true } };
        }
        // If an exception occurs after a provider might have accepted the send,
        // keep it failed for review. Never automatically replay an uncertain send.
        const reason = contacted ? 'Delivery outcome could not be confirmed. Check provider history before retrying.' : errorText(error.message);
        if (log) await Log.updateOne({ _id: log._id }, { $set: { status: 'failed', lastError: reason,
            'data.autoRetryDisabled': contacted, 'data.outcomeUnknown': contacted } }).catch(() => null);
        await finish(row, channel, worker, { status: contacted || Number(row.updateDelivery?.[channel]?.attempts || 1) >= 5 ? 'failed' : 'pending', lastError: reason,
            nextAttemptAt: new Date(Date.now() + 60000) }).catch(() => null);
        return { row: log, outcome: { success: false, error: reason } };
    }
}

async function claim(channel, id, failedLog) {
    const worker = crypto.randomUUID();
    const path = `updateDelivery.${channel}`;
    const query = { ...(id ? { _id: id } : {}), [`${path}.status`]: { $in: failedLog ? ['failed', 'sent'] : ['pending'] },
        ...(failedLog ? { [`${path}.logId`]: failedLog } : { [`${path}.nextAttemptAt`]: { $lte: new Date() } }) };
    const row = await Notification.findOneAndUpdate(query, { $set: {
        [`${path}.status`]: 'sending', [`${path}.worker`]: worker, [`${path}.leaseUntil`]: new Date(Date.now() + LEASE_MS),
    }, $inc: { [`${path}.attempts`]: 1 } }, { new: true, sort: { createdAt: 1 } }).lean();
    return row ? { row, worker } : null;
}

async function recover(channel) {
    const path = `updateDelivery.${channel}`;
    const rows = await Notification.find({ [`${path}.status`]: 'sending', [`${path}.leaseUntil`]: { $lt: new Date() } }).limit(10).lean();
    for (const row of rows) {
        const log = row.updateDelivery?.[channel]?.logId ? await Log.findById(row.updateDelivery[channel].logId).lean() : null;
        const accepted = log && ['accepted', 'sent', 'delivered', 'read'].includes(log.deliveryStatus);
        const rejected = log?.deliveryStatus === 'failed';
        const reason = accepted ? '' : rejected ? log.lastError || 'Provider rejected this delivery.' : 'Worker interrupted; provider outcome is unknown. Review delivery history.';
        if (log && !accepted && !rejected) await Log.updateOne({ _id: log._id }, { $set: { 'data.autoRetryDisabled': true, 'data.outcomeUnknown': true, lastError: reason } });
        await finish(row, channel, row.updateDelivery[channel].worker, { status: accepted ? 'sent' : 'failed', lastError: reason });
    }
}
async function processBatch() {
    // Bounded parallelism and a DB lease make this safe across multiple API
    // workers. The member scan remains cursor-based in contentBroadcast.
    await Promise.all(channels.map(recover));
    await Promise.all(channels.map(async channel => {
        for (let index = 0; index < 2; index++) {
            const claimed = await claim(channel);
            if (!claimed) break;
            await run(claimed.row, channel, claimed.worker);
        }
    }));
}
async function retryLog(log) {
    if (!log || !channels.includes(log.channel) || log.event !== 'ASSOCIATION_UPDATE') return null;
    if (log.data?.outcomeUnknown) return { row: log, skipped: true, reason: 'Provider outcome is unknown; review it before sending a new update.' };
    if (!require('mongoose').isValidObjectId(log.data?.notificationId)) return { row: log, skipped: true, reason: 'The original update delivery could not be verified.' };
    if (log.deliveryStatus !== 'failed' && log.status !== 'failed') return { row: log, skipped: true, reason: 'Only a confirmed failed delivery can be retried.' };
    const claimed = await claim(log.channel, log.data?.notificationId, log._id);
    if (!claimed) return { row: log, skipped: true, reason: 'This delivery is queued, already retried, or unavailable.' };
    const result = await run(claimed.row, log.channel, claimed.worker, log._id);
    return { ...result, row: result.row || log };
}
module.exports = { processBatch, retryLog, current, sendPrepared, recover };
