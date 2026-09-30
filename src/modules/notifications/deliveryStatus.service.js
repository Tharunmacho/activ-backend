const NotificationLog = require('./notificationLog.model');
const logger = require('../../config/logger');

/**
 * =========================================================================
 * WHAT HAPPENED TO A WHATSAPP MESSAGE AFTER META SAID YES
 * =========================================================================
 *
 * Meta answers a template send with a message id (`wamid.…`) the moment it
 * ACCEPTS the request. Whether it then reached the phone is reported later,
 * as a status callback on the webhook: `sent`, `delivered`, `read`, or
 * `failed` with an error — a header image Meta could not download, a number
 * with no WhatsApp, a template paused for quality, the 24-hour rule.
 *
 * Those callbacks used to be thrown away (the inbound handler reads only
 * `messages`), so every row stayed "sent" forever and "the payer got nothing"
 * had no answer anywhere in the application. This matches each callback to
 * its log row by `providerMessageId` and records it.
 *
 * NEVER THROWS. It runs after the webhook has already been answered 200; a
 * malformed callback is logged and dropped.
 */

/** How far along a message is. `failed` is handled apart — it always wins. */
const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };
const KNOWN = new Set(['sent', 'delivered', 'read', 'failed']);

/** One provider error as a sentence: "Media download error: … (code 131053)". */
const describeError = (errors) => {
    const e = Array.isArray(errors) ? errors[0] : errors;
    if (!e || typeof e !== 'object') return { code: '', title: '', detail: '' };
    const code = e.code !== undefined && e.code !== null ? String(e.code) : '';
    const title = String(e.title || e.message || '').trim();
    const detail = String((e.error_data && e.error_data.details) || e.details || e.message || '').trim();
    return { code, title, detail: detail && detail !== title ? detail : '' };
};

/**
 * Every status callback in a webhook body, whatever the envelope.
 *
 * Meta's own shape (`entry[].changes[].value.statuses[]`) — which is also what
 * BotBee forwards when it proxies Meta — plus the flatter shapes a relay might
 * post (`{ statuses: [...] }`, or a single `{ status, message_id }`).
 */
const extractStatuses = (body = {}) => {
    const out = [];
    const push = (s) => {
        if (!s || typeof s !== 'object') return;
        const id = s.id || s.message_id || s.messageId || s.wamid || s.wa_id_message;
        const status = String(s.status || s.message_status || '').toLowerCase().trim();
        if (!id || !KNOWN.has(status)) return;
        out.push({
            id: String(id),
            status,
            timestamp: s.timestamp,
            recipient: s.recipient_id || s.recipient || '',
            errors: s.errors || s.error || null
        });
    };

    try {
        const entries = Array.isArray(body.entry) ? body.entry : [];
        entries.forEach((entry) => (Array.isArray(entry && entry.changes) ? entry.changes : []).forEach((change) => {
            const value = (change && change.value) || {};
            (Array.isArray(value.statuses) ? value.statuses : []).forEach(push);
        }));
        if (Array.isArray(body.statuses)) body.statuses.forEach(push);
        if (body.data && Array.isArray(body.data.statuses)) body.data.statuses.forEach(push);
        // A single flat callback — only when it carries a message id AND a
        // delivery word, so an inbound text is never mistaken for one.
        if (!out.length && !body.entry) {
            push(body);
            if (body.data && typeof body.data === 'object') push(body.data);
        }
    } catch (error) {
        logger.warn('WhatsApp status callback could not be read', { error: error && error.message });
    }
    return out;
};

const toDate = (timestamp) => {
    const n = Number(timestamp);
    if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n);
    const d = timestamp ? new Date(timestamp) : null;
    return d && !Number.isNaN(d.getTime()) ? d : new Date();
};

/**
 * Apply one status to its log row. Resolves `{ matched, changed }`.
 *
 * Idempotent — Meta retries callbacks, and the same `delivered` twice is one
 * step in the timeline. Never moves backwards: a `delivered` arriving after
 * `read` (they can cross in flight) is recorded in the history but does not
 * demote the row.
 */
const applyStatus = async({ id, status, timestamp, errors } = {}) => {
    if (!id || !KNOWN.has(status)) return { matched: false, changed: false };

    const row = await NotificationLog.findOne({ providerMessageId: String(id) })
        .select('deliveryStatus statusHistory status')
        .lean()
        .catch(() => null);
    if (!row) return { matched: false, changed: false };

    const at = toDate(timestamp);
    const history = Array.isArray(row.statusHistory) ? row.statusHistory : [];
    if (history.some((h) => h && h.status === status)) return { matched: true, changed: false };

    const { code, title, detail } = status === 'failed' ? describeError(errors) : { code: '', title: '', detail: '' };
    const step = { status, at, ...(code ? { code } : {}), ...(title ? { title } : {}), ...(detail ? { detail: detail.slice(0, 500) } : {}) };

    const current = row.deliveryStatus || (row.status === 'failed' ? 'failed' : 'accepted');
    const set = {};
    if (status === 'failed') {
        const reason = [title || 'Delivery failed', detail].filter(Boolean).join(': ') + (code ? ` (code ${code})` : '');
        Object.assign(set, {
            deliveryStatus: 'failed',
            status: 'failed',
            failedAt: at,
            ...(code ? { failureCode: code } : {}),
            failureReason: reason.slice(0, 1000),
            lastError: `WhatsApp could not deliver: ${reason}`.slice(0, 1000)
        });
    } else if (current !== 'failed' && RANK[status] > (RANK[current] === undefined ? -1 : RANK[current])) {
        set.deliveryStatus = status;
    }
    if (status === 'delivered') set.deliveredAt = at;
    if (status === 'read') {
        set.readAt = at;
        // A read message was delivered, even if that callback never came.
        if (!history.some((h) => h && h.status === 'delivered')) set.deliveredAt = at;
    }

    await NotificationLog.updateOne(
        { _id: row._id },
        { $set: set, $push: { statusHistory: step } }
    ).catch((error) => logger.warn('Delivery status not recorded', { id, status, error: error && error.message }));

    if (status === 'failed') {
        logger.warn('WhatsApp message FAILED after it was accepted', { providerMessageId: id, code, title, detail });
    }
    return { matched: true, changed: true };
};

/** Every status in a webhook body. Resolves a count; never rejects. */
const applyFromWebhook = async(body = {}) => {
    const statuses = extractStatuses(body);
    let matched = 0;
    for (const s of statuses) {
        try {
            const result = await applyStatus(s);
            if (result.matched) matched += 1;
        } catch (error) {
            logger.warn('Delivery status callback failed', { error: error && error.message });
        }
    }
    if (statuses.length) {
        logger.info('WhatsApp delivery statuses received', { received: statuses.length, matched });
    }
    return { received: statuses.length, matched };
};

/**
 * The one status a Super Admin reads for a row.
 *
 * Rows written before delivery tracking have no `deliveryStatus`: a `sent`
 * one was accepted by the provider and nothing more is known.
 */
const effectiveStatus = (row = {}) => {
    if (row.mock) return 'mock';
    if (row.deliveryStatus) return row.deliveryStatus;
    if (row.status === 'failed') return 'failed';
    if (row.status === 'sent') return 'accepted';
    return row.status || 'queued';
};

module.exports = { extractStatuses, applyStatus, applyFromWebhook, effectiveStatus, describeError, RANK };
