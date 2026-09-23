const axios = require('axios');
const config = require('../../config');
const logger = require('../../config/logger');
const botbeeService = require('./botbee.service');

/**
 * Template sends, straight to Meta's WhatsApp Cloud API.
 *
 * WHAT THIS IS FOR. BotBee's `/send/template` accepts the variable values,
 * answers `status:"1"`, and delivers a literal `-` in every slot. That was
 * established on 7 Sep 2026 against roughly forty payload shapes, custom fields
 * written every way `/subscriber/update` accepts, and a SYSTEM field confirmed
 * stored on the subscriber before the send. It is a fault on their side of the
 * wire, and nothing written here or on the dashboard can reach it.
 *
 * Meta's API is the layer BotBee is built on, and `components` is the
 * documented way to fill a template body. Going direct removes the broken hop
 * and nothing else.
 *
 * ---------------------------------------------------------------------------
 * TEMPLATES ONLY. Free text stays on BotBee.
 * ---------------------------------------------------------------------------
 *
 * The inbound webhook, the keyword bot, the 24-hour session replies and the
 * dashboard all live on BotBee, and Meta will deliver inbound events to exactly
 * one webhook URL. Moving the session traffic here would mean re-pointing that
 * webhook, losing the dashboard, and rebuilding the bot -- to fix a half that is
 * not broken. `sendTextMessage` is deliberately absent from this file so the
 * question cannot be answered by accident.
 *
 * NOTHING HERE THROWS, for the same reason nothing in `botbee.service` does:
 * every caller is inside a registration, an approval or a payment, and a
 * messaging failure must not turn a completed approval into a 500 an admin
 * retries against a terminal status.
 *
 * THE RESULT SHAPE MATCHES `botbee.service.sendTemplateMessage` exactly --
 * `{ success, messageId, error, to, template }` -- because `notification.service`
 * logs whichever one answered into the same `NotificationLog` row. A provider
 * that returned a different shape would put `undefined` in the oversight
 * screen's id column and nobody would notice for weeks.
 */
class MetaCloudService {
    /** Whether a token and a phone number id are both present. */
    isConfigured() {
        return config.metaCloud.isConfigured;
    }

    /**
     * The E.164 digits Meta expects -- reusing BotBee's normaliser on purpose.
     *
     * It is the one that has been exercised against real sends, and it handles
     * the two Indian cases that actually occur: bare ten digits, and eleven with
     * a domestic trunk zero. A second normaliser here would be a second answer
     * to the same question, and the drift would surface as a member who is
     * messaged on one provider and not the other.
     */
    normalizePhoneNumber(phone) {
        return botbeeService.normalizePhoneNumber(phone);
    }

    /**
     * The locale Meta will accept for a template.
     *
     * The code sent MUST match the locale the template was approved under, or
     * Meta answers error 132001 -- "template name does not exist in the
     * translation". `en` and `en_US` are different templates as far as Meta is
     * concerned, and the templates on this account are `en_US`. BotBee reports
     * the locale on every template row, so the caller passes the real one
     * through; this only tidies the separator and supplies a default.
     */
    languageCode(locale) {
        const raw = String(locale || '').trim().replace('-', '_');
        if (!raw || raw === 'en') return 'en_US';
        return raw;
    }

    /**
     * Send an approved template, with its body variables filled.
     *
     * `templateParams` is positional -- Meta substitutes the numbered
     * placeholders in order and does not check what it is given, so the ORDER is
     * the contract. The caller has already trimmed or padded the list to the
     * template's real width; this sends what it is handed.
     *
     * `textFallback` is accepted and ignored. It exists so this can stand in for
     * `botbee.service.sendTemplateMessage` without the call site changing shape
     * -- Meta has no equivalent of BotBee's "attach the session text to the same
     * request" behaviour, and inventing one here would send a second message the
     * caller did not ask for.
     */
    async sendTemplateMessage(phoneNumber, templateName, templateParams = [], languageCode = 'en_US', textFallback = '') { // eslint-disable-line no-unused-vars
        const phone = this.normalizePhoneNumber(phoneNumber);
        if (!phone) return { success: false, error: 'No usable WhatsApp number' };
        if (!templateName) return { success: false, error: 'Template name is required' };

        const params = (Array.isArray(templateParams) ? templateParams : [templateParams])
            .map((value) => String(value === null || value === undefined ? '' : value));

        if (!this.isConfigured()) {
            logger.info('[WHATSAPP NOT SENT - Meta Cloud API not configured]', {
                to: phone, template: templateName, params
            });
            return { success: true, mock: true, messageId: `mock-meta-${Date.now()}`, to: phone };
        }

        const { baseUrl, apiVersion, phoneNumberId, accessToken, timeoutMs } = config.metaCloud;
        const url = `${baseUrl}/${apiVersion}/${phoneNumberId}/messages`;

        const template = {
            name: templateName,
            language: { code: this.languageCode(languageCode) }
        };

        /*
         * A TEMPLATE WITH NO VARIABLES MUST CARRY NO `components` KEY.
         *
         * Meta rejects an empty `parameters` array with error 132000 -- "number
         * of parameters does not match the expected number of params" -- so a
         * variable-free template sent with an empty body component fails
         * outright, while the same template sent with the key omitted succeeds.
         * The distinction is between "no parameters" and "a parameter list that
         * happens to be empty", and Meta treats them as different requests.
         */
        if (params.length) {
            template.components = [{
                type: 'body',
                parameters: params.map((text) => ({ type: 'text', text }))
            }];
        }

        const body = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'template',
            template
        };

        try {
            const response = await axios.post(url, body, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: timeoutMs,
                // Meta puts the useful part of a failure in the body, and a
                // thrown 400 would hide it behind a stack trace.
                validateStatus: () => true
            });

            const data = response.data || {};

            /*
             * Meta reports failure in `error`, and it is the only place to look.
             * A 200 carrying an `error` object does not occur on this endpoint,
             * but checking the body first costs nothing and means a future change
             * in their status codes cannot turn a refusal into a logged success
             * -- which is exactly the failure mode BotBee has.
             */
            if (data.error || response.status < 200 || response.status >= 300) {
                const err = data.error || {};
                const message = err.error_user_msg || err.message || `HTTP ${response.status}`;
                logger.error('Meta Cloud API template send failed', {
                    to: phone,
                    template: templateName,
                    status: response.status,
                    code: err.code,
                    subcode: err.error_subcode,
                    // Meta support cannot investigate without this.
                    fbtrace_id: err.fbtrace_id,
                    error: message
                });
                return {
                    success: false,
                    error: String(message),
                    status: response.status,
                    to: phone,
                    template: templateName,
                    data
                };
            }

            const messageId = (Array.isArray(data.messages) && data.messages[0] && data.messages[0].id)
                || `meta-${Date.now()}`;

            logger.info('Meta Cloud API template sent', { to: phone, template: templateName, messageId });
            return { success: true, messageId, to: phone, template: templateName, data };
        } catch (error) {
            const message = (error.response && error.response.data && error.response.data.error
                && error.response.data.error.message)
                || error.message
                || 'Request failed';

            logger.error('Meta Cloud API request failed', {
                to: phone, template: templateName, error: message
            });
            return { success: false, error: String(message), to: phone, template: templateName };
        }
    }
}

module.exports = new MetaCloudService();
