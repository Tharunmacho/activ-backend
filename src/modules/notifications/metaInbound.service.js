const config = require('../../config');
const dataLayout = require('../../config/dataLayout');
const bot = require('./botbeeWebhook.service');

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

const handleWebhook = async (body = {}) => {
    let handled = 0;
    let duplicates = 0;
    for (const { envelope, message } of messagesFrom(body)) {
        const collection = await receipts();
        const id = `${config.metaCloud.phoneNumberId}:${message.id}`;
        try {
            // The native _id index is unique even before app indexes exist.
            // This protects retries and concurrent Dokploy replicas/restarts.
            await collection.insertOne({ _id: id, status: 'processing', receivedAt: new Date(),
                expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000) });
        } catch (error) {
            if (error.code === 11000) { duplicates++; continue; }
            throw error; // Return 500 so Meta can retry a database failure.
        }
        try {
            const result = await bot.handleInbound(envelope, { provider: 'meta' });
            await collection.updateOne({ _id: id }, { $set: {
                status: result.handled === false ? 'ignored' : result.sent && result.sent.success ? 'replied' : 'failed',
                completedAt: new Date(), outboundMessageIds: result.sent && result.sent.messageIds || [],
                error: result.sent && result.sent.error || null
            } });
            handled++;
        } catch (error) {
            await collection.updateOne({ _id: id }, { $set: { status: 'failed', completedAt: new Date(),
                error: String(error.message || 'Reply processing failed') } });
            throw error;
        }
    }
    return { handled, duplicates };
};

module.exports = { messagesFrom, handleWebhook };
