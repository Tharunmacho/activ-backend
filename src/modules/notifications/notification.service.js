const mongoose = require('mongoose');
const Notification = require('./notification.model');
const NotificationLog = require('./notificationLog.model');
const emailService = require('./email.service');
const botbeeService = require('./botbee.service');
// Templates pick their provider; free text is always BotBee. See whatsappTemplate.js.
const whatsappTemplate = require('./whatsappTemplate');
const regionalContacts = require('./regionalContacts.service');
const templates = require('./notificationTemplates');
const {
    EFFECTIVE_STATUS_EXPR, buildLogQuery, withEffectiveStatus, summarise, matchLegacyRows
} = require('./deliveryQuery');
const logger = require('../../config/logger');
const config = require('../../config');

class NotificationService {
    async createNotification(userId, { title, message, type = 'info', data }) {
        const notification = new Notification({ user: userId, title, message, type, data });
        await notification.save();
        return notification;
    }

    /**
     * Write a notification, but never let it break the thing that triggered it.
     *
     * Every caller is inside an action that matters far more than the bell icon
     * — approving an application, recording a payment. A notification is a
     * side-effect, so a bad id, a validation error or a momentarily unreachable
     * database resolves to `null` and is logged, rather than turning a completed
     * approval into a 500 the admin will retry against a now-terminal state.
     */
    async safeCreate(userId, { title, message, type = 'info', data } = {}) {
        try {
            const id = userId && userId._id ? userId._id : userId;
            if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
            if (!title || !message) return null;

            return await this.createNotification(id, { title, message, type, data });
        } catch (error) {
            logger.warn('Notification not created', {
                userId: String(userId || ''),
                title,
                error: error && error.message
            });
            return null;
        }
    }

    async getUserNotifications(userId, page = 1, limit = 20) {
        const skip = (page - 1) * limit;

        /*
         * THREE ROUND TRIPS BECAME ONE.
         *
         * The page, the total and the unread count are three independent
         * questions about the same filter, and none of them reads another's
         * answer — they were simply three awaits in a row. Against this
         * cluster every round trip costs 400–500ms whatever it asks for, so
         * the bell was logged at 1,504ms for a list of ten rows.
         *
         * `.lean()` on the page as well: these are read and serialised and
         * nothing calls a method on them, so hydrating 10 Mongoose documents
         * is work with no reader.
         */
        const [notifications, total, unread] = await Promise.all([
            Notification.find({ user: userId })
                .skip(skip)
                .limit(limit)
                .sort({ createdAt: -1 })
                .lean(),
            Notification.countDocuments({ user: userId }),
            Notification.countDocuments({ user: userId, isRead: false }),
        ]);

        return { notifications, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, unread };
    }

    async markAsRead(userId, notificationId) {
        const notification = await Notification.findOneAndUpdate({ _id: notificationId, user: userId }, { isRead: true }, { new: true });
        return notification;
    }

    async markAllAsRead(userId) {
        await Notification.updateMany({ user: userId, isRead: false }, { isRead: true });
        return true;
    }

    // ======================================================================
    //  Lifecycle dispatch — bell + email + WhatsApp, from one call
    // ======================================================================

    /**
     * Write one delivery attempt to the audit trail. Never throws.
     *
     * The log is the ONLY evidence that a message was attempted: an email that
     * bounces and a WhatsApp template that was never approved both leave nothing
     * behind on the member's account. A logging failure must not become the
     * reason an approval reports an error — the message has already been sent by
     * the time this runs — so it swallows and warns.
     */
    async log(entry = {}) {
        try {
            const userId = entry.user && entry.user._id ? entry.user._id : entry.user;

            return await NotificationLog.create({
                user: userId && mongoose.Types.ObjectId.isValid(String(userId)) ? userId : undefined,
                event: entry.event || 'CUSTOM',
                channel: entry.channel,
                recipient: String(entry.recipient || 'unknown'),
                sender: entry.sender,
                replyTo: entry.replyTo,
                templateId: entry.templateId,
                subject: entry.subject,
                status: entry.status,
                mock: !!entry.mock,
                providerMessageId: entry.providerMessageId,
                lastError: entry.lastError,
                // Delivery tracking and the booking it belongs to — see the model.
                provider: entry.provider,
                deliveryStatus: entry.deliveryStatus,
                statusHistory: entry.deliveryStatus
                    ? [{ status: entry.deliveryStatus, at: new Date(), detail: entry.deliveryStatus === 'failed' ? String(entry.lastError || '').slice(0, 500) : undefined }]
                    : undefined,
                failedAt: entry.deliveryStatus === 'failed' ? new Date() : undefined,
                failureReason: entry.deliveryStatus === 'failed' ? String(entry.lastError || '').slice(0, 1000) || undefined : undefined,
                bookingRef: entry.bookingRef ? String(entry.bookingRef).toUpperCase() : undefined,
                eventId: entry.eventId ? String(entry.eventId) : undefined,
                eventTitle: entry.eventTitle,
                recipientName: entry.recipientName,
                templatePath: entry.templatePath,
                resendOf: entry.resendOf && mongoose.Types.ObjectId.isValid(String(entry.resendOf)) ? entry.resendOf : undefined,
                data: entry.data
            });
        } catch (error) {
            logger.warn('Notification log row not written', {
                event: entry.event, channel: entry.channel, error: error && error.message
            });
            return null;
        }
    }

    /**
     * Send one lifecycle event on every channel the recipient can be reached on.
     *
     * ---------------------------------------------------------------- contract
     *
     * NEVER THROWS, AND NEVER REJECTS. Every call site is inside something that
     * matters far more than the message: a registration, a tier approval, a
     * completed payment. Two of those are irreversible by the time this runs — a
     * final approval writes four member documents in one transaction and lands
     * in a terminal state that refuses retries, and a payment has already moved
     * money. If this function could throw, one unguarded `await` would turn a
     * completed approval into a 500 the admin retries against a status that now
     * rejects it, leaving the member with no member record. So the whole body is
     * wrapped, each channel settles independently, and the worst outcome
     * possible is three rows in `NotificationLog` marked failed.
     *
     * CHANNELS RUN CONCURRENTLY AND SETTLE INDEPENDENTLY. `allSettled`, not
     * `all`: a member with no phone number must still get the email, and an SMTP
     * timeout must not cancel a WhatsApp message that was going to succeed.
     *
     * ------------------------------------------------------------- addressing
     *
     * `application`, or the recipient's own region, resolves the applicant's
     * Block/District/State administrator, and that admin's real email becomes
     * the `Reply-To`. It is resolved ONCE, here, and handed to the email
     * renderer — so the header, the footer line naming the office and the
     * WhatsApp "HELP" answer cannot name three different administrators.
     *
     * @param {string} eventName  a key of `notificationTemplates.TEMPLATES`
     * @param {object} recipient  { id, name, email, phone, state, district, block }
     * @param {object} payload    event-specific values (reference, reason, amount…)
     * @returns {Promise<{ event, channels, contact }>} always resolves
     */
    async dispatchLifecycleEvent(eventName, recipient = {}, payload = {}) {
        const result = {
            event: eventName,
            channels: { in_app: null, email: null, whatsapp: null },
            // The log rows written, by channel — a resend reports the new one.
            rows: {},
            contact: null
        };

        try {
            const name = String(recipient.name || '').trim();
            const firstName = name.split(/\s+/).filter(Boolean)[0] || '';
            const email = String(recipient.email || '').trim();
            /*
             * The WhatsApp number, when the member gave one, and the phone
             * number otherwise.
             *
             * They are the same for most members and deliberately separate for
             * the ones they are not: someone whose SIM is a work number but
             * whose WhatsApp is a personal handset would otherwise be messaged
             * on a number that has no WhatsApp on it, and the send would fail
             * for a reason nothing on the failure row explains.
             */
            const phone = String(recipient.whatsappNumber || recipient.whatsapp || recipient.phoneNumber || recipient.phone || '').trim();
            const userId = recipient.id && recipient.id._id ? recipient.id._id : recipient.id;


            /*
             * The applicant's own regional office, resolved before anything is
             * rendered because the From display name is built from it.
             *
             * A failure here must not skip the message: a member still needs to
             * know their application was approved even if the admin roster is
             * momentarily unreachable. `resolveForRegion` already swallows its
             * own errors and falls back to the support desk.
             */
            let contact = null;
            try {
                /*
                 * `noRegionalContact`: a message TO an admin (a new file in their
                 * queue). Routing its replies to the applicant's regional office —
                 * which may be that same admin — would be a loop; it goes to the
                 * support desk instead.
                 */
                if (payload.noRegionalContact) contact = null;
                else contact = payload.application
                    ? await regionalContacts.resolveForApplication(payload.application)
                    : await regionalContacts.resolveForRegion({
                        state: recipient.state,
                        district: recipient.district,
                        block: recipient.block
                    });
            } catch (error) {
                logger.warn('Regional contact could not be resolved for a notification', {
                    event: eventName, error: error && error.message
                });
            }
            result.contact = contact;

            const ctx = {
                ...payload,
                name: name || 'Member',
                firstName: firstName || 'Member',
                email,
                phone,
                state: recipient.state || (contact && contact.region.state) || '',
                district: recipient.district || (contact && contact.region.district) || '',
                block: recipient.block || (contact && contact.region.block) || '',
                /*
                 * The office this member can reach, for the "Need help?" block
                 * every membership message ends with — the SAME office the
                 * email's Reply-To and footer name, resolved once above, so the
                 * WhatsApp message and the email cannot point at two people.
                 */
                /*
                 * ONE admin supplies all three: the first tier (block, district,
                 * state) whose admin has a phone on file. None has one -> all
                 * three blank, and the template prints ACTIV's own office as a
                 * set. Never a region's name beside another person's number.
                 */
                officeName: contact && contact.reachable
                    ? `${[contact.reachable.regionName, contact.reachable.tierLabel].filter(Boolean).join(' ')} Admin`
                    : '',
                officePhone: (contact && contact.reachable && contact.reachable.phone) || '',
                officeEmail: (contact && contact.reachable && contact.reachable.email) || '',
                /*
                 * Free text from an admin, pre-escaped for the one template that
                 * drops it straight into markup. The raw value stays on `reason`
                 * for the plain-text and WhatsApp renderings, which need no
                 * escaping and would otherwise show `&amp;` to a member.
                 */
                reasonHtml: payload.reason ? emailService.escape(payload.reason) : '',
                eventTitleHtml: payload.eventTitle ? emailService.escape(payload.eventTitle) : ''
            };

            const rendered = templates.render(eventName, ctx);
            if (!rendered) {
                logger.warn('No notification template for event', { event: eventName });
                return result;
            }

            const jobs = [];

            /*
             * What every log row of this dispatch carries: the booking and event
             * it was about, and the person's name — so the Super Admin can find
             * "every message to this booker" without knowing their address.
             */
            const about = payload.data || {};
            const trace = {
                bookingRef: about.bookingRef || payload.bookingRef || undefined,
                eventId: about.eventId || payload.eventId || undefined,
                eventTitle: payload.eventTitle || undefined,
                recipientName: name || undefined,
                resendOf: payload.resendOf || undefined
            };
            /*
             * A RESEND names one channel (`onlyChannel`): the Super Admin pressed
             * Resend on one failed WhatsApp row, and the booker must not also get
             * a second email and a second bell entry for it.
             */
            const only = payload.onlyChannel || '';

            /* ------------------------------------------------------- the bell */
            if (rendered.inApp && userId && !only) {
                jobs.push((async() => {
                    const created = await this.safeCreate(userId, {
                        title: rendered.inApp.title,
                        message: rendered.inApp.message,
                        type: rendered.inApp.type,
                        data: { event: eventName, ...(payload.data || {}) }
                    });

                    result.channels.in_app = { success: !!created };
                    await this.log({
                        user: userId,
                        event: eventName,
                        channel: 'in_app',
                        recipient: String(userId),
                        subject: rendered.inApp.title,
                        status: created ? 'sent' : 'failed',
                        providerMessageId: created ? String(created._id) : undefined,
                        lastError: created ? undefined : 'Notification row not created',
                        ...trace
                    });
                })());
            }

            /* ------------------------------------------------------ the email */
            if (rendered.email && email && (!only || only === 'email')) {
                jobs.push((async() => {
                    /*
                     * A QR TICKET, when the email asks for one (`ticketQr` = the
                     * address it opens): drawn here, embedded inline as
                     * `cid:ticket-qr` inside the booking-ID stub. A failure to
                     * draw it only drops the code, never the email.
                     */
                    const inlineImages = [];
                    let highlight = rendered.email.highlight;
                    if (rendered.email.ticketQr && highlight) {
                        try {
                            const QRCode = require('qrcode');
                            const content = await QRCode.toBuffer(String(rendered.email.ticketQr), {
                                type: 'png', width: 336, margin: 1, errorCorrectionLevel: 'M',
                                color: { dark: '#000000', light: '#ffffff' }
                            });
                            inlineImages.push({ cid: 'ticket-qr', filename: 'ticket-qr.png', content });
                            highlight = { ...highlight, qrSrc: 'cid:ticket-qr' };
                        } catch (qrError) {
                            logger.warn('Ticket QR not drawn', { event: eventName, error: qrError && qrError.message });
                        }
                    }
                    /*
                     * ENTRY PASSES (several seats): one QR per participant, as
                     * `cid:pass-qr-<n>` inside the template's passes block. A
                     * code that cannot be drawn is dropped; the email still goes.
                     */
                    if (Array.isArray(rendered.email.passQrs)) {
                        const QRCode = require('qrcode');
                        for (const qr of rendered.email.passQrs.slice(0, 50)) {
                            if (!qr || !qr.cid || !qr.url) continue;
                            try {
                                const content = await QRCode.toBuffer(String(qr.url), {
                                    type: 'png', width: 280, margin: 1, errorCorrectionLevel: 'M',
                                    color: { dark: '#000000', light: '#ffffff' }
                                });
                                inlineImages.push({ cid: String(qr.cid), filename: `${qr.cid}.png`, content });
                            } catch (qrError) {
                                logger.warn('Entry pass QR not drawn', { event: eventName, error: qrError && qrError.message });
                            }
                        }
                    }

                    const html = emailService.buildHtmlTemplate({
                        title: rendered.email.title,
                        recipientName: ctx.name,
                        preheader: rendered.email.preheader,
                        bodyHtml: rendered.email.bodyHtml,
                        actionButton: rendered.email.actionButton,
                        secondaryButton: rendered.email.secondaryButton,
                        facts: rendered.email.facts,
                        tone: rendered.email.tone,
                        badge: rendered.email.badge,
                        highlight,
                        poster: rendered.email.poster,
                        afterHtml: rendered.email.afterHtml,
                        contact
                    });

                    const sent = await emailService.sendEmail({
                        to: email,
                        subject: rendered.email.subject,
                        html,
                        contact,
                        inlineImages,
                        files: rendered.email.fileAttachments || []
                    });

                    result.channels.email = sent;
                    result.rows.email = await this.log({
                        user: userId,
                        event: eventName,
                        channel: 'email',
                        recipient: email,
                        sender: sent.sender,
                        replyTo: sent.replyTo,
                        subject: rendered.email.subject,
                        status: sent.success ? 'sent' : 'failed',
                        mock: !!sent.mock,
                        providerMessageId: sent.messageId,
                        /*
                         * SMTP ACCEPTED OR REFUSED, with the server's own words
                         * ("Invalid login: 535 …"). Email has no delivery
                         * receipt, so `accepted` is the furthest it can go.
                         */
                        lastError: sent.error,
                        provider: 'smtp',
                        deliveryStatus: sent.mock ? undefined : (sent.success ? 'accepted' : 'failed'),
                        ...trace,
                        data: {
                            recipientName: ctx.name,
                            bodyHtml: rendered.email.bodyHtml,
                            region: contact && contact.region,
                            adminTier: contact && contact.nearest && contact.nearest.tier
                        }
                    });
                })());
            }

            /* --------------------------------------------------- the WhatsApp */
            if (rendered.whatsapp && rendered.whatsapp.template && phone && (!only || only === 'whatsapp')) {
                jobs.push((async() => {
                    /*
                     * BOTH ARE SENT, AND THE TEMPLATE'S OUTCOME IS THE OUTCOME.
                     *
                     * BotBee's `/send/template` answers `status:"1"` and then
                     * delivers every variable as a literal `-`. That has been
                     * tested to exhaustion: about forty payload shapes, custom
                     * fields written through `/subscriber/update`, and a SYSTEM
                     * field (`first_name`) that was verified as stored via
                     * `/subscriber/get` — the rendered message was `-` in every
                     * case. The provider does not substitute on this route.
                     *
                     * So the session text is not a duplicate for the sake of it:
                     * it is the only one of the two that arrives with the
                     * member's name in it, because this code interpolates that
                     * string itself and BotBee never parses it. It is also NOT a
                     * replacement, because free text is legal only inside the
                     * 24-hour window a member's own message opens — a new
                     * registrant has no such window and the template is all that
                     * can reach them.
                     *
                     * A previous revision sent the text only when the template
                     * FAILED. The template never fails; it succeeds and renders
                     * dashes. That silently switched off the only readable
                     * message the member was getting.
                     *
                     * `sent` therefore stays the TEMPLATE's result and is what
                     * the log row records. Letting the text's result overwrite
                     * it — which is what this did — filed a green "sent" row
                     * under the template's name against a template that had
                     * rendered nothing, leaving the one screen that could report
                     * the fault insisting there wasn't one.
                     *
                     * `BOTBEE_ALSO_SEND_TEXT=false` turns the second message off
                     * the day substitution starts working.
                     */
                    let sessionText = null;
                    let sent = await whatsappTemplate.sendTemplateMessage(
                        phone,
                        rendered.whatsapp.template,
                        rendered.whatsapp.params,
                        'en',
                        rendered.whatsapp.text,
                        // The poster, for a template created with an image
                        // header. The generic fallback below has none.
                        { headerImage: rendered.whatsapp.headerImage || '' }
                    );

                    /*
                     * A detailed template that Meta refused — still in review,
                     * renamed, or its variable count changed — is retried ONCE
                     * through the generic approved one the builder names as
                     * `fallback`. The failure is kept on the result so the log
                     * row still says the detailed template is broken.
                     */
                    /*
                     * The fallback is a CHAIN (custom -> approved poster ->
                     * generic), each step carrying its own poster header or
                     * none. Walked until one is accepted.
                     */
                    let tried = rendered.whatsapp.template;
                    // The values that went WITH the template that went — a
                    // retry must replay those, not the first step's.
                    let usedParams = rendered.whatsapp.params;
                    let usedHeader = rendered.whatsapp.headerImage || '';
                    let fb = rendered.whatsapp.fallback;
                    const refused = [];
                    while (!sent.success && fb && fb.template) {
                        if (fb.template !== tried) {
                            refused.push(`"${tried}": ${sent.error}`);
                            logger.warn('WhatsApp template refused; trying the next one', {
                                event: eventName, template: tried, next: fb.template, error: sent.error
                            });
                            sent = await whatsappTemplate.sendTemplateMessage(
                                phone, fb.template, fb.params, 'en', rendered.whatsapp.text,
                                { headerImage: fb.headerImage || '' }
                            );
                            tried = fb.template;
                            usedParams = fb.params;
                            usedHeader = fb.headerImage || '';
                        }
                        fb = fb.fallback;
                    }
                    if (sent.success && refused.length) {
                        sent = { ...sent, error: `Sent on "${tried}" after ${refused.join('; ')}` };
                    }

                    /*
                     * WHICH PATH, in words: richer templates skipped because the
                     * event lacks a value they print, templates Meta refused, and
                     * the one that went. Logged here and kept on the row.
                     */
                    const skippedSteps = Array.isArray(rendered.whatsapp.skipped) ? rendered.whatsapp.skipped : [];
                    const templatePath = [
                        ...skippedSteps,
                        ...refused.map((r) => `refused ${r}`),
                        sent.success ? `sent on "${tried}"` : `failed on "${tried}"`
                    ].join(' | ').slice(0, 2000);
                    if (skippedSteps.length) {
                        logger.info('WhatsApp template chosen without inventing missing values', {
                            event: eventName, bookingRef: trace.bookingRef, templatePath
                        });
                    }

                    /*
                     * THE FREE TEXT IS A FALLBACK, NOT A SECOND COPY.
                     *
                     * It used to be sent unconditionally, right after the
                     * template, and its result then replaced the template's.
                     * Two things came of that, and the second is the serious
                     * one:
                     *
                     *   A member inside an open session window received the
                     *   same fact twice, thirty seconds apart, worded
                     *   differently — the template and then the text.
                     *
                     *   The log row kept the template's NAME and the text
                     *   send's outcome and message id. A template that failed
                     *   — not approved, wrong parameter count, rendering every
                     *   variable as `-` — was recorded as a green "sent" row
                     *   against the template that did not send, and the only
                     *   surface that could have reported the fault was the one
                     *   asserting it had worked. That is the exact failure this
                     *   module is built to make impossible, reintroduced one
                     *   line at a time.
                     *
                     * So the template's outcome is the outcome, and the text is
                     * attempted only when the template did not go. Outside the
                     * 24-hour window the text cannot send either, which is not
                     * a regression: nothing was ever going to reach a brand-new
                     * registrant through it.
                     */
                    if (config.botbee.alsoSendText && rendered.whatsapp.text && !sent.success) {
                        const textSent = await botbeeService.sendTextMessage(phone, rendered.whatsapp.text);
                        sessionText = textSent && textSent.success ? textSent : null;
                        /*
                         * ITS OWN ROW. It is a separate message with its own
                         * provider id: kept only as a flag on the template's
                         * row, its failure reason was thrown away and the status
                         * webhook could never match its id, so the Super Admin
                         * could not tell whether the rescue itself worked.
                         */
                        result.rows.whatsappText = await this.log({
                            user: userId,
                            event: eventName,
                            channel: 'whatsapp',
                            recipient: (textSent && textSent.to) || phone,
                            subject: 'Session text (template fallback)',
                            status: textSent && textSent.success ? 'sent' : 'failed',
                            mock: !!(textSent && textSent.mock),
                            providerMessageId: textSent && textSent.messageId,
                            lastError: textSent && !textSent.success ? (textSent.error || 'Not sent') : undefined,
                            provider: 'botbee',
                            deliveryStatus: textSent && textSent.mock ? undefined : (textSent && textSent.success ? 'accepted' : 'failed'),
                            ...trace,
                            data: { text: rendered.whatsapp.text, fallbackFor: sent.template || rendered.whatsapp.template }
                        });
                    }

                    result.channels.whatsapp = sent;
                    result.rows.whatsapp = await this.log({
                        user: userId,
                        event: eventName,
                        channel: 'whatsapp',
                        recipient: sent.to || phone,
                        templateId: sent.template || rendered.whatsapp.template,
                        subject: sent.template || rendered.whatsapp.template,
                        status: sent.success ? 'sent' : 'failed',
                        mock: !!sent.mock,
                        providerMessageId: sent.messageId,
                        /*
                         * A template failure is recorded even when the session
                         * text rescued the delivery. The member heard, so the
                         * row is `sent` and not a false alarm — but the
                         * template is still broken, and a green row carrying no
                         * error is how it stays broken.
                         */
                        lastError: sent.error,
                        provider: sent.provider,
                        // Meta's API answer is `accepted`; what happens on the
                        // handset arrives later through the status webhook.
                        deliveryStatus: sent.mock ? undefined : (sent.success ? 'accepted' : 'failed'),
                        templatePath,
                        ...trace,
                        // The rendered parameters and the session-window
                        // fallback text, so a replay has something to send
                        // without re-running the whole lifecycle event.
                        data: {
                            // The SENT template's values and header, so a
                            // replay of this row is the same message.
                            params: usedParams,
                            headerImage: usedHeader || undefined,
                            firstParams: rendered.whatsapp.params,
                            text: rendered.whatsapp.text,
                            // Whether the readable copy also went, and its own
                            // id. Recorded rather than merged into the row
                            // above, so neither send can stand in for the other.
                            sessionText: sessionText
                                ? { sent: true, messageId: sessionText.messageId }
                                : { sent: false }
                        }
                    });
                })());
            }

            await Promise.allSettled(jobs);
            return result;
        } catch (error) {
            // The guarantee in the doc comment above. Nothing escapes.
            logger.error('Lifecycle notification dispatch failed', {
                event: eventName,
                error: error && error.message,
                stack: error && error.stack
            });
            return result;
        }
    }

    /**
     * Fire and forget, for a caller that must not even wait.
     *
     * `dispatchLifecycleEvent` already cannot throw, so this exists only to drop
     * the latency: three network calls should not sit between a member pressing
     * Pay and seeing their receipt. The `.catch` is belt and braces — there is
     * no path that rejects, and an unhandled rejection would take the process
     * down under Node's default policy, which is not a risk worth carrying for
     * a notification.
     */
    dispatchInBackground(eventName, recipient = {}, payload = {}) {
        this.dispatchLifecycleEvent(eventName, recipient, payload)
            .catch((error) => logger.error('Background notification dispatch failed', {
                event: eventName, error: error && error.message
            }));
    }

    // ======================================================================
    //  Super Admin oversight
    // ======================================================================

    /**
     * One page of the delivery log, newest first, plus platform-wide health —
     * and, for the Super Admin's Automation view, the counts of the FILTERED
     * set by what actually happened to each message.
     *
     * Filters (all optional): channel, status (legacy sent/failed/queued),
     * delivery (accepted/sent/delivered/read/failed/mock), event, group
     * (automation | booking | membership), eventId, bookingRef, from / to
     * (YYYY-MM-DD, IST days, inclusive), search (recipient, name, booking ref,
     * subject, event title).
     */
    async listLogs({
        page = 1, limit = 50, channel, status, event, search,
        delivery, group, eventId, bookingRef, from, to
    } = {}) {
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);

        const query = buildLogQuery({ channel, status, event, search, delivery, group, eventId, bookingRef, from, to });
        /*
         * THE TILES' SCOPE: the same filters WITHOUT the status ("delivery")
         * and channel picks. Those two only narrow the LIST. Counted from the
         * full query, tapping "Failed" made "Sent" read 0 — the tiles then
         * described the filter instead of the automation.
         */
        const tileQuery = buildLogQuery({ status, event, search, group, eventId, bookingRef, from, to });

        const [rows, total, counts, filtered, events] = await Promise.all([
            NotificationLog.find(query)
                .sort({ createdAt: -1 })
                .skip((safePage - 1) * safeLimit)
                .limit(safeLimit)
                .lean(),
            NotificationLog.countDocuments(query),
            /*
             * Health totals for the WHOLE log, not for this page and not for
             * this filter. "12 failed" is only meaningful against everything,
             * and computing it from the filtered set would make the number
             * change as an operator narrows the view looking for the failures.
             */
            NotificationLog.aggregate([
                { $group: { _id: { status: '$status', mock: '$mock' }, n: { $sum: 1 } } }
            ]).catch(() => []),
            // The Automation view's tiles: the category / event / dates / search, by effective status (see tileQuery).
            NotificationLog.aggregate([
                { $match: tileQuery },
                { $group: { _id: { channel: '$channel', s: EFFECTIVE_STATUS_EXPR }, n: { $sum: 1 } } }
            ]).catch(() => []),
            // Events that have messages, for the event filter.
            NotificationLog.aggregate([
                { $match: { eventId: { $exists: true, $nin: ['', null] } } },
                { $sort: { createdAt: 1 } },
                { $group: { _id: '$eventId', title: { $last: '$eventTitle' }, count: { $sum: 1 }, last: { $max: '$createdAt' } } },
                { $sort: { last: -1 } },
                { $limit: 200 }
            ]).catch(() => [])
        ]);

        const health = { sent: 0, failed: 0, queued: 0, mock: 0, total: 0 };
        for (const row of counts || []) {
            const n = Number(row.n || 0);
            const key = row._id || {};
            health.total += n;
            // A mock row is a successful no-op, not a delivery. Counting it as
            // `sent` would tell a Super Admin that members were emailed on a
            // deployment that has no mail server configured at all.
            if (key.mock) health.mock += n;
            else if (health[key.status] !== undefined) health[key.status] += n;
        }

        const blank = () => ({ total: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, mock: 0, queued: 0 });
        const tally = { total: 0, delivery: blank(), byChannel: { email: blank(), whatsapp: blank(), in_app: blank() } };
        for (const row of filtered || []) {
            const n = Number(row.n || 0);
            const { channel: ch, s } = row._id || {};
            tally.total += n;
            if (tally.delivery[s] !== undefined) tally.delivery[s] += n;
            if (tally.byChannel[ch]) {
                tally.byChannel[ch].total += n;
                if (tally.byChannel[ch][s] !== undefined) tally.byChannel[ch][s] += n;
            }
        }
        delete tally.delivery.total;

        return {
            logs: (rows || []).map(withEffectiveStatus),
            health,
            counts: tally,
            events: (events || []).map((e) => ({ eventId: String(e._id), title: e.title || 'Untitled event', count: e.count })),
            pagination: {
                page: safePage,
                limit: safeLimit,
                total,
                pages: Math.max(1, Math.ceil(total / safeLimit))
            }
        };
    }

    /**
     * Every automated message about ONE booking — to the booker, each
     * participant, and each document — newest first, plus the latest status
     * per channel. Rows written before delivery tracking carry no
     * `bookingRef`; they are matched by address (`matchLegacyRows`).
     */
    async bookingDelivery(bookingRef) {
        const ref = String(bookingRef || '').trim().toUpperCase();
        if (!ref) return { bookingRef: '', rows: [], summary: {} };
        const map = await this.deliveryRowsForBookings([ref]);
        const rows = (map.get(ref) || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return { bookingRef: ref, rows: rows.map(withEffectiveStatus), summary: summarise(rows) };
    }

    /** Latest status per channel for many bookings at once — the bookings table's column. */
    async deliverySummary(bookingRefs = []) {
        const refs = [...new Set((Array.isArray(bookingRefs) ? bookingRefs : String(bookingRefs || '').split(','))
            .map((r) => String(r || '').trim().toUpperCase()).filter(Boolean))].slice(0, 200);
        const map = await this.deliveryRowsForBookings(refs);
        const summaries = {};
        refs.forEach((ref) => { summaries[ref] = summarise(map.get(ref) || []); });
        return { summaries };
    }

    /** `Map<bookingRef, rows[]>` for the given refs — tracked rows and legacy matches. */
    async deliveryRowsForBookings(refs = []) {
        const out = new Map(refs.map((r) => [r, []]));
        if (!refs.length) return out;

        const tracked = await NotificationLog.find({
            $or: [{ bookingRef: { $in: refs } }, { 'data.bookingRef': { $in: refs } }],
            channel: { $in: ['email', 'whatsapp'] }
        }).sort({ createdAt: -1 }).limit(5000).lean().catch(() => []);
        const seen = new Set();
        for (const row of tracked || []) {
            const ref = String(row.bookingRef || (row.data && row.data.bookingRef) || '').toUpperCase();
            if (out.has(ref)) { out.get(ref).push(row); seen.add(String(row._id)); }
        }

        const legacy = await matchLegacyRows(refs).catch(() => new Map());
        legacy.forEach((rows, ref) => rows.forEach((row) => {
            if (seen.has(String(row._id)) || !out.has(ref)) return;
            seen.add(String(row._id));
            out.get(ref).push({ ...row, matchedBy: 'recipient' });
        }));
        return out;
    }

    /**
     * Send one logged row again.
     *
     * Re-sends from what the ROW recorded rather than re-running the lifecycle
     * event that produced it. Re-running would re-read an application that has
     * since moved on and deliver a message about a stage the member has already
     * passed — and for `in_app` it would write a second bell entry for something
     * that happened once. What failed to leave the building is the stored
     * subject, body and template parameters, and that is what gets another try.
     */
    async retryLog(logId) {
        if (!mongoose.Types.ObjectId.isValid(String(logId || ''))) return null;

        const row = await NotificationLog.findById(logId);
        if (!row) return null;

        // An in-app row has no external provider to retry against: the
        // notification either exists on the member's account or it does not.
        if (row.channel === 'in_app') {
            return { row, skipped: true, reason: 'In-app notifications are not re-sent' };
        }

        const data = row.data || {};
        let outcome;

        /*
         * AN EVENT-BOOKING MESSAGE IS REBUILT FROM THE BOOKING, not replayed.
         *
         * Its email is a designed ticket (details card, QR, notes) that the
         * stored `bodyHtml` alone does not reproduce, and its WhatsApp template
         * has a poster header the bare replay below never sent — so a replayed
         * row was a different, broken message. `resendLoggedMessage` sends the
         * real one on this row's channel, to this row's person, as a NEW row;
         * this row records that it was re-sent and by which row.
         */
        /*
         * TWO ROWS CANNOT BE RE-SENT, BY DESIGN. Neither stores its body: the
         * reset link is single-use and the welcome email carried a generated
         * password that exists nowhere else. The honest answer is the action
         * that produces a fresh one.
         */
        if (row.event === 'PASSWORD_RESET') {
            return { row, skipped: true, reason: 'A reset link cannot be re-sent — ask them to press "Forgot password" again for a new one.' };
        }
        if (row.event === 'ADMIN_WELCOME') {
            return { row, skipped: true, reason: 'The welcome email held a one-time password that is not stored. Set a new password for this admin in Manage Admins.' };
        }

        /* Donation mail is rebuilt from the donation / donor, as a new row. */
        if (row.event === 'DONATION_RECEIPT' || row.event === 'DONATION_STATEMENT') {
            const donationModule = require('../donations/donation.service');
            const Donor = require('../donations/donor.model');
            let result;
            if (row.event === 'DONATION_RECEIPT') {
                const Donation = require('../donations/donation.model');
                const donation = mongoose.Types.ObjectId.isValid(String(data.donationId || ''))
                    ? await Donation.findById(data.donationId).lean().catch(() => null) : null;
                if (!donation) return { row, skipped: true, reason: 'The donation this receipt belongs to was not found.' };
                result = await donationModule.sendReceiptEmail(donation);
            } else {
                const donor = mongoose.Types.ObjectId.isValid(String(data.donorId || ''))
                    ? await Donor.findById(data.donorId).lean().catch(() => null) : null;
                if (!donor) return { row, skipped: true, reason: 'The donor this statement belongs to was not found.' };
                result = await donationModule.sendStatementEmail(donor, data.financialYear);
            }
            row.attempts = Number(row.attempts || 1) + 1;
            if (result && result.logId) row.resentAs = result.logId;
            await row.save().catch(() => null);
            const fresh = result && result.logId ? await NotificationLog.findById(result.logId).catch(() => null) : null;
            return {
                row: fresh || row,
                outcome: { success: !!(result && result.sent), error: result && !result.sent ? (result.error || 'Not sent') : undefined }
            };
        }

        if (/^EVENT_(BOOKING|PARTICIPANT|DOCUMENT)_/.test(String(row.event || ''))) {
            const bookingService = require('../events/eventbooking.service');
            const resent = await bookingService.resendLoggedMessage(row.toObject ? row.toObject() : row);
            /*
             * Booking gone (or never findable — rows logged before the booking
             * reference was recorded): the message itself was stored, so send
             * THAT rather than refusing. A booking that exists but no longer
             * supports the message (cancelled, unpaid) is still refused — a
             * confirmation for a seat that is not held must not go out.
             */
            const bookingMissing = resent.skipped && /could not be found/i.test(String(resent.reason || ''));
            if (resent.skipped && !(bookingMissing && row.channel === 'email' && data.bodyHtml)) {
                return { row, skipped: true, reason: resent.reason };
            }
            if (!resent.skipped) {
                row.attempts = Number(row.attempts || 1) + 1;
                if (resent.row && resent.row._id) row.resentAs = resent.row._id;
                await row.save().catch(() => null);
                return { row: resent.row || row, outcome: resent.outcome || { success: false, error: 'Not sent' } };
            }
            // …falls through to the stored-email replay below.
        }

        if (row.channel === 'email') {
            const html = emailService.buildHtmlTemplate({
                title: row.subject || 'ACTIV',
                recipientName: data.recipientName || 'Member',
                preheader: row.subject,
                bodyHtml: data.bodyHtml
                    || '<p style="margin:0 0 12px 0;">Re-sending an earlier ACTIV notification.</p>',
                contact: null
            });

            outcome = await emailService.sendEmail({
                to: row.recipient,
                subject: row.subject || 'ACTIV notification',
                html,
                // The address this was routed to the first time, not a fresh
                // lookup: the member replied to a message from that office, and
                // re-resolving could point the retry somewhere else after a
                // staffing change.
                replyTo: row.replyTo
            });
        } else {
            outcome = row.templateId
                // The header the template was approved with, when recorded —
                // Meta refuses an image-header template sent without one.
                ? await whatsappTemplate.sendTemplateMessage(row.recipient, row.templateId, data.params || [], 'en', '', {
                    headerImage: data.headerImage || '',
                    headerDocument: data.headerDocument || undefined
                })
                : await botbeeService.sendTextMessage(row.recipient, data.text || 'ACTIV notification');
        }

        row.status = outcome.success ? 'sent' : 'failed';
        row.mock = !!outcome.mock;
        row.providerMessageId = outcome.messageId || row.providerMessageId;
        row.lastError = outcome.error;
        row.attempts = Number(row.attempts || 1) + 1;
        // A replay is a new message: its delivery starts again from `accepted`.
        if (!outcome.mock) {
            row.deliveryStatus = outcome.success ? 'accepted' : 'failed';
            row.statusHistory = [...(row.statusHistory || []), { status: row.deliveryStatus, at: new Date(), detail: outcome.success ? 'Re-sent' : String(outcome.error || '').slice(0, 500) }];
            row.failureReason = outcome.success ? undefined : String(outcome.error || '').slice(0, 1000);
        }
        await row.save().catch(() => null);

        return { row, outcome };
    }
}

module.exports = new NotificationService();
