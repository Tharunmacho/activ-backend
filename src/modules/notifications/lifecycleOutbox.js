const crypto = require('node:crypto');
const Outbox = require('./lifecycleOutbox.model');
const Log = require('./notificationLog.model');
const Notification = require('./notification.model');
const logger = require('../../config/logger');
const CHANNELS = ['in_app', 'email', 'whatsapp'];
const LEASE_MS = 5 * 60000;
const errorText = error => String(error?.message || error || '').slice(0, 500);
const uncertain = outcome => !outcome?.success && (outcome?.outcomeUnknown === true
    || /timed?\s*out|timeout|ECONNRESET|EPIPE|ESOCKET|socket (?:hang up|closed)|connection.*(?:closed|lost|terminated)/i.test(outcome?.error || ''));
const plain = value => JSON.parse(JSON.stringify(value));
let indexesReady;
function ensureIndexes() {
    if (!indexesReady) indexesReady = Outbox.createIndexes().catch(error => { indexesReady = null; throw error; });
    return indexesReady;
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
function keyFor(event, recipient, payload) {
    // Sweeps may run again after enqueue succeeded but the member checkpoint
    // did not. Contact details and daysLeft can change between those attempts.
    const memberId = recipient?.id && String(recipient.id._id || recipient.id);
    const reminderKey = payload?.data?.renewalReminderKey;
    const confirmation = /^EVENT_(BOOKING|PARTICIPANT)_CONFIRMED$/.test(event)
        && !payload?.data?.nominationChange && payload?.data?.bookingConfirmation;
    const reminderRecordId = /^EVENT_(?:(?:BOOKING|PARTICIPANT)_)?REMINDER$/.test(event)
        && payload?.data?.reminderKey && (payload.data.reminderBookingId || payload.data.registrationId);
    const reminderRecipient = { id: memberId || '', email: String(recipient?.email || '').trim().toLowerCase(),
        phone: String(recipient?.whatsappNumber || recipient?.whatsapp || recipient?.phoneNumber || recipient?.phone || '').replace(/\D/g, '') };
    const identity = event === 'MEMBERSHIP_RENEWAL_DUE' && memberId && reminderKey
        ? { event, memberId, reminderKey: String(reminderKey) }
        : event === 'MEMBERSHIP_PLAN_ADVANCED' && memberId && payload?.data?.progressionKey
            ? { event, memberId, progressionKey: payload.data.progressionKey }
        : reminderRecordId ? { event, recordId: reminderRecordId, reminderKey: payload.data.reminderKey,
            registrationStateKey: payload.data.registrationStateKey || '',
            participantIndex: payload.data.reminderParticipantIndex ?? -1, recipient: reminderRecipient }
        : confirmation?.bookingId ? { event, recipient, confirmation } : { event, recipient, payload };
    return 'lifecycle:' + crypto.createHash('sha256')
        .update(JSON.stringify(canonical(plain(identity)))).digest('hex');
}

async function saveIntent(key, fields) {
    await ensureIndexes();
    try {
        return await Outbox.findOneAndUpdate({ key }, { $setOnInsert: { key, ...fields } }, { upsert: true, new: true }).lean();
    } catch (error) {
        if (error.code === 11000) return Outbox.findOne({ key }).lean();
        throw error;
    }
}
async function enqueue(event, recipient = {}, payload = {}) {
    const snapshot = plain({ recipient, payload });
    return saveIntent(keyFor(event, snapshot.recipient, snapshot.payload), { event, ...snapshot });
}
async function schedulePayment(orderId, when) {
    return saveIntent(`payment-pending:${String(orderId)}`, { kind: 'payment_pending', payload: { orderId: String(orderId) }, nextAttemptAt: when });
}
const resultFor = row => row ? ({ event: row.event, channels: Object.fromEntries(CHANNELS.map(channel => [channel, row.channels?.[channel]?.outcome || null])), rows: {}, contact: null,
    queued: row.status !== 'done', outboxId: String(row._id) }) : null;

async function reasonToSkip(row) {
    const recorded = { event: row.event, user: row.recipient?.id,
        data: { lifecycleData: row.payload?.data || {} }, createdAt: row.createdAt };
    const reason = await require('./retryEligibility').reasonToSkip(recorded);
    if (reason || !/^EVENT_/.test(row.event)) return reason;
    const changes = require('../events/eventChanges.service');
    const legacy = ['EVENT_REGISTERED', 'EVENT_REMINDER'].includes(row.event)
        || (row.event === 'EVENT_BOOKING_WAITLISTED' && row.payload?.data?.registrationId);
    const validator = legacy ? changes.reasonToSkipRegistrationNotice
        : ['EVENT_UPDATED', 'EVENT_CANCELLED'].includes(row.event) ? changes.reasonToSkipChange : null;
    if (validator) {
        const targets = { email: row.recipient?.email,
            whatsapp: row.recipient?.whatsappNumber || row.recipient?.whatsapp || row.recipient?.phoneNumber || row.recipient?.phone };
        for (const [channel, recipient] of Object.entries(targets)) {
            if (!recipient || row.channels?.[channel]?.status !== 'pending') continue;
            const skip = await validator({ ...recorded, channel, recipient });
            if (skip) return skip;
        }
        return '';
    }
    return require('../events/eventbooking.service').reasonToSkipQueuedNotification(row.event, row.recipient, row.payload);
}

async function recoverChannels(row, owner) {
    for (const channel of CHANNELS) {
        if (!['sending', 'failed'].includes(row.channels?.[channel]?.status)) continue;
        const logs = await Log.find({ 'data.outboxId': String(row._id), channel }).sort({ createdAt: -1 }).lean();
        if (row.channels[channel].status === 'failed') {
            // Logged failures belong to deliveryGuard. If the audit write alone
            // failed, the persisted definite refusal can safely be tried here.
            if (!logs.length) {
                await Outbox.updateOne(owner, { $set: { [`channels.${channel}.status`]: 'pending' } });
                row.channels[channel].status = 'pending';
            }
            continue;
        }
        const accepted = logs.find(log => log.status === 'sent' || ['accepted', 'sent', 'delivered', 'read'].includes(log.deliveryStatus));
        const rejected = logs.find(log => log.status === 'failed' || log.deliveryStatus === 'failed');
        const bell = channel === 'in_app' && await Notification.exists({ deliveryKey: `lifecycle:${row._id}:in_app` });
        const status = accepted || bell ? 'done' : rejected && !rejected.data?.outcomeUnknown ? 'failed' : 'held';
        const lastError = status === 'held' ? 'Worker interrupted during delivery. Provider outcome is unknown; review before any new send.' : rejected?.lastError || '';
        const outcome = accepted || bell ? { success: true, recovered: true, messageId: accepted?.providerMessageId, mock: !!accepted?.mock }
            : { success: false, error: lastError, outcomeUnknown: status === 'held' };
        if (status === 'held' && !logs.length) await Log.create({ event: row.event, channel, user: row.recipient?.id || undefined,
            recipient: channel === 'email' ? row.recipient?.email || 'unknown' : channel === 'in_app' ? String(row.recipient?.id || 'unknown')
                : row.recipient?.whatsappNumber || row.recipient?.whatsapp || row.recipient?.phoneNumber || row.recipient?.phone || 'unknown',
            status: 'failed', lastError, data: { outboxId: String(row._id), lifecycleData: row.payload?.data || {}, outcomeUnknown: true, autoRetryDisabled: true } });
        await Outbox.updateOne(owner, { $set: { [`channels.${channel}`]: { status, outcome, lastError } } });
        row.channels[channel] = { status, outcome, lastError };
    }
}

async function processOne(id) {
    await ensureIndexes();
    const worker = crypto.randomUUID();
    const now = new Date();
    const row = await Outbox.findOneAndUpdate({ ...(id ? { _id: id } : {}), nextAttemptAt: { $lte: now }, $or: [
        { status: 'pending' }, { status: 'processing', leaseUntil: { $lte: now } },
    ] }, { $set: { status: 'processing', worker, leaseUntil: new Date(+now + LEASE_MS) }, $inc: { attempts: 1 } }, { new: true, sort: { createdAt: 1 } }).lean();
    if (!row) return id ? resultFor(await Outbox.findById(id).lean()) : null;
    const owner = { _id: row._id, worker, status: 'processing' };
    try {
        if (row.kind === 'payment_pending') {
            const outcome = await require('../payment/paymentOrder.service').notifyPaymentPending(row.payload.orderId);
            if (outcome?.error) throw new Error(outcome.error);
            await Outbox.updateOne(owner, { $set: { status: 'done', leaseUntil: null } });
            return outcome;
        }
        await recoverChannels(row, owner);
        const pending = CHANNELS.filter(channel => row.channels?.[channel]?.status === 'pending');
        if (!pending.length) {
            await Outbox.updateOne(owner, { $set: { status: 'done', leaseUntil: null } });
            return resultFor({ ...row, status: 'done' });
        }
        const skipReason = await reasonToSkip(row);
        if (skipReason) {
            // A failed read can heal; it is not proof that this notice is stale.
            if (/could not be checked|could not be verified.*Retry|Retry after/i.test(skipReason)) throw new Error(skipReason);
            await Outbox.updateOne(owner, { $set: { status: 'done', leaseUntil: null, lastError: skipReason,
                ...Object.fromEntries(pending.map(channel => [`channels.${channel}`, { status: 'skipped', lastError: skipReason }])) } });
            return { ...resultFor(row), queued: false, skipped: true, reason: skipReason };
        }
        const context = {
            id: String(row._id), bellKey: `lifecycle:${row._id}:in_app`,
            async beforeSend(channel) {
                if (!pending.includes(channel)) return false;
                // A slow first provider must not let the remaining reminder
                // channels start after the event has begun or been withdrawn.
                if (/^EVENT_(?:BOOKING_|PARTICIPANT_)?REMINDER$/.test(row.event)) {
                    const reason = await reasonToSkip(row);
                    if (reason) {
                        if (/could not be checked|could not be verified.*Retry|Retry after/i.test(reason)) throw new Error(reason);
                        await Outbox.updateOne(owner, { $set: {
                            [`channels.${channel}`]: { status: 'skipped', lastError: reason },
                        } });
                        return false;
                    }
                }
                const changed = await Outbox.updateOne({ ...owner, [`channels.${channel}.status`]: 'pending' }, {
                    $set: { [`channels.${channel}.status`]: 'sending' },
                });
                return !!changed.matchedCount;
            },
            async afterSend(channel, outcome) {
                const unknown = uncertain(outcome);
                const status = outcome?.success ? 'done' : channel === 'in_app' ? 'pending' : unknown ? 'held' : 'failed';
                // Try both this checkpoint and the delivery log independently.
                // If both writes fail, the sending state holds the outcome for review.
                await Outbox.updateOne(owner, { $set: { [`channels.${channel}`]: { status,
                    outcome: plain(outcome || { success: false }), lastError: errorText(outcome?.error) } } }).catch(error => {
                    logger.warn('Lifecycle outcome checkpoint could not be saved', { outboxId: String(row._id), channel, error: errorText(error) });
                });
            },
        };
        const result = await require('./notification.service')._deliverLifecycleEvent(row.event, row.recipient, row.payload, context);
        const latest = await Outbox.findById(row._id).lean();
        const set = {};
        for (const channel of pending) {
            const state = latest.channels?.[channel]?.status;
            if (state === 'pending' && result.channels[channel]?.success === false) result.dispatchError ||= 'The in-app notification could not be saved.';
            if (state === 'pending' && !result.dispatchError) set[`channels.${channel}`] = { status: 'skipped', lastError: 'No applicable template or recipient for this channel.' };
            if (state === 'failed' && !result.rows[channel]) {
                await recoverChannels(latest, owner);
                if (latest.channels[channel].status === 'pending') result.dispatchError ||= 'The rejected delivery could not be recorded for retry.';
            }
            // Exceptions before the provider call can retry; after it, only recovery can decide.
            if (state === 'sending') {
                await recoverChannels(latest, owner);
            }
        }
        if (result.dispatchError) throw new Error(result.dispatchError);
        await Outbox.updateOne(owner, { $set: { ...set, status: 'done', leaseUntil: null } });
        for (const channel of CHANNELS) result.channels[channel] ||= latest.channels?.[channel]?.outcome || null;
        return { ...result, outboxId: String(row._id) };
    } catch (error) {
        const lastError = errorText(error);
        await Outbox.updateOne(owner, { $set: { status: 'pending', leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** row.attempts)), lastError } }).catch(() => null);
        logger.warn('Lifecycle intent deferred', { outboxId: String(row._id), error: lastError });
        return { ...resultFor(row), queued: true, error: lastError };
    }
}
let running = false;
let timer;
let nextBookingSweep = 0;
async function tick() {
    if (running) return;
    running = true;
    try {
        if (Date.now() >= nextBookingSweep) {
            nextBookingSweep = Date.now() + 30000;
            await require('../events/eventbooking.service').queuePendingConfirmations().catch(error => {
                logger.warn('Pending booking confirmation sweep deferred', { error: errorText(error) });
            });
        }
        for (let index = 0; index < 4; index++) if (!await processOne()) break;
    }
    catch (error) { logger.warn('Lifecycle outbox worker failed', { error: errorText(error) }); }
    finally { running = false; }
}
function start() {
    if (timer || process.env.NOTIFICATION_WORKER_ENABLED === 'false') return;
    timer = setInterval(() => void tick(), 1000); timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { enqueue, schedulePayment, processOne, tick, start, stop, uncertain, keyFor };
