const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../../config/logger');

/**
 * Lifecycle email, addressed from the applicant's own regional office.
 *
 * ONE TRANSPORT DEFINITION, READ FROM `config.email`. This module used to read
 * `process.env` directly and asked for `EMAIL_PASS`, while `core/utils/mailer.js`
 * asked for `EMAIL_PASSWORD`. Pasting the credential into one of them left the
 * other permanently in mock mode, announcing it at `info` and otherwise looking
 * exactly like success. Both now read the same object, which accepts both
 * spellings, so there is no way to configure half the mail.
 *
 * ------------------------------------------------------------------ addressing
 *
 * `From` is the AUTHENTICATED address and `Reply-To` is the REGIONAL one, and
 * that split is deliberate. A mail provider will only send from an address the
 * account owns: Gmail answers 553 for an unverified alias, and a host that does
 * accept it produces an SPF/DMARC misalignment that files the message in spam.
 * `Reply-To` carries no such requirement — it is a routing hint to the reader's
 * client, not a claim of identity — so the applicant's reply reaches their block
 * admin's real inbox on day one, with no aliases to create first. The region is
 * still stated in the From DISPLAY NAME ("ACTIV Coimbatore District Office"), so
 * the applicant sees who is writing.
 *
 * `EMAIL_USE_REGIONAL_FROM=true` moves the region into the From address itself,
 * for a deployment that has verified the aliases. Off by default, because the
 * default has to be the one that works the moment a password is pasted in.
 *
 * ------------------------------------------------------------------ mock mode
 *
 * With no credentials the service logs what it WOULD have sent and reports
 * `{ success: true, mock: true }`. `mock` is on the result and recorded on the
 * log row, so the Super Admin oversight screen can distinguish "delivered" from
 * "there is no mail server configured" — a distinction a bare `success: true`
 * would erase, which is how an unconfigured deployment convinces itself it is
 * sending mail.
 */
class EmailService {
    constructor() {
        this.transporter = null;
        this.initialised = false;
    }

    /** Whether real mail can be sent at all. */
    isConfigured() {
        return config.email.isConfigured;
    }

    /**
     * Built once, lazily.
     *
     * `initialised` guards the FAILURE path as much as the success one: without
     * it a host that cannot be reached is re-created on every single send, and
     * the warning is logged once per notification rather than once per boot.
     */
    getTransporter() {
        if (this.initialised) return this.transporter;
        this.initialised = true;

        if (!this.isConfigured()) {
            logger.warn(
                'Email is not configured (EMAIL_HOST / EMAIL_USER / EMAIL_PASS); '
                + 'notification emails will be logged instead of sent'
            );
            return null;
        }

        try {
            this.transporter = nodemailer.createTransport({
                host: config.email.host,
                port: config.email.port,
                secure: config.email.secure,
                auth: { user: config.email.user, pass: config.email.password }
            });
        } catch (error) {
            logger.error('Failed to create the notification SMTP transport', {
                error: error && error.message
            });
            this.transporter = null;
        }

        return this.transporter;
    }

    /**
     * Prove the credentials before a member is ever messaged.
     *
     * Used by `scripts/test-notifications.js`. `verify()` performs the real
     * handshake and authentication, so a wrong app password fails here with the
     * provider's own error rather than on the first approval of the day.
     */
    async verifyConnection() {
        if (!this.isConfigured()) {
            return { ok: false, configured: false, error: 'EMAIL_HOST / EMAIL_USER / EMAIL_PASS not set' };
        }

        const transporter = this.getTransporter();
        if (!transporter) return { ok: false, configured: true, error: 'Transport could not be created' };

        try {
            await transporter.verify();
            return { ok: true, configured: true };
        } catch (error) {
            return { ok: false, configured: true, error: error && error.message };
        }
    }

    /**
     * The `From` and `Reply-To` for a message, given a resolved regional contact.
     *
     * `contact` is a `resolveForRegion()` result, or null for anything that is
     * not about a particular applicant. Everything about the identity of the
     * message is decided here and nowhere else, so the two headers cannot
     * disagree about which office is writing.
     */
    resolveSender(contact = null, overrideReplyTo = null) {
        const fromAddress = config.email.defaultFrom;
        const fromName = (contact && contact.fromName) || config.email.fromName;

        const replyTo = overrideReplyTo
            || (contact && contact.replyTo)
            || config.email.supportAddress
            || fromAddress;

        /*
         * The regional address is used as the envelope From only when the
         * deployment says its aliases are verified. Anything else is a message
         * the provider refuses to send or the recipient never sees.
         */
        const envelopeFrom = config.email.useRegionalFrom && contact && contact.replyTo
            ? contact.replyTo
            : fromAddress;

        return {
            fromEmail: envelopeFrom,
            fromName,
            fromHeader: `"${fromName}" <${envelopeFrom}>`,
            replyTo
        };
    }

    /**
     * Send one message. Resolves — never rejects.
     *
     * Every caller is inside something that matters more than the email: a
     * registration, an approval, a payment. A rejected promise here would have
     * to be caught at every one of those call sites, and the one place it was
     * forgotten would turn a completed, terminal approval into a 500 the admin
     * retries against a status that refuses retries.
     */
    async sendEmail({ to, subject, html, text, contact = null, replyTo = null, headers = {} }) {
        const recipient = String(to || '').trim();
        if (!recipient) {
            return { success: false, error: 'Recipient email address is required' };
        }
        if (!subject) {
            return { success: false, error: 'Subject is required' };
        }

        const sender = this.resolveSender(contact, replyTo);
        const transporter = this.getTransporter();

        const envelope = {
            recipient,
            sender: sender.fromHeader,
            replyTo: sender.replyTo
        };

        if (!transporter) {
            logger.info('[EMAIL NOT SENT — no SMTP configured]', { ...envelope, subject });
            return {
                success: true,
                mock: true,
                messageId: `mock-email-${Date.now()}`,
                ...envelope
            };
        }

        try {
            const info = await transporter.sendMail({
                from: sender.fromHeader,
                to: recipient,
                replyTo: sender.replyTo,
                subject,
                // A plain-text alternative is not decoration: a message with no
                // text part scores markedly worse with spam filters, and some
                // clients render nothing at all for HTML-only mail.
                text: text || this.htmlToText(html),
                html,
                headers
            });

            logger.info('Notification email sent', { ...envelope, messageId: info.messageId });
            return { success: true, messageId: info.messageId, ...envelope };
        } catch (error) {
            logger.error('Notification email failed', { ...envelope, error: error && error.message });
            return { success: false, error: error && error.message, ...envelope };
        }
    }

    /**
     * A readable text alternative, not a tag-stripped soup.
     *
     * Turning `<p>a</p><p>b</p>` into "ab" with a bare tag strip is what makes
     * the plain-text part unreadable; block boundaries become line breaks first,
     * and the handful of entities an HTML body actually contains are decoded so
     * the fallback does not read "&amp;" at a member.
     */
    htmlToText(html = '') {
        return String(html || '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
            .replace(/<li[^>]*>/gi, '• ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
    }

    /**
     * Escape anything that came from a person before it goes into HTML.
     *
     * Names, region names and rejection reasons are all free text typed by
     * somebody. A rejection reason containing `<` would otherwise break the
     * markup around it, and a crafted one would inject into an inbox.
     */
    escape(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * The one branded HTML shell.
     *
     * Table-based and inline-styled on purpose: every mail client of consequence
     * still discards `<style>` blocks and most of flexbox, so a layout that
     * renders in a browser is not evidence it renders in Outlook.
     *
     * `contact` prints the applicant's own regional office in the footer beside
     * the "reply to this email" line. That sentence is a promise about where the
     * reply goes, and naming the office is what makes it checkable rather than
     * something the reader has to take on trust.
     */
    buildHtmlTemplate({ title, recipientName, preheader, bodyHtml, actionButton, contact = null, facts = [] }) {
        const esc = (v) => this.escape(v);

        const buttonHtml = actionButton && actionButton.url ? `
            <tr><td style="padding: 8px 0 4px 0;">
              <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 20px auto 8px auto;">
                <tr><td align="center" bgcolor="#2563eb" style="border-radius: 8px;">
                  <a href="${esc(actionButton.url)}"
                     style="display: inline-block; padding: 14px 30px; font-family: Arial, Helvetica, sans-serif;
                            font-size: 15px; font-weight: bold; color: #ffffff; text-decoration: none; border-radius: 8px;">
                    ${esc(actionButton.label)}
                  </a>
                </td></tr>
              </table>
            </td></tr>` : '';

        /* Key/value pairs — a reference number, a region, a stage. */
        const factsHtml = (facts || []).filter((f) => f && f.value).length ? `
            <tr><td style="padding: 4px 0 0 0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-top: 8px;">
                ${(facts || []).filter((f) => f && f.value).map((f) => `
                  <tr>
                    <td style="padding: 10px 16px; font-family: Arial, Helvetica, sans-serif; font-size: 13px;
                               color: #64748b; white-space: nowrap;">${esc(f.label)}</td>
                    <td style="padding: 10px 16px; font-family: Arial, Helvetica, sans-serif; font-size: 14px;
                               color: #0f172a; font-weight: bold; text-align: right;">${esc(f.value)}</td>
                  </tr>`).join('')}
              </table>
            </td></tr>` : '';

        const office = contact && contact.nearest
            ? `<p style="margin: 0 0 6px 0; font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #475569;">
                 Replying to this email reaches your
                 <strong>${esc([contact.nearest.regionName, contact.nearest.tierLabel].filter(Boolean).join(' '))}
                 Admin</strong>${contact.nearest.name ? ` (${esc(contact.nearest.name)})` : ''} directly.
               </p>`
            : `<p style="margin: 0 0 6px 0; font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #475569;">
                 Reply to this email and it reaches the ACTIV support desk.
               </p>`;

        return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(title)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f1f5f9;">
  <!-- Preheader: the grey line a client shows beside the subject in the list.
       Left empty it is filled with whatever the first visible text happens to
       be, which on a templated message is the header lockup. -->
  <div style="display:none; font-size:1px; color:#f1f5f9; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">
    ${esc(preheader || title)}
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
    <tr><td align="center" style="padding: 32px 12px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden;
                    border:1px solid #e2e8f0;">

        <tr><td style="background-color:#1e3a8a; padding:26px 30px; text-align:center;">
          <table align="center" border="0" cellpadding="0" cellspacing="0" style="margin:0 auto;">
            <tr>
              <td align="center" style="padding-bottom:6px;">
                <!-- High-contrast styled ACTIV brand mark badge -->
                <div style="display:inline-block; background:#ffffff; border-radius:10px; padding:6px 14px; margin-bottom:6px;">
                  <span style="font-family: Arial, Helvetica, sans-serif; font-size:24px; font-weight:900; color:#1e3a8a; letter-spacing:3px;">ACTIV</span>
                </div>
              </td>
            </tr>
          </table>
          <div style="font-family: Arial, Helvetica, sans-serif; color:#ffffff; font-size:16px; font-weight:bold; letter-spacing:2px;">ACTIV PLATFORM</div>
          <div style="font-family: Arial, Helvetica, sans-serif; color:#bfdbfe; font-size:11px; letter-spacing:0.5px; margin-top:4px;">
            ADIDRAVIDAR CONFEDERATION OF TRADE AND INDUSTRIAL VISION
          </div>
        </td></tr>

        <tr><td style="padding: 32px 30px 28px 30px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:19px; font-weight:bold;
                           color:#0f172a; padding-bottom:14px;">${esc(title)}</td></tr>
            <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:15px; color:#334155;
                           padding-bottom:10px;">Hello ${esc(recipientName || 'Member')},</td></tr>
            <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:15px; line-height:1.65;
                           color:#334155;">${bodyHtml}</td></tr>
            ${factsHtml}
            ${buttonHtml}
          </table>
        </td></tr>

        <tr><td style="padding: 0 30px;"><div style="border-top:1px solid #e2e8f0;"></div></td></tr>

        <tr><td style="padding: 18px 30px 24px 30px;">
          ${office}
          ${contact && contact.nearest && contact.nearest.phone ? `
            <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:13px; color:#475569;">
              Phone: ${esc(contact.nearest.phone)}
            </p>` : ''}
        </td></tr>

        <tr><td style="background-color:#f8fafc; padding:18px 30px; text-align:center; border-top:1px solid #e2e8f0;
                       font-family: Arial, Helvetica, sans-serif; font-size:12px; color:#94a3b8;">
          &copy; ${new Date().getFullYear()} ACTIV. All rights reserved.<br />
          <a href="https://activ.org.in/" style="color:#2563eb; text-decoration:none;">activ.org.in</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
    }
}

module.exports = new EmailService();
