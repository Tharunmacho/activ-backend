const { sanitizeHtml } = require('../cms/richText');

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const recipientName = recipient => String(recipient?.fullName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'ACTIVian';

// Only the documented single-brace token is supported. Never evaluate authored
// expressions, and never recursively expand text that came from a member name.
const personalizeText = (value, recipient) => String(value || '').replace(/(?<!\{)\{\s*name\s*\}(?!\})/gi, () => recipientName(recipient));
const personalizeHtml = (value, recipient) => sanitizeHtml(value).split(/(<[^>]*>)/g)
    .map((part, index) => index % 2 ? part : part.replace(/(?<!\{)\{\s*name\s*\}(?!\})/gi, () => escapeHtml(recipientName(recipient))))
    .join('');

function personalizeUpdate(update = {}, recipient = {}) {
    return { ...update, title: personalizeText(update.title, recipient), summary: personalizeText(update.summary, recipient),
        body: personalizeHtml(update.body, recipient), bannerAlt: personalizeText(update.bannerAlt, recipient),
        attachmentLabel: personalizeText(update.attachmentLabel, recipient) };
}

module.exports = { recipientName, personalizeText, personalizeHtml, personalizeUpdate };
