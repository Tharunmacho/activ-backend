const express = require('express');
const logger = require('../../config/logger');
const webhookService = require('./botbeeWebhook.service');

/**
 * The BotBee inbound webhook — the ONE unauthenticated notification route.
 *
 * ------------------------------------------------------------- why a separate
 * ------------------------------------------------------------- router file
 *
 * BotBee holds no ACTIV token and there is no way to give it one, so these two
 * endpoints have to be reachable without a session. Everything in
 * `notification.routes.js` sits behind `router.use(verifyToken)`, and
 * `routes.js` mounts `businessRoutes` at '/' with its own internal
 * `verifyToken`, which makes it a catch-all auth gate for every route
 * registered AFTER it — the same trap documented for `/regions` in CLAUDE.md.
 *
 * So this router exists to be mounted ABOVE that line. Put these two paths
 * inside `notification.routes.js` instead and every delivery BotBee makes gets
 * a 401: the bot goes silent, the provider's dashboard shows failing deliveries,
 * and nothing in this application logs a thing, because the request never
 * reaches it.
 *
 * ------------------------------------------------------------------- 200s
 *
 * Both handlers answer 200 for anything that is not an authentication failure,
 * including a payload this code could not parse. A webhook that answers 500 is
 * one the provider RETRIES, and a retried inbound message is a second WhatsApp
 * reply to a member who sent one message. An unparseable body is logged and
 * acknowledged.
 */
const router = express.Router();

/**
 * GET — the handshake performed once, when the webhook URL is saved on BotBee.
 *
 * Echoes `hub.challenge` back as PLAIN TEXT when the shared secret matches.
 * `res.send(string)` and not `res.json`: the verifier compares the raw body to
 * the challenge it sent, and a JSON-quoted string does not match.
 */
router.get('/webhook', (req, res) => {
    const result = webhookService.verifyChallenge(req.query || {});

    if (!result.ok) {
        logger.warn('BotBee webhook verification refused', {
            status: result.status,
            reason: result.body
        });
        return res.status(result.status).send(result.body);
    }

    logger.info('BotBee webhook verified');
    return res.status(200).send(result.body);
});

/**
 * POST — an inbound WhatsApp message.
 *
 * Acknowledged IMMEDIATELY, before the reply is composed. Providers time these
 * out in a few seconds and retry on a slow response, and composing a reply
 * involves a member lookup, an application lookup and an admin-roster read.
 * Answering first and working afterwards is what stops a slow database turning
 * one member's "STATUS" into four identical replies.
 */
router.post('/webhook', (req, res) => {
    res.status(200).json({ received: true });

    // Deliberately not awaited — see above. `handleInbound` never rejects, and
    // the `.catch` is there so that a future change to it cannot take the
    // process down with an unhandled rejection.
    Promise.resolve()
        .then(() => webhookService.handleInbound(req.body || {}))
        .then((result) => {
            if (result && result.handled) {
                logger.info('WhatsApp bot replied', {
                    command: result.command,
                    identified: result.identified,
                    delivered: !!(result.sent && result.sent.success)
                });
            }
        })
        .catch((error) => {
            logger.error('WhatsApp bot failed to handle an inbound message', {
                error: error && error.message
            });
        });
});

module.exports = router;
