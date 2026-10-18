const { sanitizeHtml } = require('../cms/richText');

function plain(value) {
    return sanitizeHtml(Array.isArray(value) ? value.join('\n') : value || '')
        .replace(/<br\s*\/?>|<\/(?:p|li|h[1-6]|blockquote)>/gi, '\n').replace(/<[^>]*>/g, '')
        .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (match, entity) => {
            if (entity[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()] || match;
            const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
            return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
        }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function clip(value, bytes) {
    const text = String(value || '');
    if (Buffer.byteLength(text, 'utf8') <= bytes) return text;
    let result = '', used = 0;
    for (const character of text) {
        const length = Buffer.byteLength(character, 'utf8');
        if (used + length > bytes - 3) break;
        result += character; used += length;
    }
    return result.trimEnd() + '…';
}
function preview(value = {}) {
    return { title: clip(plain(value.title), 200) || 'ACTIV',
        body: clip(plain(value.body || value.message || value.description || value.summary || value.caption), 1800) || 'Open this notification to view the update.' };
}
// Include the same preview for automatic native display and the web/foreground
// handlers. Keep the complete FCM payload below its byte limit, including Tamil.
function apply(payload, value) {
    const text = preview(value);
    let maximum = 1800;
    const update = () => {
        const body = clip(text.body, maximum);
        payload.data = { ...payload.data, title: text.title, body };
        if (payload.notification) payload.notification = { title: text.title, body };
    };
    update();
    while (Buffer.byteLength(JSON.stringify({ ...payload, token: undefined }), 'utf8') > 3800 && maximum > 100) {
        maximum -= 100; update();
    }
    return payload;
}
async function memberPreview(row) {
    const data = row.data || {};
    if (data.sourceId) {
        const broadcast = require('./contentBroadcast');
        const doc = await broadcast.sourceModel(data.kind)?.findById(data.sourceId).lean();
        if (!doc || !broadcast.published(data.kind, doc) || (data.broadcastKey && broadcast.sourceKey(data.kind, doc) !== data.broadcastKey)) return null;
        if (data.kind === 'announcement') {
            const recipient = await require('../announcements/announcementRecipients').loadRecipient({ _id: row.user });
            if (!recipient._id || recipient.isActive === false || recipient.deletedAt || !broadcast.visibleTo(data.kind, doc, recipient)) return null;
            return require('../common/recipientPersonalization').personalizeUpdate(doc, recipient);
        }
        return doc;
    }
    if (data.kind === 'message' && data.messageId) {
        const message = await require('../messages/message.model').Message.findOne({ _id: data.messageId,
            conversationId: data.conversationId, deletedAt: null, hiddenFor: { $ne: row.user } }).lean();
        if (!message) return null;
        return { title: row.title, body: message.body || (message.attachment?.name ? 'Attachment: ' + message.attachment.name : message.attachmentUrl ? 'Sent an attachment.' : row.message) };
    }
    return { title: row.title, body: row.message };
}
module.exports = { plain, clip, preview, apply, memberPreview };
