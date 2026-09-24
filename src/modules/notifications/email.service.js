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
     * THE REAL ACTIV LOGO, from an absolute public URL. An email cannot carry a
     * relative path, so it is `${FRONTEND_URL}/logo_ACTIVian-removebg-preview.png`
     * — the same file the website header shows — or `EMAIL_LOGO_URL` when set.
     * The logo sits on WHITE because the PNG is dark-on-transparent; on the old
     * navy band it would vanish. `alt` text keeps the header readable in a
     * client that blocks images until the reader allows them.
     *
     * Optional extras, all backwards compatible (every older caller passes none):
     *   tone        'success' | 'info' | 'warning' | 'danger' — colours the badge
     *   badge       short status label above the title ("BOOKING CONFIRMED")
     *   highlight   { label, value, note } — the one thing to keep, e.g. a
     *               booking reference, printed large in a ticket-style box
     *   secondaryButton  { label, url } — a quieter second action
     *
     * A REAL POSTAL ADDRESS AND CONTACT IN THE FOOTER. Transactional mail that
     * names who sent it and where they are is both what the reader needs and one
     * of the signals spam filters look for.
     *
     * `contact` prints the applicant's own regional office beside the "reply to
     * this email" line, so where a reply goes is checkable.
     */
    buildHtmlTemplate({
        title, recipientName, preheader, bodyHtml, actionButton, contact = null, facts = [],
        tone = 'info', badge = '', highlight = null, secondaryButton = null
    }) {
        const esc = (v) => this.escape(v);
        const font = "font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;";

        const base = String(config.frontendUrl || 'https://activ.org.in').replace(/\/+$/, '');
        const logoUrl = process.env.EMAIL_LOGO_URL || `${base}/logo_ACTIVian-removebg-preview.png`;
        const siteUrl = process.env.EMAIL_SITE_URL || 'https://activ.org.in';
        const orgPhone = process.env.EMAIL_ORG_PHONE || '+91 82201 12188';
        const orgEmail = process.env.EMAIL_ORG_EMAIL || 'enquiry@activ.org.in';
        const orgAddress = process.env.EMAIL_ORG_ADDRESS
            || '6&7, Hayagreeva Apartments, 121, Velachery Road, Guindy, Chennai, Tamil Nadu 600032, India';

        const TONES = {
            success: { fg: '#047857', bg: '#ecfdf5', border: '#a7f3d0', icon: '&#10004;' },
            info: { fg: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe', icon: '&#9432;' },
            warning: { fg: '#b45309', bg: '#fffbeb', border: '#fde68a', icon: '&#9888;' },
            danger: { fg: '#b91c1c', bg: '#fef2f2', border: '#fecaca', icon: '&#10006;' }
        };
        const t = TONES[tone] || TONES.info;

        const badgeHtml = badge ? `
            <tr><td style="padding-bottom:14px;">
              <span style="display:inline-block; ${font} font-size:12px; font-weight:700; letter-spacing:1.2px;
                           text-transform:uppercase; color:${t.fg}; background:${t.bg}; border:1px solid ${t.border};
                           border-radius:999px; padding:6px 14px;">${t.icon}&nbsp; ${esc(badge)}</span>
            </td></tr>` : '';

        const highlightHtml = highlight && highlight.value ? `
            <tr><td style="padding: 18px 0 6px 0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background:#f5f7ff; border:2px dashed #93a5e8; border-radius:14px;">
                <tr><td align="center" style="padding:18px 16px;">
                  <div style="${font} font-size:12px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase;
                              color:#64748b;">${esc(highlight.label || 'Reference')}</div>
                  <div style="font-family: 'Courier New', Courier, monospace; font-size:24px; font-weight:700;
                              letter-spacing:2px; color:#1e3a8a; padding-top:6px; word-break:break-all;">
                    ${esc(highlight.value)}</div>
                  ${highlight.note ? `<div style="${font} font-size:13px; color:#64748b; padding-top:6px;">
                    ${esc(highlight.note)}</div>` : ''}
                </td></tr>
              </table>
            </td></tr>` : '';

        const shown = (facts || []).filter((f) => f && f.value);
        const factsHtml = shown.length ? `
            <tr><td style="padding: 18px 0 0 0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border:1px solid #e2e8f0; border-radius:12px; border-collapse:separate; overflow:hidden;">
                <tr><td colspan="2" style="background:#1e3a8a; padding:11px 18px; ${font} font-size:12px;
                               font-weight:700; letter-spacing:1.4px; text-transform:uppercase; color:#ffffff;">
                  Details</td></tr>
                ${shown.map((f, i) => `
                  <tr style="background:${i % 2 ? '#ffffff' : '#f8fafc'};">
                    <td valign="top" style="padding:12px 18px; ${font} font-size:13px; color:#64748b;
                               width:38%; border-top:1px solid #eef2f7;">${esc(f.label)}</td>
                    <td valign="top" style="padding:12px 18px; ${font} font-size:14px; color:#0f172a;
                               font-weight:600; border-top:1px solid #eef2f7;">${esc(f.value)}</td>
                  </tr>`).join('')}
              </table>
            </td></tr>` : '';

        const btn = (b, primary) => `
              <td align="center" bgcolor="${primary ? '#1e3a8a' : '#ffffff'}"
                  style="border-radius:10px; ${primary ? '' : 'border:1px solid #cbd5e1;'}">
                <a href="${esc(b.url)}" target="_blank"
                   style="display:inline-block; padding:14px 28px; ${font} font-size:15px; font-weight:700;
                          color:${primary ? '#ffffff' : '#1e3a8a'}; text-decoration:none; border-radius:10px;">
                  ${esc(b.label)}</a>
              </td>`;
        const buttons = [actionButton, secondaryButton].filter((b) => b && b.url);
        const buttonHtml = buttons.length ? `
            <tr><td align="center" style="padding: 26px 0 4px 0;">
              <table cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>${buttons.map((b, i) => (i ? '<td width="12"></td>' : '') + btn(b, i === 0)).join('')}</tr>
              </table>
            </td></tr>` : '';

        const office = contact && contact.nearest
            ? `Replying to this email reaches your
               <strong>${esc([contact.nearest.regionName, contact.nearest.tierLabel].filter(Boolean).join(' '))}
               Admin</strong>${contact.nearest.name ? ` (${esc(contact.nearest.name)})` : ''} directly.
               ${contact.nearest.phone ? `<br />Phone: ${esc(contact.nearest.phone)}` : ''}`
            : 'Questions? Just reply to this email and it reaches the ACTIV support desk.';

        return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>${esc(title)}</title>
</head>
<body style="margin:0; padding:0; background-color:#eef2f7;">
  <div style="display:none; font-size:1px; color:#eef2f7; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">
    ${esc(preheader || title)}
  </div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2f7;">
    <tr><td align="center" style="padding: 28px 12px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px; width:100%; background-color:#ffffff; border-radius:18px; overflow:hidden;
                    border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(15,23,42,0.08);">

        <!-- Brand: the real logo on white, then the navy-to-blue accent rule -->
        <tr><td align="center" style="padding:26px 30px 20px 30px; background:#ffffff;">
          <a href="${esc(siteUrl)}" target="_blank" style="text-decoration:none;">
            <img src="${esc(logoUrl)}" width="200" alt="ACTIV — Adidravidar Confederation of Trade and Industrial Vision"
                 style="display:block; width:200px; max-width:70%; height:auto; border:0; outline:none;
                        ${font} font-size:20px; font-weight:800; color:#1e3a8a;" />
          </a>
        </td></tr>
        <tr><td style="height:5px; line-height:5px; font-size:0; background:#1e3a8a;
                       background-image:linear-gradient(90deg,#1e3a8a,#2563eb,#38bdf8);">&nbsp;</td></tr>

        <tr><td style="padding: 30px 32px 10px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            ${badgeHtml}
            <tr><td style="${font} font-size:24px; line-height:1.3; font-weight:800; color:#0f172a;
                           padding-bottom:14px;">${esc(title)}</td></tr>
            <tr><td style="${font} font-size:15px; color:#334155; padding-bottom:10px;">
              Dear ${esc(recipientName || 'Member')},</td></tr>
            <tr><td style="${font} font-size:15px; line-height:1.7; color:#334155;">${bodyHtml}</td></tr>
            ${highlightHtml}
            ${factsHtml}
            ${buttonHtml}
          </table>
        </td></tr>

        <tr><td style="padding: 22px 32px 26px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px;">
            <tr><td style="padding:14px 18px; ${font} font-size:13px; line-height:1.6; color:#475569;">
              ${office}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="background-color:#1e3a8a; padding:24px 32px; text-align:center;">
          <div style="${font} font-size:14px; font-weight:700; color:#ffffff; letter-spacing:0.5px;">
            Adidravidar Confederation of Trade and Industrial Vision</div>
          <div style="${font} font-size:12px; line-height:1.7; color:#c7d2fe; padding-top:8px;">
            ${esc(orgAddress)}<br />
            <a href="tel:${esc(orgPhone.replace(/\s+/g, ''))}" style="color:#ffffff; text-decoration:none;">${esc(orgPhone)}</a>
            &nbsp;&middot;&nbsp;
            <a href="mailto:${esc(orgEmail)}" style="color:#ffffff; text-decoration:none;">${esc(orgEmail)}</a>
            &nbsp;&middot;&nbsp;
            <a href="${esc(siteUrl)}" target="_blank" style="color:#ffffff; text-decoration:none;">${esc(siteUrl.replace(/^https?:\/\//, ''))}</a>
          </div>
          <div style="${font} font-size:11px; color:#a5b4fc; padding-top:12px;">
            You are receiving this because of an action on your ACTIV account or booking.
            &copy; ${new Date().getFullYear()} ACTIV. All rights reserved.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
    }
}

module.exports = new EmailService();
