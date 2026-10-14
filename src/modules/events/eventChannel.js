const config = require('../../config');
const whatsapp = require('../notifications/whatsappTemplate');
const contact = require('../notifications/eventContact');
const line = value => String(value || '').replace(/\s+/g, ' ').trim();

// Channel notices use an approved event notice while their dedicated utility
// template is under review. A timeout has an uncertain outcome, so it must not
// trigger another template send. Both paths retain the exact channel URL.
const sendChannel = async (phone, name, context = {}) => {
    let template = config.botbee.templates.eventChannel;
    let params = [line(context.eventTitle), line(context.bookingRef), line(context.whatsappChannelUrl)];
    const requestedTemplate = template;
    let outcome = await whatsapp.sendTemplateMessage(phone, template, params, 'en', '', { noHeader: true });
    const unavailable = /13200[0157]|template.*(?:not exist|not found|not approved|review|paused|disabled|language)|(?:unknown|missing|unapproved) template/i;
    if (!outcome.success && unavailable.test(String(outcome.error || ''))
        && config.botbee.templates.event && config.botbee.templates.event !== 'none') {
        template = config.botbee.templates.event;
        params = [line(name) || 'Member', `your event ${line(context.eventTitle).slice(0, 180)}`,
            [line(context.whenLabel) || 'the scheduled date', `Booking ID: ${line(context.bookingRef)}`,
                `WhatsApp channel: ${line(context.whatsappChannelUrl)}`, `Queries: ${contact.email}`].join(' | ')];
        outcome = await whatsapp.sendTemplateMessage(phone, template, params, 'en', '', { noHeader: true });
    }
    return { outcome, template, params, requestedTemplate };
};

module.exports = { sendChannel };
