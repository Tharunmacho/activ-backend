const isWhatsAppEventLink = (value) => !value || /^https:\/\/(?:chat\.whatsapp\.com\/[A-Za-z0-9]+|(?:www\.)?whatsapp\.com\/channel\/[A-Za-z0-9]+)\/?(?:\?[^\s#]*)?$/.test(value);
const whatsappLinkLabel = (value) => /chat\.whatsapp\.com\//.test(value || '') ? 'WhatsApp group' : 'WhatsApp channel';
module.exports = { isWhatsAppEventLink, whatsappLinkLabel };
