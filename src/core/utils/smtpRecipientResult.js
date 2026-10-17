const addressParser = require('nodemailer/lib/addressparser');
const { domainToASCII } = require('node:url');

// Match the envelope addresses, not display names or the office's CC/BCC.
// Account email comparisons elsewhere in ACTIV are case-insensitive as well.
const addresses = value => {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.flatMap(item => {
        const text = typeof item === 'string' ? item : item?.address;
        if (typeof text !== 'string' || !text) return [];
        return addressParser(text, { flatten: true }).map(entry => {
            const address = String(entry.address || '').trim();
            const at = address.lastIndexOf('@');
            return (at < 0 ? address : `${address.slice(0, at)}@${domainToASCII(address.slice(at + 1)) || address.slice(at + 1)}`).toLowerCase();
        }).filter(Boolean);
    }))];
};

function smtpRecipientResult(to, info) {
    // Nodemailer's SMTP result names accepted/rejected envelope recipients even
    // when sendMail resolves. A Message-ID alone is not acceptance evidence.
    // Explicit unconfigured/mock sends return before reaching this helper.
    const intended = addresses(to);
    const accepted = new Set(Array.isArray(info?.accepted) ? addresses(info.accepted) : []);
    const rejected = new Set(Array.isArray(info?.rejected) ? addresses(info.rejected) : []);
    const contradictory = intended.some(address => accepted.has(address) && rejected.has(address));
    const acceptedCount = intended.filter(address => accepted.has(address)).length;
    const rejectedCount = intended.filter(address => rejected.has(address)).length;
    if (intended.length && !contradictory && acceptedCount === intended.length) {
        return { success: true, smtpRecipientStatus: 'accepted' };
    }
    if (intended.length && !contradictory && rejectedCount === intended.length) {
        const errors = (Array.isArray(info?.rejectedErrors) ? info.rejectedErrors : [])
            .filter(error => addresses(error?.recipient).some(address => intended.includes(address)));
        const detail = errors.map(error => String(error.response || error.message || '').replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim()).filter(Boolean).join('; ').slice(0, 500);
        // Keep confirmed temporary refusals eligible for the existing retry
        // guard, even if a provider calls its 450 a "recipient rejected".
        const codes = errors.map(error => Number(error.responseCode));
        const temporary = errors.length === intended.length && codes.every(code => code >= 400 && code < 500);
        return { success: false, smtpRecipientStatus: 'rejected',
            error: temporary ? `SMTP ${codes[0]} temporarily declined the intended email address.`
                : `SMTP rejected the intended email address.${detail ? ` ${detail}` : ''}`,
            ...(detail ? { smtpResponse: detail } : {}) };
    }
    // A partial acceptance or incomplete response is not safe to replay: some
    // intended recipients may already have received this message.
    return { success: false, smtpRecipientStatus: acceptedCount && !contradictory ? 'partial' : 'unknown',
        outcomeUnknown: true, autoRetryDisabled: true,
        error: acceptedCount && !contradictory
            ? 'SMTP accepted only some intended email addresses. Review provider history before sending again.'
            : 'SMTP did not confirm acceptance for the intended email address. Review provider history before sending again.' };
}

const smtpLogData = result => ({
    ...(result?.smtpRecipientStatus ? { smtpRecipientStatus: result.smtpRecipientStatus } : {}),
    ...(result?.smtpResponse ? { smtpResponse: result.smtpResponse } : {}),
    ...(result?.outcomeUnknown ? { outcomeUnknown: true, autoRetryDisabled: true } : {}),
});

module.exports = { smtpRecipientResult, smtpLogData };
