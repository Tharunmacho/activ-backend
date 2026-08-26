const nodemailer = require('nodemailer');
const config = require('../../config');
const logger = require('../../config/logger');

/**
 * Outbound mail, used to hand a newly onboarded admin their credentials.
 *
 * Two rules govern everything here:
 *
 * 1. Sending never throws. A CSV import that created 800 admin accounts must
 *    not report failure because the SMTP host timed out on account 801 — the
 *    accounts exist and are usable, and the caller is told which welcomes did
 *    not go out so they can be resent.
 * 2. When SMTP is not configured the module is simply disabled and says so.
 *    A development machine with no mail server should not fail imports, and it
 *    must not silently look like mail was delivered either.
 */

let transporter = null;
let initialised = false;

const isConfigured = () => !!(config.email && config.email.host && config.email.user);

const getTransporter = () => {
    if (initialised) return transporter;
    initialised = true;

    if (!isConfigured()) {
        logger.warn('SMTP is not configured (EMAIL_HOST / EMAIL_USER); welcome emails will be skipped');
        return null;
    }

    try {
        transporter = nodemailer.createTransport({
            host: config.email.host,
            port: config.email.port,
            // 465 is implicit TLS; everything else negotiates STARTTLS.
            secure: Number(config.email.port) === 465,
            auth: { user: config.email.user, pass: config.email.password }
        });
    } catch (err) {
        logger.error('Failed to create the SMTP transport', { error: err && err.message });
        transporter = null;
    }

    return transporter;
};

/**
 * Send one message.
 *
 * Resolves to `{ sent, skipped, error }` — never rejects.
 */
const send = async({ to, subject, text, html }) => {
    const target = String(to || '').trim();
    if (!target) return { sent: false, skipped: true, error: 'No recipient address' };

    const transport = getTransporter();
    if (!transport) return { sent: false, skipped: true, error: 'SMTP is not configured' };

    try {
        await transport.sendMail({
            from: config.email.from,
            to: target,
            subject: subject || 'ACTIV Platform',
            text: text || '',
            html: html || undefined
        });
        return { sent: true, skipped: false, error: '' };
    } catch (err) {
        logger.warn('Email delivery failed', { to: target, error: err && err.message });
        return { sent: false, skipped: false, error: (err && err.message) || 'Delivery failed' };
    }
};

const escapeHtml = (value = '') => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The welcome email a newly created admin receives.
 *
 * It carries the generated password because bulk onboarding is the only way
 * they can get it — nobody typed it, and it is not stored in recoverable form
 * anywhere. The copy says to change it on first sign-in for that reason.
 */
const sendAdminWelcome = async({ email, fullName, password, roleLabel, region }) => {
    const name = String(fullName || '').trim() || 'there';
    const place = String(region || '').trim();
    const tier = String(roleLabel || 'Admin').trim();

    const lines = [
        `Hello ${name},`,
        '',
        `An ACTIV ${tier} account has been created for you${place ? ` covering ${place}` : ''}.`,
        '',
        `Email:    ${email}`,
        `Password: ${password}`,
        '',
        'Please sign in and change this password immediately — it was generated for you and sent by email, so treat it as temporary.',
        '',
        'You will only ever see applications from your own region.',
        '',
        '— The ACTIV Platform'
    ];

    return send({
        to: email,
        subject: `Your ACTIV ${tier} account`,
        text: lines.join('\n'),
        html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111827">
  <p>Hello ${escapeHtml(name)},</p>
  <p>An ACTIV <strong>${escapeHtml(tier)}</strong> account has been created for you${place ? ` covering <strong>${escapeHtml(place)}</strong>` : ''}.</p>
  <table cellpadding="6" style="background:#F3F4F6;border-radius:8px;margin:16px 0">
    <tr><td><strong>Email</strong></td><td>${escapeHtml(email)}</td></tr>
    <tr><td><strong>Password</strong></td><td><code>${escapeHtml(password)}</code></td></tr>
  </table>
  <p>Please sign in and change this password immediately — it was generated for you and sent by email, so treat it as temporary.</p>
  <p style="color:#6B7280;font-size:13px">You will only ever see applications from your own region.</p>
  <p style="color:#6B7280;font-size:13px">— The ACTIV Platform</p>
</div>`
    });
};

/**
 * The password-reset link.
 *
 * The link is the whole message — there is deliberately no password in it and
 * nothing that identifies the account beyond the address it was sent to. The
 * copy names the expiry because a reset mail that arrives after the window has
 * closed is otherwise indistinguishable from a broken one, and says plainly
 * that an unrequested mail can be ignored: the token stays dormant until it is
 * used, so no action is genuinely required.
 */
const sendPasswordReset = async({ email, fullName, resetUrl, expiresInMinutes = 60 }) => {
    const name = String(fullName || '').trim() || 'there';
    const minutes = Number(expiresInMinutes) || 60;
    const window = minutes >= 60
        ? `${Math.round(minutes / 60)} hour${minutes >= 120 ? 's' : ''}`
        : `${minutes} minutes`;

    const lines = [
        `Hello ${name},`,
        '',
        'We received a request to reset the password on your ACTIV account.',
        '',
        'Open this link to choose a new one:',
        resetUrl,
        '',
        `The link expires in ${window} and can be used once.`,
        '',
        'If you did not request this, you can ignore this email — your password has not been changed.',
        '',
        '— The ACTIV Platform'
    ];

    return send({
        to: email,
        subject: 'Reset your ACTIV password',
        text: lines.join('\n'),
        html: `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111827">
  <p>Hello ${escapeHtml(name)},</p>
  <p>We received a request to reset the password on your ACTIV account.</p>
  <p style="margin:24px 0">
    <a href="${escapeHtml(resetUrl)}"
       style="background:#1D4ED8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">
      Choose a new password
    </a>
  </p>
  <p style="color:#6B7280;font-size:13px">
    Or paste this into your browser:<br>
    <span style="word-break:break-all">${escapeHtml(resetUrl)}</span>
  </p>
  <p style="color:#6B7280;font-size:13px">The link expires in ${escapeHtml(window)} and can be used once.</p>
  <p style="color:#6B7280;font-size:13px">
    If you did not request this, you can ignore this email — your password has not been changed.
  </p>
  <p style="color:#6B7280;font-size:13px">— The ACTIV Platform</p>
</div>`
    });
};

module.exports = { send, sendAdminWelcome, sendPasswordReset, isConfigured };
