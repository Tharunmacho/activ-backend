const { sanitizeHtml } = require('../cms/richText');
const { TOKEN, variableValues } = require('./updateVariables');

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const recipientName = recipient => String(recipient?.fullName || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'ACTIVian';

// Only the documented single-brace token is supported. Never evaluate authored
// expressions, and never recursively expand text that came from a member name.
const personalizeText = (value, recipient = {}, update = {}) => {
    const values = variableValues(update, recipient);
    return String(value || '').replace(TOKEN, (_token, key) => values[key.toLowerCase()] || '');
};
const personalizeHtml = (value, recipient = {}, update = {}) => sanitizeHtml(value).split(/(<[^>]*>)/g)
    .map((part, index) => index % 2 ? part : part.replace(TOKEN, (_token, key) => escapeHtml(variableValues(update, recipient)[key.toLowerCase()] || '')))
    .join('');

function personalizeUpdate(update = {}, recipient = {}) {
    return { ...update, title: personalizeText(update.title, recipient, update), summary: personalizeText(update.summary, recipient, update),
        body: personalizeHtml(update.body, recipient, update), bannerAlt: personalizeText(update.bannerAlt, recipient, update),
        attachmentLabel: personalizeText(update.attachmentLabel, recipient, update) };
}

module.exports = { recipientName, personalizeText, personalizeHtml, personalizeUpdate };
