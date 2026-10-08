const parseWhatsAppEventLink = (value) => {
    const text = String(value || '').trim();
    const candidate = /^(?:chat\.whatsapp\.com\/|(?:www\.)?whatsapp\.com\/channel\/)/i.test(text)
        ? `https://${text}` : text;
    if (/[\s\\]/.test(candidate)) return null;
    try {
        const url = new URL(candidate);
        if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
        const group = url.hostname === 'chat.whatsapp.com' && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
        const channel = ['whatsapp.com', 'www.whatsapp.com'].includes(url.hostname)
            && /^\/channel\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
        return group || channel ? url : null;
    } catch {
        return null;
    }
};
const normalizeWhatsAppEventLink = (value) => parseWhatsAppEventLink(value)?.href || String(value || '').trim();
const isWhatsAppEventLink = (value) => !String(value || '').trim() || !!parseWhatsAppEventLink(value);
const whatsappLinkLabel = (value) => /chat\.whatsapp\.com\//.test(value || '') ? 'WhatsApp group' : 'WhatsApp channel';
module.exports = { isWhatsAppEventLink, normalizeWhatsAppEventLink, whatsappLinkLabel };
