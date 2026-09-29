const config = require('../../config');
const logger = require('../../config/logger');
const botbeeService = require('./botbee.service');
const metaCloudService = require('./metaCloud.service');

/**
 * Which provider sends an approved TEMPLATE, and nothing else.
 *
 * ONE DECISION, IN ONE PLACE. `notification.service` sends templates from two
 * paths -- the lifecycle dispatch and the retry-a-failed-row path -- and both
 * must reach the same provider. Two `if (config.metaCloud.isConfigured)` checks
 * would be two chances to get it wrong, and the symptom would be a member who
 * receives a correct message the first time and a row of dashes on the retry.
 *
 * The rule: Meta when it has a token, BotBee otherwise.
 *
 *   BotBee's `/send/template` reports success and renders every variable as a
 *   literal `-` -- measured to exhaustion on 7 Sep 2026, see
 *   `notificationTemplates.js`. So the moment a Meta token exists it is
 *   strictly better, and no flag should have to be remembered to prefer it.
 *
 *   With no token, BotBee is all there is. A template with dashes in it still
 *   reaches a member outside the 24-hour window, and reaching them badly beats
 *   not reaching them.
 *
 * FREE TEXT IS NOT ROUTED HERE. Session replies, the keyword bot and the
 * inbound webhook stay on BotBee unconditionally -- Meta delivers inbound
 * events to exactly one webhook URL and that URL is BotBee's. Call sites that
 * send text keep calling `botbee.service` directly, and this module has no
 * `sendTextMessage` so that boundary cannot blur.
 */

/**
 * The one shape a template parameter is allowed to have.
 *
 * WHATSAPP REJECTS THE WHOLE MESSAGE OVER A LINE BREAK. Meta answers error
 * 131009 — "Parameter value is not valid" — for a body parameter containing a
 * newline, a tab, or more than four consecutive spaces, and refuses an empty
 * one. The message is not delivered, and nothing about the failure names the
 * offending character: the log row says the parameter is invalid and an
 * operator is left comparing four values that all look fine in a terminal.
 *
 * The values here are FREE TEXT A HUMAN TYPED — an event title pasted out of a
 * poster, a venue with its address on a second line, a rejection reason written
 * in a textarea. Every one of those arrives with newlines in it eventually, and
 * the event that carries it is the approval or the rejection the member has
 * been waiting on. So this is applied at the single point both send paths go
 * through — the lifecycle dispatch and the retry-a-failed-row path — rather
 * than trusted to every builder in `notificationTemplates` remembering.
 *
 * An empty slot becomes an en dash rather than staying empty, because a
 * template with a hole in it still reaches the member and a refused one does
 * not. 1024 characters is Meta's per-parameter ceiling.
 */
const sanitizeParams = (params = []) =>
    (Array.isArray(params) ? params : [params]).map((value) => {
        const text = String(value === null || value === undefined ? '' : value)
            // Every run of whitespace — newline, tab, the four-space rule — to a
            // single space in one pass, which is the only form Meta accepts.
            .replace(/\s+/g, ' ')
            .trim();

        if (!text) return '–';
        return text.length > 1024 ? `${text.slice(0, 1023)}…` : text;
    });

/** The service that will handle the next template send. */
const provider = () => (metaCloudService.isConfigured() ? metaCloudService : botbeeService);

/** `'meta'` or `'botbee'` -- for the diagnostics script and the log rows. */
const providerName = () => (metaCloudService.isConfigured() ? 'meta' : 'botbee');

/**
 * Send one approved template.
 *
 * The signature is `botbee.service.sendTemplateMessage`'s, unchanged, because
 * the call sites predate the split and there is nothing to gain from making
 * them care. The result carries `provider` so the oversight screen can say
 * which one answered -- without it, a token added on a Friday would change
 * where every message comes from with nothing in the log to show it.
 */
const sendTemplateMessage = async(phone, templateName, params = [], languageCode = 'en', textFallback = '', options = {}) => {
    const chosen = provider();
    const name = providerName();
    const safeParams = sanitizeParams(params);

    const result = await chosen.sendTemplateMessage(phone, templateName, safeParams, languageCode, textFallback, options);

    /*
     * A Meta failure is NOT retried through BotBee.
     *
     * The tempting fallback is wrong: BotBee's template send is the thing known
     * to be broken, so falling back to it turns a loud, diagnosable Meta error
     * -- a bad token, an unapproved template, a parameter-count mismatch, all of
     * which name themselves and carry an `fbtrace_id` -- into a delivered
     * message full of dashes and a green row. The failure is recorded and the
     * session text still goes; that is the honest outcome.
     */
    if (!result.success && name === 'meta') {
        logger.warn('Meta template send failed and was NOT retried through BotBee', {
            template: templateName, error: result.error
        });
    }

    return { ...result, provider: name };
};

/** Whether any provider can send a template at all. */
const isConfigured = () => metaCloudService.isConfigured() || botbeeService.isConfigured();

module.exports = { sendTemplateMessage, sanitizeParams, provider, providerName, isConfigured, config };
