const axios = require('axios');
const config = require('../../config');
const logger = require('../../config/logger');
const templates = require('./notificationTemplates');

/**
 * Outbound WhatsApp, through BotBee.
 *
 * THE REQUEST SHAPE IS CONFIGURATION. The endpoint path and the way the token is
 * presented come from `config.botbee`, which reads them from `.env`. That is not
 * over-engineering: this integration is written against BotBee's documented API,
 * and if any part of it differs on the account actually being used, the failure
 * mode is a WhatsApp message that nobody receives and nothing on screen that
 * says so. A `.env` line is a fix that can be applied in the minute the problem
 * is noticed; a service-file patch is a deploy. `buildRequest()` is exported so
 * `scripts/test-notifications.js` can print the exact URL, headers and body
 * before a single member is messaged.
 *
 * NOTHING HERE THROWS. Every caller is inside a registration, an approval or a
 * payment. A WhatsApp send is a side effect of those, and an unreachable
 * provider must resolve to `{ success: false }` that gets logged, not reject
 * into a call stack where one unguarded `await` turns a completed approval into
 * a 500 the admin retries against a terminal status.
 *
 * MOCK MODE IS LABELLED. With no token the service logs the message and returns
 * `{ success: true, mock: true }`. The `mock` flag reaches the `NotificationLog`
 * row and the Super Admin screen, so "delivered" and "there is no WhatsApp
 * provider configured" stay distinguishable — a bare `success: true` erases that
 * difference, which is how a deployment convinces itself it is messaging people.
 */
class BotBeeService {
    /** Whether real messages can be sent at all. */
    isConfigured() {
        return config.botbee.isConfigured;
    }

    /**
     * A number WhatsApp will accept: digits only, country code included.
     *
     * WhatsApp identifies a recipient by an E.164 number with no `+`, no spaces
     * and no punctuation. Indian numbers reach this system in every shape a form
     * allows — `98765 43210`, `+91-98765-43210`, `098765 43210` — and the two
     * that actually matter are the bare ten digits (add the country code) and
     * the eleven digits with a domestic trunk `0` in front (drop it, then add
     * the code). Sending `0987654321` prefixed with 91 produces a real-looking
     * number belonging to somebody else, so the trunk zero is stripped BEFORE
     * the length is judged.
     *
     * Returns '' for anything that cannot be made into a plausible number, and
     * the caller reports that rather than dialling a guess.
     */
    normalizePhoneNumber(phone) {
        let digits = String(phone === null || phone === undefined ? '' : phone).replace(/\D/g, '');
        if (!digits) return '';

        const cc = String(config.botbee.defaultCountryCode || '91');

        // 00 91 ... — the international prefix written out.
        if (digits.startsWith('00')) digits = digits.slice(2);

        // Domestic trunk zero on a bare national number: 0 98765 43210.
        if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

        // Bare national number — prepend the country code.
        if (digits.length === 10) digits = cc + digits;

        /*
         * Too short to be a subscriber number anywhere. Deliberately checked
         * AFTER the two corrections above, so a valid ten-digit number is never
         * rejected for lacking a country code it was about to be given.
         */
        if (digits.length < 10 || digits.length > 15) return '';

        return digits;
    }

    /**
     * The exact HTTP call that will be made — URL, headers and body.
     *
     * Split out from the sending so it can be printed by the diagnostic script
     * and asserted by a test without a network call. Nothing about the request
     * is decided anywhere else.
     */
    buildRequest(kind, payloadFields) {
        const { baseUrl, apiToken, phoneNumberId, authStyle } = config.botbee;
        const path = kind === 'template'
            ? config.botbee.sendTemplatePath
            : config.botbee.sendTextPath;

        const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (authStyle === 'bearer' || authStyle === 'both') {
            headers.Authorization = `Bearer ${apiToken}`;
        }
        if (authStyle === 'header' || authStyle === 'both') {
            headers['X-API-Key'] = apiToken;
        }

        const body = { phone_number_id: phoneNumberId, ...payloadFields };
        if (authStyle === 'body' || authStyle === 'both') {
            body.apiToken = apiToken;
        }

        return { url, headers, body };
    }

    /** Headers with the token replaced, for logs and the diagnostic output. */
    redactHeaders(headers = {}) {
        const safe = { ...headers };
        if (safe.Authorization) safe.Authorization = 'Bearer ***';
        if (safe['X-API-Key']) safe['X-API-Key'] = '***';
        return safe;
    }

    /**
     * POST, and turn every outcome into the same resolved shape.
     *
     * A provider that answers 200 with `{ error: ... }` in the body is as failed
     * as one that answers 500, and both have to be recorded as failures or the
     * oversight screen reports delivery that did not happen.
     */
    async dispatch(kind, phone, payloadFields, describe) {
        const request = this.buildRequest(kind, payloadFields);

        try {
            const response = await axios.post(request.url, request.body, {
                headers: request.headers,
                timeout: config.botbee.timeoutMs,
                // Non-2xx is a result to inspect, not an exception to unwind:
                // the provider's own error message is the useful part and it
                // lives in the body.
                validateStatus: () => true
            });

            const data = response.data || {};

            /*
             * `status` IS THE VERDICT, AND IT IS A STRING.
             *
             * BotBee answers HTTP 200 to everything and carries the real outcome
             * in the body: `"status":"1"` for sent, `"status":"0"` for refused,
             * with the reason in `message`. Judging on the HTTP code alone —
             * which is what this did — records "Sending message outside 24 hour
             * window is not allowed", "Message template not found" and "Please
             * enter a valid mobile number" as SUCCESSFUL DELIVERIES. The Super
             * Admin screen then reports a green row for a message nobody
             * received, which is worse than no screen at all.
             *
             * Compared as a string against '0': `Number("0")` is falsy and so is
             * an absent field, so a numeric check would also condemn a response
             * that simply does not carry the key.
             */
            const refused = String(data.status) === '0';

            const ok = response.status >= 200 && response.status < 300
                && !refused
                && data.error === undefined
                && data.success !== false;

            if (!ok) {
                const error = data.message || data.error || `HTTP ${response.status}`;
                logger.error('BotBee WhatsApp send failed', {
                    to: phone, kind, describe, status: response.status, error
                });
                return { success: false, error: String(error), status: response.status, data };
            }

            /*
             * `wa_message_id` FIRST — it is WhatsApp's own id.
             *
             * It is the only value here that can be traced in BotBee's dashboard
             * or Meta's logs when somebody asks whether a message was really
             * delivered. The `botbee-<timestamp>` at the end is a fabrication of
             * last resort: it makes a log row look identified while pointing at
             * nothing, so it is reached only when the provider returned no id at
             * all.
             */
            const messageId = data.wa_message_id || data.message_id || data.messageId || data.id
                || (data.data && (data.data.wa_message_id || data.data.message_id || data.data.id))
                || `botbee-${Date.now()}`;

            logger.info('BotBee WhatsApp sent', { to: phone, kind, describe, messageId });
            return { success: true, messageId, data };
        } catch (error) {
            // Timeouts, DNS failures, TLS errors — everything the provider never
            // got the chance to answer.
            const message = (error.response && error.response.data
                && (error.response.data.message || error.response.data.error))
                || error.message
                || 'Request failed';

            logger.error('BotBee WhatsApp request failed', { to: phone, kind, describe, error: message });
            return { success: false, error: String(message) };
        }
    }

    /**
     * A pre-approved template — the only thing that can start a conversation.
     *
     * WhatsApp only permits free-form text within 24 hours of the member's last
     * message. Everything this platform sends unprompted — a welcome, a status
     * change, a payment request — is therefore a template, registered and
     * approved on the BotBee account beforehand. A template name that has not
     * been approved is rejected by the provider, and that rejection is recorded
     * as a failed row rather than swallowed, because it is fixed on their
     * dashboard and not in this code.
     */
    async sendTemplateMessage(phoneNumber, templateName, templateParams = [], languageCode = 'en', textFallback = '', options = {}) {
        const phone = this.normalizePhoneNumber(phoneNumber);
        if (!phone) return { success: false, error: 'No usable WhatsApp number' };
        if (!templateName) return { success: false, error: 'Template name is required' };

        const params = (Array.isArray(templateParams) ? templateParams : [templateParams])
            .map((value) => String(value === null || value === undefined ? '' : value));

        if (!this.isConfigured()) {
            logger.info('[WHATSAPP NOT SENT — BotBee not configured]', {
                to: phone, template: templateName, params
            });
            return { success: true, mock: true, messageId: `mock-botbee-${Date.now()}`, to: phone };
        }

        /*
         * BOTBEE ADDRESSES A TEMPLATE BY ITS OWN ROW ID, NOT BY ITS NAME.
         *
         * `/api/v1/whatsapp/send/template` answers "Message template not found."
         * to every request carrying `template_name` — including the exact name
         * of an APPROVED template on the account. It resolves only
         * `template_id`, and that id is BotBee's internal row id from
         * `/template/list`, not the Meta `template_id` field in the same row,
         * which is also refused.
         *
         * Worth stating plainly, because the failure is silent in the worst way:
         * HTTP 200, `status: "0"`, a human-readable message in the body, and no
         * message delivered. Sending the name — which is what this did, and what
         * every reasonable reading of the docs suggests — could never work.
         *
         * The NAME stays what the rest of the platform uses. A name is stable
         * across environments and a row id is not: the same template has a
         * different id on a second BotBee account, so putting ids in
         * `notificationTemplates.js` would tie the message copy to one tenant.
         */
        let resolved = await this.resolveTemplateId(templateName);
        let usedTemplate = templateName;
        let usedParams = params;

        /*
         * A TEMPLATE STILL IN REVIEW MUST NOT MEAN SILENCE.
         *
         * Meta approval happens outside this codebase, takes hours to days, and
         * is refused for reasons — a stray em dash, a category, a missing sample
         * value — that have nothing to do with whether the member should be told
         * their application was approved. Without this, every one of those hours
         * is a member who is told nothing on WhatsApp, and the only trace is a
         * failed row on a screen nobody is watching.
         *
         * So a missing template degrades to whichever general-purpose one IS
         * approved, with the parameters squeezed into its shape. Less precisely
         * worded than the template meant for the event; infinitely better than
         * nothing. `BOTBEE_FALLBACK_TEMPLATE=''` turns it off for a deployment
         * that would rather send nothing than send something generic.
         */
        if (!resolved.id) {
            const fallbackName = config.botbee.fallbackTemplate;

            if (fallbackName && fallbackName.toLowerCase() !== templateName.toLowerCase()) {
                const fallback = await this.resolveTemplateId(fallbackName);
                if (fallback.id) {
                    logger.warn('WhatsApp template missing — falling back', {
                        wanted: templateName, using: fallbackName, to: phone
                    });
                    resolved = fallback;
                    usedTemplate = fallbackName;
                    usedParams = templates.FALLBACK_TEMPLATE.adapt(params);
                }
            }
        }

        if (!resolved.id) {
            // Named plainly: this is fixed on the BotBee dashboard, not in code.
            const error = `WhatsApp template "${templateName}" is not on the BotBee account`
                + (resolved.available.length ? ` (account has: ${resolved.available.join(', ')})` : '');
            logger.error('BotBee template missing', { template: templateName, to: phone });
            return { success: false, error, to: phone };
        }

        /*
         * THE PARAMETER COUNT IS MADE TO MATCH THE TEMPLATE, NOT THE EVENT.
         *
         * Meta substitutes positionally and does not check. Send too FEW and the
         * member receives the literal placeholder — "Welcome to ACTIV, #1#!" —
         * which is the single most embarrassing way this integration can fail
         * and produces no error at all. Send too many and the provider rejects
         * the whole message. `variables` is read from the approved body on the
         * account, counting both `{{1}}` and BotBee's own `#1#` notation, so the
         * count compared against is what Meta will actually substitute.
         */
        if (typeof resolved.variables === 'number' && resolved.variables !== usedParams.length) {
            logger.warn('WhatsApp template parameter count adjusted', {
                template: usedTemplate, expects: resolved.variables, given: usedParams.length
            });

            const adjusted = usedParams.slice(0, resolved.variables);
            while (adjusted.length < resolved.variables) adjusted.push('');
            usedParams = adjusted;
        }

        const payload = {
            phone_number: phone,
            template_id: String(resolved.id),
            // Sent alongside for readability in BotBee's own logs. Harmless —
            // the endpoint ignores fields it does not use.
            template_name: usedTemplate,
            language: resolved.locale || languageCode
        };

        /*
         * BOTBEE SUBSTITUTES BY FIELD NAME, NOT BY POSITION.
         *
         * Its `variable_map` binds each slot of a template to a NAMED custom
         * field — the working templates on this account read
         * `{"body":{"1":"#name#","2":"#topic#"}}` — and the substitution engine
         * looks that name up when the message is sent. A template whose body was
         * typed as `#1#` binds slot 1 to a field called `1`, which exists
         * nowhere, so every slot renders as `-` no matter what the payload
         * carries. Twenty-five positional field names were tried against such a
         * template and all twenty-five produced `-`, which is the evidence for
         * this: the fault is in the binding, not the request.
         *
         * So when `BOTBEE_TEMPLATE_FIELDS` names the bound fields, the values go
         * out under those names — top level and inside `custom_fields`, because
         * which of the two the engine reads is still unverified and the endpoint
         * ignores what it does not recognise.
         *
         * With no field names configured it falls back to the positional
         * spellings. Those are right for a provider that works by position, and
         * harmless here.
         */
        if (usedParams.length) {
            /*
             * THE FIELD NAMES COME FROM THE TEMPLATE, NOT FROM `.env`.
             *
             * `variable_map` is fetched with every template row, so the account
             * itself says which field each slot is bound to — `#name#` on the
             * templates written through BotBee's own field picker, `#1#` on the
             * ACTIV ones, whose slots are bound to fields literally named `1`,
             * `2`, `3`. Reading it per template means one code path serves both
             * spellings, a template rebound on the dashboard needs no deploy,
             * and nothing has to be kept in step by hand.
             *
             * `BOTBEE_TEMPLATE_FIELDS` stays as an OVERRIDE for the case the
             * account cannot answer for — a binding the list endpoint does not
             * return — and is empty in normal operation.
             *
             * The numeric names are not a fallback shape invented here. They are
             * what these templates are actually bound to, and a WhatsApp
             * template cannot be edited within 24 hours of its last change nor
             * re-approved by Meta on any useful timescale, so the binding on the
             * account is the fixed point and this code is what moves.
             */
            const fields = config.botbee.templateFields.length
                ? config.botbee.templateFields
                : (resolved.fields && resolved.fields.length
                    ? resolved.fields
                    : usedParams.map((_, i) => String(i + 1)));

            const named = {};
            usedParams.forEach((value, i) => {
                const key = fields[i];
                if (key) named[key] = value;
            });

            /*
             * Under both spellings, in both places. `#1#` is how the field is
             * written INSIDE a template body and `1` is its name; which of the
             * two the send endpoint expects as a payload key is not documented
             * and cannot be told apart from a `-`, so both go, at the top level
             * and inside `custom_fields`. The endpoint ignores keys it does not
             * recognise, so the cost of the extra ones is bytes.
             */
            const hashed = {};
            Object.keys(named).forEach((key) => {
                hashed[`#${key.replace(/^#|#$/g, '')}#`] = named[key];
            });

            Object.assign(payload, named, hashed);
            payload.custom_fields = { ...named, ...hashed };

            /*
             * The positional arrays stay. They are what a provider that
             * substitutes by position would read, they have never been shown to
             * do harm here, and dropping them would make this change a wager on
             * one mechanism when the whole point is that the mechanism is not
             * documented.
             */
            const pinned = config.botbee.templateParamsField;
            if (pinned) {
                payload[pinned] = usedParams;
            } else {
                payload.template_data = usedParams;
                payload.body_params = usedParams;
                payload.params = usedParams;
            }
        }

        if (textFallback) {
            payload.message = textFallback;
        }

        /*
         * The poster for an image-header template. BotBee documents no field
         * for it, so it goes under each name its API has been seen to read;
         * unknown keys are ignored. Meta Cloud (metaCloud.service) is the
         * documented path and the one in use whenever META_ACCESS_TOKEN is set.
         */
        if (options && options.headerImage) {
            const link = String(options.headerImage);
            payload.media_url = link;
            payload.header_url = link;
            payload.header_media_url = link;
            payload.image_url = link;
            payload.media_type = 'image';
        }

        const result = await this.dispatch('template', phone, payload, usedTemplate);

        // `template` is what was actually sent, which is not always what was
        // asked for — the oversight screen must show the real one.
        return { ...result, to: phone, template: usedTemplate };
    }

    /**
     * The custom field each body slot is bound to, in slot order.
     *
     * BotBee returns `variable_map` on every template row as a JSON STRING:
     *
     *   {"header":[],"body":{"1":"#name#","2":"#topic#"},"button":[]}
     *   {"header":[],"body":{"1":"#1#","2":"#2#","3":"#3#"},"button":[]}
     *
     * The second is what the ACTIV templates carry, because their bodies were
     * typed as `#1#` rather than picked from the field list — so slot 1 is bound
     * to a field NAMED `1`. Either way the answer this returns is the list of
     * names the values have to be sent under, with the `#` markers stripped.
     *
     * Keys are sorted NUMERICALLY. `Object.keys` on `{"1":..,"10":..,"2":..}`
     * gives integer-like keys in ascending numeric order in practice, but the
     * ordering of string keys is not something to leave to chance when getting
     * it wrong puts the member's name where the amount belongs and reports
     * nothing. `meet_confirm` on this account has thirteen slots.
     *
     * Returns `[]` for anything unparseable — an empty list means "the account
     * did not say", which the caller distinguishes from a real answer.
     */
    parseVariableMap(variableMap) {
        if (!variableMap) return [];

        let parsed = variableMap;
        if (typeof parsed === 'string') {
            try {
                parsed = JSON.parse(parsed);
            } catch (error) {
                return [];
            }
        }

        const body = parsed && parsed.body;
        if (!body || Array.isArray(body) || typeof body !== 'object') return [];

        return Object.keys(body)
            .filter((key) => /^\d+$/.test(key))
            .sort((a, b) => Number(a) - Number(b))
            .map((key) => String(body[key] === null || body[key] === undefined ? '' : body[key])
                .trim()
                .replace(/^#|#$/g, ''))
            .filter((name) => name !== '');
    }

    /**
     * Turn an approved template's NAME into the row id BotBee will accept.
     *
     * Cached for five minutes, because it costs a round trip and the answer
     * changes only when somebody edits the templates on the dashboard. A MISS
     * busts the cache once and re-reads — which is what makes a template created
     * five minutes ago usable without restarting the API, and that is exactly
     * when this lookup is being done.
     *
     * Returns `{ id, locale, available }`. `available` is what the account DOES
     * have, so a mismatch reports the real list rather than only the absence.
     */
    async resolveTemplateId(templateName) {
        const wanted = String(templateName || '').trim().toLowerCase();
        if (!wanted) return { id: '', locale: '', available: [] };

        const fresh = async() => {
            const rows = await this.listTemplates();
            this._templates = { at: Date.now(), rows };
            return rows;
        };

        const cached = this._templates
            && Date.now() - this._templates.at < 5 * 60 * 1000
            && this._templates.rows;

        let rows = cached || await fresh();
        let hit = rows.find((r) => String(r.name || '').toLowerCase() === wanted);

        // A miss on cached data is re-checked live before it is called missing:
        // a template added since the last read is the likeliest cause.
        if (!hit && cached) {
            rows = await fresh();
            hit = rows.find((r) => String(r.name || '').toLowerCase() === wanted);
        }

        return {
            id: hit ? hit.id : '',
            locale: hit ? hit.locale : '',
            // How many variables the APPROVED body declares — what the caller
            // pads or trims its parameters to.
            variables: hit ? hit.variables : null,
            // The custom field each slot is bound to, in slot order. This is
            // what the values have to be sent under; see `sendTemplateMessage`.
            fields: hit ? hit.fields : [],
            available: rows.map((r) => r.name)
        };
    }

    /**
     * Every template on the account: `{ id, name, locale, category, variables }`.
     *
     * `variables` counts BOTH notations. BotBee's own editor writes `#1#` while a
     * template pasted from Meta carries `{{1}}`, and this account holds some of
     * each — counting one notation only reports an approved template as having
     * no variables, which hides a parameter-count mismatch that will render as
     * a placeholder in a real member's chat.
     *
     * Resolves to `[]` on any failure: a provider that cannot be reached must
     * not throw into the middle of a notification dispatch.
     */
    async listTemplates() {
        if (!this.isConfigured()) return [];

        try {
            const url = `${config.botbee.baseUrl}${config.botbee.templateListPath}`;
            const response = await axios.post(url, {
                apiToken: config.botbee.apiToken,
                phone_number_id: config.botbee.phoneNumberId
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: config.botbee.timeoutMs,
                validateStatus: () => true
            });

            const rows = (response.data && Array.isArray(response.data.message))
                ? response.data.message
                : [];

            return rows.map((row) => {
                const body = String(row.body_content || '');
                const numbers = [
                    ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])),
                    ...[...body.matchAll(/#(\d+)#/g)].map((m) => Number(m[1]))
                ];

                const fields = this.parseVariableMap(row.variable_map);

                return {
                    id: row.id,
                    name: row.template_name,
                    locale: row.locale,
                    category: row.template_category,
                    status: row.status,
                    headerType: row.header_type,
                    /*
                     * The BINDING wins over the body when the two disagree.
                     *
                     * `variable_map` is what the substitution engine actually
                     * reads; the body is the text it fills in. A body carrying
                     * `#name#` has no numbered placeholder to count at all, so
                     * the regex above reports zero variables for a template with
                     * five — and the parameter-count adjustment below would then
                     * trim every parameter away and send a template full of
                     * blanks.
                     */
                    variables: fields.length || (numbers.length ? Math.max(...numbers) : 0),
                    fields,
                    body
                };
            });
        } catch (error) {
            logger.warn('Could not read the BotBee template list', { error: error && error.message });
            return [];
        }
    }

    /**
     * Free-form text — only valid inside the 24-hour session window.
     *
     * Used by the inbound bot, which by definition is replying to a message the
     * member has just sent, so the window is open by construction.
     */
    async sendTextMessage(phoneNumber, messageText) {
        const phone = this.normalizePhoneNumber(phoneNumber);
        if (!phone) return { success: false, error: 'No usable WhatsApp number' };

        const text = String(messageText || '').trim();
        if (!text) return { success: false, error: 'Message text is required' };

        if (!this.isConfigured()) {
            logger.info('[WHATSAPP NOT SENT — BotBee not configured]', { to: phone, text });
            return { success: true, mock: true, messageId: `mock-botbee-text-${Date.now()}`, to: phone };
        }

        const result = await this.dispatch('text', phone, {
            phone_number: phone,
            message: text
        }, 'session-text');

        return { ...result, to: phone };
    }
}

module.exports = new BotBeeService();
