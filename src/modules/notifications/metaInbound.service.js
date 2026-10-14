const config = require('../../config');
const dataLayout = require('../../config/dataLayout');
const bot = require('./botbeeWebhook.service');
const { randomUUID } = require('node:crypto');

const LEASE_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

let indexes;
const receipts = async () => {
    const collection = dataLayout.collection('whatsappInbound');
    if (!indexes) {
        indexes = collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
            .catch(error => { indexes = null; throw error; });
    }
    await indexes;
    return collection;
};

/** Only messages delivered for our sending number, never status/echo callbacks. */
const messagesFrom = (body = {}) => {
    if (body.object !== 'whatsapp_business_account') return [];
    const incoming = [];
    for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
            const value = change.value || {};
            if (change.field !== 'messages' || !config.metaCloud.phoneNumberId
                || String(value.metadata && value.metadata.phone_number_id) !== String(config.metaCloud.phoneNumberId)) continue;
            for (const message of value.messages || []) {
                if (!['text', 'button', 'interactive'].includes(message.type)) continue;
                const timestamp = Number(message.timestamp) * 1000;
                // A delayed replay must never reopen a closed session or send
                // a reply to one of Meta's dashboard examples.
                if (!message.id || !message.from || !Number.isFinite(timestamp)
                    || timestamp <= 0 || timestamp < Date.now() - 24 * 60 * 60 * 1000
                    || timestamp > Date.now() + 5 * 60 * 1000) continue;
                const envelope = { object: body.object, entry: [{ changes: [{
                    field: 'messages', value: { ...value, messages: [message] }
                }] }] };
                const parsed = bot.extractMessage(envelope);
                if (parsed && String(parsed.text || '').trim()) incoming.push({ envelope, message });
            }
        }
    }
    return incoming;
};

// Only preparation can be reclaimed. Once sending starts, provider attempts
// (including a partially sent reply) belong to the delivery log/retry worker.
// A lost response after Meta accepted a message must not replay the whole reply.
const claimReceipt = async (collection, id) => {
    const now = new Date();
    const leaseId = randomUUID();
    const lease = { status: 'processing', leaseId, leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now };
    try {
        await collection.insertOne({ _id: id, ...lease, attempts: 1, receivedAt: now,
            expiresAt: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000) });
        return { leaseId, reclaimed: false };
    } catch (error) {
        if (error.code !== 11000) throw error;
    }
    const reclaimed = await collection.findOneAndUpdate({ _id: id,
        'outboundMessageIds.0': { $exists: false },
        $and: [
            { $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { attempts: { $exists: false } }] },
            { $or: [
                { status: 'failed', retryable: { $ne: false } },
                { status: 'processing', leaseUntil: { $lte: now } },
                { status: 'processing', leaseUntil: { $exists: false }, receivedAt: { $lte: new Date(now.getTime() - LEASE_MS) } }
            ] }
        ]
    }, { $set: lease, $inc: { attempts: 1 }, $unset: { completedAt: '', error: '' } },
    { returnDocument: 'after', includeResultMetadata: false });
    if (reclaimed) return { leaseId, reclaimed: true };
    const current = await collection.findOne({ _id: id });
    if (current?.status === 'processing' && !current.outboundMessageIds?.length) {
        const expired = new Date(current.leaseUntil || new Date(new Date(current.receivedAt).getTime() + LEASE_MS)).getTime() <= now.getTime();
        if (expired && Number(current.attempts || 1) >= MAX_ATTEMPTS) {
            await collection.updateOne({ _id: id, status: 'processing', leaseId: current.leaseId }, { $set: {
                status: 'failed', retryable: false, completedAt: now, error: 'WhatsApp reply preparation retry limit reached'
            } });
            return null;
        }
        // Do not acknowledge an unfinished worker's message: if it dies, Meta
        // must still retry after its preparation lease expires.
        throw new Error('WhatsApp reply preparation is already in progress');
    }
    return null;
};

const handleWebhook = async (body = {}) => {
    let handled = 0;
    let duplicates = 0;
    for (const { envelope, message } of messagesFrom(body)) {
        const collection = await receipts();
        const id = `${config.metaCloud.phoneNumberId}:${message.id}`;
        const claim = await claimReceipt(collection, id);
        if (!claim) { duplicates++; continue; }
        const owner = { _id: id, leaseId: claim.leaseId };
        let sendingStarted = false;
        let result;
        try {
            if (claim.reclaimed) {
                // Older deployments did not checkpoint before sending. A log
                // proves an attempt already happened even if its receipt update
                // failed. Never replay its accepted chunks or race its retry job.
                const logged = await require('./notificationLog.model').findOne({
                    event: 'BOT_REPLY', channel: 'whatsapp', provider: 'meta',
                    'data.inboundMessageId': message.id,
                }).select('status providerMessageId').lean();
                if (logged) {
                    await collection.updateOne(owner, { $set: {
                        status: logged.status === 'sent' ? 'replied' : 'failed', retryable: false,
                        completedAt: new Date(), outboundMessageIds: logged.providerMessageId ? [logged.providerMessageId] : []
                    } });
                    duplicates++;
                    continue;
                }
            }
            result = await bot.handleInbound(envelope, { provider: 'meta', inboundAt: new Date(Number(message.timestamp) * 1000), beforeReplySend: async () => {
                // The lease token also fences a slow original worker after a
                // replacement has claimed the message. No provider call without
                // a confirmed, durable transition to sending.
                const checkpoint = await collection.updateOne({ ...owner, status: 'processing' }, {
                    $set: { status: 'sending', retryable: false, sendStartedAt: new Date() },
                    $unset: { leaseUntil: '' }
                });
                if (!checkpoint.matchedCount) throw new Error('WhatsApp reply preparation lease was replaced');
                sendingStarted = true;
            } });
            await collection.updateOne(owner, { $set: {
                status: result.handled === false ? 'ignored' : result.sent && result.sent.success ? 'replied' : 'failed',
                retryable: false,
                completedAt: new Date(), outboundMessageIds: result.sent && result.sent.messageIds || [],
                error: result.sent && result.sent.error || null
            } });
            handled++;
        } catch (error) {
            // If checkpoint acknowledgement itself was lost, the stored sending
            // state is deliberately left alone: its outcome may be uncertain.
            await collection.updateOne({ ...owner, ...(!sendingStarted ? { status: 'processing' } : {}) }, { $set: {
                status: 'failed', retryable: !sendingStarted, completedAt: new Date(),
                ...(result?.sent?.messageIds ? { outboundMessageIds: result.sent.messageIds } : {}),
                error: String(error.message || 'Reply processing failed')
            } }).catch(() => null);
            throw error;
        }
    }
    return { handled, duplicates };
};

module.exports = { messagesFrom, handleWebhook, LEASE_MS, MAX_ATTEMPTS };
