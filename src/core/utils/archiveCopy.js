/**
 * The office's copy of an outgoing email (see config.email.archiveCopy).
 *
 * Returns the nodemailer fields to merge into sendMail: { bcc } or { cc }, or
 * nothing when the copy is off or the message is already addressed to the
 * archive mailbox (no point sending the office two of the same email).
 */
const config = require('../../config');

const archiveFields = (to = '') => {
    const archive = String((config.email && config.email.archiveCopy) || '').trim();
    if (!archive) return {};
    const recipients = String(to || '').toLowerCase().split(/[,;]/).map((s) => s.trim());
    if (recipients.includes(archive.toLowerCase())) return {};
    return config.email.archiveMode === 'cc' ? { cc: archive } : { bcc: archive };
};

module.exports = { archiveFields };
