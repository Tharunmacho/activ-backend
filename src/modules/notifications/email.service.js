const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../../config/logger');

/** The logo, attached inline to every message whose HTML refers to it. */
const LOGO_CID = 'activ-logo';
const LOGO_PATH = path.join(__dirname, '../../assets/email-logo.png');
const EMBEDDED_LOGO = fs.existsSync(LOGO_PATH);

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
    async sendEmail({ to, subject, html, text, contact = null, replyTo = null, headers = {}, inlineImages = [] }) {
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
                headers,
                /*
                 * Inline images, referenced from the HTML as `cid:<id>`: the logo,
                 * and any the caller hands over (a booking's QR ticket). Embedded
                 * rather than linked: clients hide remote images, and Gmail strips
                 * a data: URI outright.
                 */
                attachments: [
                    ...(EMBEDDED_LOGO && String(html || '').includes(`cid:${LOGO_CID}`)
                        ? [{ filename: 'activ-logo.png', path: LOGO_PATH, cid: LOGO_CID, contentDisposition: 'inline' }]
                        : []),
                    ...(Array.isArray(inlineImages) ? inlineImages : [])
                        .filter((img) => img && img.cid && img.content && String(html || '').includes(`cid:${img.cid}`))
                        .map((img) => ({
                            filename: img.filename || `${img.cid}.png`,
                            content: img.content,
                            cid: img.cid,
                            contentType: img.contentType || 'image/png',
                            contentDisposition: 'inline'
                        }))
                ]
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
     * Table-based and inline-styled on purpose: most mail clients discard or
     * rewrite `<style>` blocks and ignore flexbox, so every rule that matters
     * for layout is inline. The `<style>` block carries only progressive extras
     * — the phone-width stacking — which a client that drops it simply renders
     * at the (still readable) desktop layout.
     *
     * THE LOGO IS EMBEDDED, NOT FETCHED. `cid:activ-logo` refers to
     * `src/assets/email-logo.png`, which `sendEmail` attaches inline whenever
     * the HTML mentions it. A remote logo was invisible in exactly the places
     * it mattered: Gmail hides every remote image in a message it has filed as
     * spam, and many clients block them until the reader opts in. It also
     * depended on the website being up and serving the right path.
     * `EMAIL_LOGO_URL` still overrides it for a deployment that wants a hosted
     * logo. `alt` text keeps the header readable if both fail.
     *
     * Optional extras, all backwards compatible (every older caller passes none):
     *   tone        'success' | 'info' | 'warning' | 'danger' — colours the hero
     *               icon and the badge
     *   badge       short status label above the title ("BOOKING CONFIRMED")
     *   highlight   { label, value, note } — the one thing to keep, e.g. a
     *               booking reference, printed as a ticket stub
     *   secondaryButton  { label, url } — a quieter second action
     *   poster      absolute image URL — the event's own poster, full width
     *               under the hero
     *   afterHtml   markup placed AFTER the details and buttons — the notes a
     *               reader needs last ("Before you come"), not first
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
        tone = 'info', badge = '', highlight = null, secondaryButton = null, poster = '', afterHtml = ''
    }) {
        const esc = (v) => this.escape(v);
        const font = "font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;";
        const mono = "font-family:'SFMono-Regular',Consolas,'Liberation Mono','Courier New',monospace;";

        const logoSrc = process.env.EMAIL_LOGO_URL || (EMBEDDED_LOGO ? `cid:${LOGO_CID}` : '');
        const siteUrl = process.env.EMAIL_SITE_URL || 'https://activ.org.in';
        const orgName = 'Adidravidar Confederation of Trade and Industrial Vision';
        const orgPhone = process.env.EMAIL_ORG_PHONE || '+91 82201 12188';
        const orgEmail = process.env.EMAIL_ORG_EMAIL || 'enquiry@activ.org.in';
        // The address is often configured with the organisation's name in front
        // of it; the footer already prints the name, so it is not said twice.
        const orgAddress = String(process.env.EMAIL_ORG_ADDRESS
            || '6&7, Hayagreeva Apartments, 121, Velachery Road, Guindy, Chennai, Tamil Nadu 600032, India')
            .replace(new RegExp(`^\\s*${orgName}\\s*,?\\s*`, 'i'), '');

        const TONES = {
            success: { fg: '#047857', bg: '#d1fae5', ring: '#a7f3d0', icon: '&#10003;' },
            info: { fg: '#1d4ed8', bg: '#dbeafe', ring: '#bfdbfe', icon: 'i' },
            warning: { fg: '#b45309', bg: '#fef3c7', ring: '#fde68a', icon: '!' },
            danger: { fg: '#b91c1c', bg: '#fee2e2', ring: '#fecaca', icon: '&#10005;' }
        };
        const t = TONES[tone] || TONES.info;

        const NAVY = '#1e3a8a';
        const INK = '#0f172a';
        const MUTED = '#64748b';
        const LINE = '#e6ebf3';
        const PAGE = '#eef2f9';

        /* ------------------------------------------------------------ hero */
        const heroHtml = `
        <tr><td class="px" align="center" bgcolor="${NAVY}"
                style="background-color:${NAVY}; background-image:linear-gradient(135deg,#172554 0%,#1e3a8a 45%,#2563eb 100%);
                       padding:40px 36px 44px 36px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
            <tr><td align="center" width="64" height="64"
                    style="width:64px; height:64px; border-radius:32px; background-color:#ffffff;
                           box-shadow:0 8px 24px rgba(15,23,42,0.25); ${font} font-size:30px; line-height:64px;
                           font-weight:800; color:${t.fg}; text-align:center;">${t.icon}</td></tr>
          </table>
          ${badge ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:20px;">
            <tr><td style="background-color:rgba(255,255,255,0.14); border:1px solid rgba(255,255,255,0.28);
                           border-radius:999px; padding:6px 16px; ${font} font-size:11px; font-weight:700;
                           letter-spacing:1.6px; text-transform:uppercase; color:#ffffff;">${esc(badge)}</td></tr>
          </table>` : ''}
          <div class="h1" style="${font} font-size:28px; line-height:1.25; font-weight:800; color:#ffffff;
                      padding-top:${badge ? 14 : 22}px; letter-spacing:-0.3px;">${esc(title)}</div>
          ${preheader && preheader !== title ? `
          <div style="${font} font-size:15px; line-height:1.6; color:#c7d7fe; padding-top:10px;">${esc(preheader)}</div>` : ''}
        </td></tr>`;

        /* ------------------------------------------------------ ticket stub */
        // The tear line of the ticket: a half-circle bitten out of each edge,
        // with the dashed rule running between them at the same height.
        const tearHtml = `
                <tr><td style="padding:0; font-size:0; line-height:0;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
                    <td width="14" valign="middle" style="width:14px; padding:0;">
                      <div style="width:14px; height:28px; background-color:#ffffff; border:1px solid ${LINE}; border-left:0;
                                  border-radius:0 14px 14px 0; margin-left:-1px;"></div></td>
                    <td valign="middle" style="padding:0 8px;">
                      <div style="height:0; border-top:2px dashed #c9d5f0; font-size:0; line-height:0;">&nbsp;</div></td>
                    <td width="14" valign="middle" style="width:14px; padding:0;">
                      <div style="width:14px; height:28px; background-color:#ffffff; border:1px solid ${LINE}; border-right:0;
                                  border-radius:14px 0 0 14px; margin-right:-1px;"></div></td>
                  </tr></table>
                </td></tr>`;
        const highlightHtml = highlight && highlight.value ? `
            <tr><td style="padding:26px 0 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="background-color:#f5f8ff; border:1px solid ${LINE}; border-radius:16px; border-collapse:separate;">
                <tr><td align="center" style="padding:22px 20px 18px 20px;">
                  <div style="${font} font-size:11px; font-weight:700; letter-spacing:1.8px; text-transform:uppercase;
                              color:${MUTED};">${esc(highlight.label || 'Reference')}</div>
                  <div style="${mono} font-size:28px; font-weight:700; letter-spacing:3px; color:${NAVY};
                              padding-top:8px; word-break:break-all;">${esc(highlight.value)}</div>
                  ${highlight.qrSrc ? `
                  <img src="${esc(highlight.qrSrc)}" width="168" height="168" alt="Your ticket QR code"
                       style="display:block; margin:16px auto 0 auto; width:168px; height:168px;
                              background-color:#ffffff; padding:8px; border:1px solid ${LINE}; border-radius:12px;" />` : ''}
                </td></tr>
                ${highlight.note ? `${tearHtml}
                <tr><td align="center" style="padding:14px 20px 20px 20px; ${font} font-size:13px;
                               line-height:1.5; color:${MUTED};">${esc(highlight.note)}</td></tr>` : ''}
              </table>
            </td></tr>` : '';

        /* ------------------------------------------------------------ facts */
        const shown = (facts || []).filter((f) => f && f.value);
        const factsHtml = shown.length ? `
            <tr><td style="padding:26px 0 0 0;">
              <div style="${font} font-size:12px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase;
                          color:${MUTED}; padding:0 0 10px 2px;">Details</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border:1px solid ${LINE}; border-radius:14px; border-collapse:separate;">
                ${shown.map((f, i) => `
                  <tr>
                    <td class="stack lbl" valign="top" width="36%"
                        style="width:36%; padding:13px 12px 13px 20px; ${font} font-size:13px; line-height:1.5;
                               color:${MUTED}; ${i ? `border-top:1px solid ${LINE};` : ''}">${esc(f.label)}</td>
                    <td class="stack val" valign="top"
                        style="padding:13px 20px 13px 12px; ${font} font-size:14px; line-height:1.5; color:${INK};
                               font-weight:600; word-break:break-word; ${i ? `border-top:1px solid ${LINE};` : ''}">${esc(f.value)}</td>
                  </tr>`).join('')}
              </table>
            </td></tr>` : '';

        /* ---------------------------------------------------------- buttons */
        const btn = (b, primary) => `
              <td class="stack btn" align="center" style="padding:6px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr><td align="center" bgcolor="${primary ? NAVY : '#ffffff'}"
                          style="border-radius:12px; ${primary
        ? `background-color:${NAVY}; background-image:linear-gradient(135deg,#1e3a8a,#2563eb); box-shadow:0 6px 16px rgba(37,99,235,0.28);`
        : 'border:1.5px solid #c7d2fe;'}">
                    <a href="${esc(b.url)}" target="_blank"
                       style="display:block; padding:15px 30px; ${font} font-size:15px; font-weight:700; line-height:1.2;
                              color:${primary ? '#ffffff' : NAVY}; text-decoration:none; border-radius:12px; white-space:nowrap;">
                      ${esc(b.label)}</a>
                  </td></tr>
                </table>
              </td>`;
        const buttons = [actionButton, secondaryButton].filter((b) => b && b.url);
        const buttonHtml = buttons.length ? `
            <tr><td align="center" style="padding:28px 0 0 0;">
              <table role="presentation" class="full" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>${buttons.map((b, i) => btn(b, i === 0)).join('')}</tr>
              </table>
            </td></tr>` : '';

        /* ------------------------------------------------------------- help */
        const office = contact && contact.nearest
            ? `Replying to this email reaches your
               <strong style="color:${INK};">${esc([contact.nearest.regionName, contact.nearest.tierLabel].filter(Boolean).join(' '))}
               Admin</strong>${contact.nearest.name ? ` (${esc(contact.nearest.name)})` : ''} directly.
               ${contact.nearest.phone ? `<br />Phone: ${esc(contact.nearest.phone)}` : ''}`
            : `<strong style="color:${INK};">Need help?</strong> Just reply to this email and it reaches the ACTIV support desk.`;

        const logoHtml = logoSrc
            ? `<img src="${esc(logoSrc)}" width="180" alt="ACTIV"
                    style="display:block; width:180px; max-width:180px; height:auto; border:0; outline:none; text-decoration:none;
                           ${font} font-size:26px; font-weight:800; color:${NAVY};" />`
            : `<span style="${font} font-size:26px; font-weight:800; letter-spacing:2px; color:${NAVY};">ACTIV</span>`;

        return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${esc(title)}</title>
  <style type="text/css">
    body { margin:0 !important; padding:0 !important; width:100% !important; }
    a { text-decoration:none; }
    @media only screen and (max-width:620px) {
      .shell { width:100% !important; border-radius:0 !important; }
      .outer { padding:0 !important; }
      .px { padding-left:22px !important; padding-right:22px !important; }
      .h1 { font-size:24px !important; }
      .stack { display:block !important; width:100% !important; box-sizing:border-box; }
      .lbl { padding:12px 18px 0 18px !important; }
      .val { padding:2px 18px 12px 18px !important; border-top:0 !important; }
      .full { width:100% !important; }
      .btn { padding:6px 0 !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:${PAGE};">
  <div style="display:none; font-size:1px; color:${PAGE}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">
    ${esc(preheader || title)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};">
    <tr><td class="outer" align="center" style="padding:32px 12px;">
      <table role="presentation" class="shell" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px; max-width:600px; background-color:#ffffff; border-radius:22px; overflow:hidden;
                    border:1px solid #dde4f0; box-shadow:0 18px 50px rgba(30,58,138,0.12);">

        <!-- Brand bar -->
        <tr><td class="px" align="center" style="padding:24px 36px 22px 36px; background-color:#ffffff;">
          <a href="${esc(siteUrl)}" target="_blank" style="display:inline-block; text-decoration:none;">${logoHtml}</a>
        </td></tr>

        ${heroHtml}
${poster ? `
        <!-- The event's own poster -->
        <tr><td style="padding:0; font-size:0; line-height:0; background-color:#0f172a;">
          <img src="${esc(poster)}" width="600" alt="${esc(title)}"
               style="display:block; width:100%; max-width:600px; height:auto; border:0; outline:none;" />
        </td></tr>` : ''}

        <!-- Body -->
        <tr><td class="px" style="padding:34px 36px 8px 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="${font} font-size:16px; line-height:1.6; color:${INK}; font-weight:600; padding-bottom:12px;">
              Dear ${esc(recipientName || 'Member')},</td></tr>
            <tr><td style="${font} font-size:15px; line-height:1.75; color:#334155;">${bodyHtml}</td></tr>
            ${highlightHtml}
            ${factsHtml}
            ${buttonHtml}
            ${afterHtml ? `<tr><td style="padding:26px 0 0 0; ${font} font-size:15px; line-height:1.7; color:#334155;">${afterHtml}</td></tr>` : ''}
          </table>
        </td></tr>

        <!-- Help -->
        <tr><td class="px" style="padding:26px 36px 34px 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background-color:#f8fafc; border:1px solid ${LINE}; border-radius:14px; border-collapse:separate;">
            <tr>
              <td width="52" valign="top" style="width:52px; padding:16px 0 16px 18px;">
                <div style="width:34px; height:34px; border-radius:17px; background-color:#e0e7ff; text-align:center;
                            ${font} font-size:16px; line-height:34px; font-weight:800; color:${NAVY};">?</div>
              </td>
              <td valign="middle" style="padding:16px 18px 16px 12px; ${font} font-size:13px; line-height:1.65; color:#475569;">
                ${office}
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td class="px" align="center" bgcolor="#0f1b4d"
                style="background-color:#0f1b4d; padding:30px 36px 32px 36px; text-align:center;">
          <div style="${font} font-size:15px; font-weight:800; letter-spacing:3px; color:#ffffff;">ACTIV</div>
          <div style="${font} font-size:12px; line-height:1.6; color:#a5b4fc; padding-top:4px;">${orgName}</div>
          <div style="height:1px; line-height:1px; font-size:0; background-color:rgba(255,255,255,0.12); margin:18px auto; width:64px;">&nbsp;</div>
          <div style="${font} font-size:12px; line-height:1.7; color:#c7d2fe;">${esc(orgAddress)}</div>
          <div style="${font} font-size:12px; line-height:1.9; padding-top:8px;">
            <a href="tel:${esc(orgPhone.replace(/\s+/g, ''))}" style="color:#ffffff; text-decoration:none;">${esc(orgPhone)}</a>
            <span style="color:#6d7fc4;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>
            <a href="mailto:${esc(orgEmail)}" style="color:#ffffff; text-decoration:none;">${esc(orgEmail)}</a>
            <span style="color:#6d7fc4;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>
            <a href="${esc(siteUrl)}" target="_blank" style="color:#ffffff; text-decoration:none;">${esc(siteUrl.replace(/^https?:\/\//, ''))}</a>
          </div>
          <div style="${font} font-size:11px; line-height:1.6; color:#7f8fd1; padding-top:16px;">
            You are receiving this because of an action on your ACTIV account or booking.<br />
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
