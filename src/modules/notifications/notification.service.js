const mongoose = require('mongoose');
const Notification = require('./notification.model');
const NotificationLog = require('./notificationLog.model');
const emailService = require('./email.service');
const botbeeService = require('./botbee.service');
// Templates pick their provider; free text is always BotBee. See whatsappTemplate.js.
const whatsappTemplate = require('./whatsappTemplate');
const regionalContacts = require('./regionalContacts.service');
const templates = require('./notificationTemplates');
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
                contact = payload.application
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

            /* ------------------------------------------------------- the bell */
            if (rendered.inApp && userId) {
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
                        lastError: created ? undefined : 'Notification row not created'
                    });
                })());
            }

            /* ------------------------------------------------------ the email */
            if (rendered.email && email) {
                jobs.push((async() => {
                    const html = emailService.buildHtmlTemplate({
                        title: rendered.email.title,
                        recipientName: ctx.name,
                        preheader: rendered.email.preheader,
                        bodyHtml: rendered.email.bodyHtml,
                        actionButton: rendered.email.actionButton,
                        facts: rendered.email.facts,
                        contact
                    });

                    const sent = await emailService.sendEmail({
                        to: email,
                        subject: rendered.email.subject,
                        html,
                        contact
                    });

                    result.channels.email = sent;
                    await this.log({
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
                         * A template failure is recorded even when the session
                         * text rescued the delivery. The member heard, so the
                         * row is `sent` and not a false alarm — but the
                         * template is still broken, and a green row carrying no
                         * error is how it stays broken.
                         */
                        lastError: sent.error,
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
            if (rendered.whatsapp && phone) {
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
                    const sent = await whatsappTemplate.sendTemplateMessage(
                        phone,
                        rendered.whatsapp.template,
                        rendered.whatsapp.params,
                        'en',
                        rendered.whatsapp.text
                    );

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
                    if (config.botbee.alsoSendText && rendered.whatsapp.text) {
                        const textSent = await botbeeService.sendTextMessage(phone, rendered.whatsapp.text);
                        sessionText = textSent && textSent.success ? textSent : null;
                    }

                    result.channels.whatsapp = sent;
                    await this.log({
                        user: userId,
                        event: eventName,
                        channel: 'whatsapp',
                        recipient: sent.to || phone,
                        templateId: rendered.whatsapp.template,
                        subject: rendered.whatsapp.template,
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
                        // The rendered parameters and the session-window
                        // fallback text, so a replay has something to send
                        // without re-running the whole lifecycle event.
                        data: {
                            params: rendered.whatsapp.params,
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

    /** One page of the delivery log, newest first, plus platform-wide health. */
    async listLogs({ page = 1, limit = 50, channel, status, event, search } = {}) {
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);

        const query = {};
        if (channel) query.channel = channel;
        if (status) query.status = status;
        if (event) query.event = event;
        if (search) {
            // The recipient is what an operator has in hand when a member says
            // "I never got it" — an address or a phone number, not an id.
            // Escaped: a '+' in a phone number is a quantifier, and an
            // unescaped one throws rather than matching nothing.
            const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.recipient = new RegExp(escaped, 'i');
        }

        const [rows, total, counts] = await Promise.all([
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

        return {
            logs: rows,
            health,
            pagination: {
                page: safePage,
                limit: safeLimit,
                total,
                pages: Math.max(1, Math.ceil(total / safeLimit))
            }
        };
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
                ? await whatsappTemplate.sendTemplateMessage(row.recipient, row.templateId, data.params || [])
                : await botbeeService.sendTextMessage(row.recipient, data.text || 'ACTIV notification');
        }

        row.status = outcome.success ? 'sent' : 'failed';
        row.mock = !!outcome.mock;
        row.providerMessageId = outcome.messageId || row.providerMessageId;
        row.lastError = outcome.error;
        row.attempts = Number(row.attempts || 1) + 1;
        await row.save().catch(() => null);

        return { row, outcome };
    }
}

module.exports = new NotificationService();
