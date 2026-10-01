const logger = require('../../config/logger');

/**
 * ============================================================================
 * DELIVERY GUARD — failures that heal themselves, and an outage that shouts
 * ============================================================================
 *
 * 28–30 Sept 2026: the SMTP password stopped working. For 2.5 days every email
 * failed with "535 Incorrect authentication data", nothing warned anyone, and
 * when the password was fixed the 58 messages that had failed simply stayed
 * failed. This module closes both halves:
 *
 *   HEALTH  the mail server's login is proven at boot and every 15 minutes
 *           (`checkEmail`). A failure is logged at ERROR on the transition and
 *           served by GET /notifications/health, which the Automation screens
 *           show as a red banner.
 *
 *   RETRY   every 10 minutes (`sweep`) a failure whose cause can heal — a
 *           rejected login, a timeout, a dropped connection, a rate limit — is
 *           sent again through `notificationService.retryLog`, the same path
 *           as the Resend button. Up to 3 automatic tries per message, backing
 *           off, within 24 hours of the original. A PERMANENT failure (number
 *           not on WhatsApp, address refused, template missing) is never
 *           retried: trying again cannot change the answer.
 *
 *   BULK    `retryFailed({ sinceHours })` — the Super Admin's "Retry all
 *           failed" button, for a backlog older than the automatic window.
 *
 * Email rows are not retried while the mail server's login is failing — that
 * would only spend their tries. They go the moment it recovers.
 */

const SWEEP_MINUTES = Math.max(2, parseInt(process.env.NOTIFICATION_RETRY_INTERVAL_MINUTES, 10) || 10);
const HEALTH_MINUTES = 15;
const AUTO_WINDOW_HOURS = 24;
const MAX_AUTO_RETRIES = 3;
const NEVER_RETRY = ['PASSWORD_RESET', 'ADMIN_WELCOME'];

/** Causes that a later attempt can succeed past. */
const HEALABLE = new RegExp([
    '535', 'invalid login', 'authentication', 'auth', 'EAUTH',
    'ECONN', 'ETIMEDOUT', 'ESOCKET', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'socket', 'timed? ?out', 'network',
    '\\b421\\b', '\\b45[0-2]\\b', 'try again', 'temporar', 'rate', 'throttl', 'too many',
    // WhatsApp Cloud: generic, service unavailable, spam-rate, per-user rate, throughput
    '\\b131000\\b', '\\b131016\\b', '\\b131048\\b', '\\b131056\\b', '\\b130429\\b', '\\b133016\\b',
].join('|'), 'i');

/** Causes no retry can fix. Checked first: a permanent cause wins. */
const PERMANENT = new RegExp([
    '131026', 'not on whatsapp', 'undeliverable', '132000', '132001', 'does not exist', '132005', 'too long',
    '131009', 'invalid parameter', 'invalid (phone|number|recipient)', 'recipient.*(rejected|refused)',
    "own WhatsApp number",
    '\\b550\\b', '\\b553\\b', 'mailbox (unavailable|not found)', 'no such user', 'user unknown',
].join('|'), 'i');

const reasonOf = (row = {}) => String(row.failureReason || row.lastError || '');

const isHealable = (row = {}) => {
    const reason = reasonOf(row);
    if (!reason) return false;
    if (PERMANENT.test(reason)) return false;
    return HEALABLE.test(reason);
};

/* ------------------------------------------------------------------ health */

const health = {
    email: { ok: null, configured: null, checkedAt: null, error: '' },
};

const checkEmail = async() => {
    const emailService = require('./email.service');
    let result;
    try {
        result = await emailService.verifyConnection();
    } catch (err) {
        result = { ok: false, configured: true, error: err && err.message };
    }
    const wasOk = health.email.ok;
    health.email = {
        ok: !!result.ok,
        configured: result.configured !== false,
        checkedAt: new Date(),
        error: result.ok ? '' : String(result.error || 'Unknown error'),
    };
    if (!result.ok && wasOk !== false) {
        logger.error('EMAIL IS NOT SENDING: the mail server refused the connection or login. '
            + 'Every email will fail until EMAIL_HOST / EMAIL_USER / EMAIL_PASS are corrected.', { error: health.email.error });
    } else if (result.ok && wasOk === false) {
        logger.info('Email delivery recovered — failed emails will be retried automatically.');
    }
    return health.email;
};

const getHealth = () => ({
    email: { ...health.email },
    autoRetry: { enabled: autoRetryEnabled(), everyMinutes: SWEEP_MINUTES, maxTries: MAX_AUTO_RETRIES, windowHours: AUTO_WINDOW_HOURS },
});

/* ------------------------------------------------------------------- retry */

const autoRetryEnabled = () =>
    String(process.env.NOTIFICATION_AUTO_RETRY || 'true').toLowerCase() !== 'false';

/** The message this row is a re-send of, at the root of its chain (max 6 hops). */
const rootOf = async(NotificationLog, row) => {
    let current = row;
    for (let hop = 0; hop < 6 && current && current.resendOf; hop += 1) {
        // eslint-disable-next-line no-await-in-loop
        const parent = await NotificationLog.findById(current.resendOf).lean().catch(() => null);
        if (!parent) break;
        current = parent;
    }
    return current || row;
};

/**
 * The failed rows to try again: the LATEST attempt of each message (a row that
 * has been re-sent is represented by its newer copy), healable, not mock.
 */
const candidates = async(NotificationLog, { sinceHours, limit = 50 }) => NotificationLog.find({
    channel: { $in: ['email', 'whatsapp'] },
    mock: { $ne: true },
    $or: [{ deliveryStatus: 'failed' }, { deliveryStatus: { $exists: false }, status: 'failed' }],
    resentAs: { $exists: false },
    event: { $nin: NEVER_RETRY },
    createdAt: { $gte: new Date(Date.now() - sinceHours * 60 * 60 * 1000) },
}).sort({ createdAt: 1 }).limit(limit).lean();

/**
 * Try failed messages again.
 *   auto = true   the sweep: healable causes only, ≤ 3 tries per message, backing off.
 *   auto = false  the Super Admin's bulk button: healable causes, no try budget.
 */
const retryFailed = async({ sinceHours = AUTO_WINDOW_HOURS, auto = false, limit = 50 } = {}) => {
    const NotificationLog = require('./notificationLog.model');
    const notificationService = require('./notification.service');
    const summary = { checked: 0, retried: 0, sent: 0, stillFailed: 0, skipped: 0, permanent: 0, waitingForEmail: 0 };

    const rows = await candidates(NotificationLog, { sinceHours, limit });
    for (const row of rows) {
        summary.checked += 1;
        if (!isHealable(row)) { summary.permanent += 1; continue; }
        if (row.channel === 'email' && health.email.ok === false) { summary.waitingForEmail += 1; continue; }

        const root = await rootOf(NotificationLog, row);
        const tries = Number((root.autoRetry && root.autoRetry.count) || 0);
        if (auto) {
            if (tries >= MAX_AUTO_RETRIES) { summary.skipped += 1; continue; }
            const last = root.autoRetry && root.autoRetry.lastAt ? new Date(root.autoRetry.lastAt).getTime() : 0;
            // 10 min, then 30, then 90 between automatic tries.
            if (last && Date.now() - last < SWEEP_MINUTES * 60 * 1000 * Math.pow(3, tries - 1)) { summary.skipped += 1; continue; }
        }

        await NotificationLog.updateOne(
            { _id: root._id },
            { $set: { 'autoRetry.lastAt': new Date() }, $inc: { 'autoRetry.count': 1 } }
        ).catch(() => null);

        let result = null;
        try {
            result = await notificationService.retryLog(String(row._id));
        } catch (err) {
            result = { outcome: { success: false, error: err && err.message } };
        }
        summary.retried += 1;
        if (result && result.skipped) summary.skipped += 1;
        else if (result && result.outcome && result.outcome.success) summary.sent += 1;
        else summary.stillFailed += 1;

        // Gentle on the providers: one message at a time.
        await new Promise((r) => setTimeout(r, 400));
    }

    if (summary.retried) logger.info(auto ? 'Automatic notification retry' : 'Bulk notification retry', summary);
    return summary;
};

/* ---------------------------------------------------------------- schedule */

let timers = [];

const start = () => {
    if (timers.length) return;
    checkEmail().catch(() => null);
    const h = setInterval(() => { checkEmail().catch(() => null); }, HEALTH_MINUTES * 60 * 1000);
    timers.push(h);
    if (autoRetryEnabled()) {
        const r = setInterval(() => {
            retryFailed({ auto: true }).catch((err) => logger.warn('Automatic retry sweep failed', { error: err && err.message }));
        }, SWEEP_MINUTES * 60 * 1000);
        timers.push(r);
        // First sweep shortly after boot, once the health check has answered.
        const first = setTimeout(() => {
            retryFailed({ auto: true }).catch(() => null);
        }, 90 * 1000);
        timers.push(first);
    }
    timers.forEach((t) => t && t.unref && t.unref());
};

const stop = () => { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); timers = []; };

module.exports = {
    start, stop, checkEmail, getHealth, retryFailed, isHealable,
    // for tests
    HEALABLE, PERMANENT, MAX_AUTO_RETRIES, AUTO_WINDOW_HOURS,
};

