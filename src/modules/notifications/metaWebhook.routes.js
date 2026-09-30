const crypto = require('crypto');
const express = require('express');
const config = require('../../config');
const logger = require('../../config/logger');
const deliveryStatus = require('./deliveryStatus.service');

/**
 * Meta WhatsApp Cloud API webhook — DELIVERY STATUSES ONLY.
 *
 *   GET  /api/v1/notifications/meta/webhook   the one-time verification handshake
 *   POST /api/v1/notifications/meta/webhook   status callbacks (sent/delivered/read/failed)
 *
 * WHY A SECOND WEBHOOK. Templates are sent straight to Meta (metaCloud.service),
 * and Meta reports what became of each message to the webhook configured on
 * the Meta APP. That URL is BotBee's today, so the statuses reach this server
 * only if BotBee relays them (handled on the BotBee route too). Pointing a Meta
 * app's `messages` webhook field here makes delivery tracking independent of
 * the relay. This route never replies to anybody — inbound MESSAGES stay with
 * BotBee and the keyword bot; a message posted here is ignored.
 *
 * Mounted ABOVE the `businessRoutes` auth gate in routes.js (Meta holds no ACTIV
 * token). Answers 200 to anything it can authenticate, so Meta does not retry.
 *
 * AUTHENTICITY. With META_APP_SECRET set, the `X-Hub-Signature-256` HMAC over
 * the raw body is REQUIRED (app.js keeps the raw body for this path). Without
 * it the callbacks are accepted — they can only annotate a log row, never send
 * or change a booking — and a warning says the secret is missing.
 */
const router = express.Router();

router.get('/webhook', (req, res) => {
    const q = req.query || {};
    const expected = config.metaCloud.webhookVerifyToken;
    if (!expected) return res.status(503).send('META_WEBHOOK_VERIFY_TOKEN is not configured');
    if (q['hub.mode'] && q['hub.mode'] !== 'subscribe') return res.status(400).send('Unsupported hub.mode');
    if (q['hub.verify_token'] !== expected) return res.status(403).send('Verification token mismatch');
    logger.info('Meta webhook verified');
    return res.status(200).send(String(q['hub.challenge'] || ''));
});

/** Constant-time check of Meta's `sha256=<hex>` signature. */
const signatureOk = (req) => {
    const secret = config.metaCloud.appSecret;
    if (!secret) return true;
    const header = String(req.get('x-hub-signature-256') || '');
    const raw = req.rawBody;
    if (!header.startsWith('sha256=') || !raw) return false;
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const a = Buffer.from(header.slice(7), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

let warnedNoSecret = false;

router.post('/webhook', (req, res) => {
    if (!signatureOk(req)) {
        logger.warn('Meta webhook refused: signature does not verify');
        return res.status(401).json({ received: false });
    }
    if (!config.metaCloud.appSecret && !warnedNoSecret) {
        warnedNoSecret = true;
        logger.warn('META_APP_SECRET is not set; Meta status callbacks are accepted unsigned');
    }

    res.status(200).json({ received: true });

    Promise.resolve()
        .then(() => deliveryStatus.applyFromWebhook(req.body || {}))
        .catch((error) => logger.error('Meta status callback failed', { error: error && error.message }));
});

module.exports = router;
