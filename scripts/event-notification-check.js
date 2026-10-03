require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const CHANNEL = 'https://whatsapp.com/channel/0029VaDdseGKLaHrWNV7ZK1X';

async function main() {
    await mongoose.connect(config.db.uri, { serverSelectionTimeoutMS: 10000 });
    const Event = require('../src/modules/events/event.model');
    const { ContactSettings, SiteSettings, SINGLETON_KEY } = require('../src/modules/cms/cms.models');
    const events = await Event.find({ title: /Entrepreneurship Awareness|Zero Cost Social|SCST Economic/i })
        .select('title startAt endAt venue attachments whatsappChannelUrl').lean();
    console.log(JSON.stringify(events, null, 2));
    if (process.argv.includes('--send-tests') || process.argv.includes('--send-banner-test')) {
        // Only the two recipients explicitly supplied for this task. No booking is created.
        const service = require('../src/modules/events/eventbooking.service');
        const event = events.find(e => e.title === 'Entrepreneurship Awareness Programme');
        if (!event) throw new Error('Test event not found');
        process.env.PUBLIC_MEDIA_URL = 'https://api.activ.org.in';
        const ctx = await service.messageContext({
            eventId: event._id, bookingRef: 'ACTIV-TEST-20261003', noOfPersons: 1, totalAmount: 0,
            bookedBy: { name: 'Tharun (test message)', phone: '9092317264', email: 'tharunroobika@gmail.com' },
            payment: { status: 'not_required' }, participants: [],
        });
        Object.assign(ctx, { name: 'Tharun (test message)', eventTitle: `[TEST] ${ctx.eventTitle}`,
            whatsappChannelUrl: CHANNEL, ticketUrl: '', passes: [],
            viewUrl: ctx.eventUrl, registrationNo: 'TEST ONLY - no reservation',
        });
        const templates = require('../src/modules/notifications/notificationTemplates');
        const rendered = templates.render('EVENT_BOOKING_CONFIRMED', ctx);
        const email = require('../src/modules/notifications/email.service');
        const html = email.buildHtmlTemplate({ ...rendered.email, recipientName: ctx.name });
        const emailResult = process.argv.includes('--send-tests')
            ? await email.sendEmail({ to: 'tharunroobika@gmail.com', subject: `[TEST] ${rendered.email.subject}`, html }) : null;
        const flex = require('../src/modules/notifications/whatsappFlex');
        const output = flex.readableParams('confirmed', ctx);
        if (output.missing.length) throw new Error(output.missing.join(', '));
        const whatsappResult = await require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage(
            '9092317264', ctx.posterUrl ? flex.READABLE_NAMES.confirmed.image : flex.READABLE_NAMES.confirmed.plain,
            output.params, 'en_US', '', ctx.posterUrl ? { headerImage: ctx.posterUrl } : { noHeader: true });
        for (const [channel, result] of Object.entries({ ...(emailResult ? { email: emailResult } : {}), whatsapp: whatsappResult })) {
            console.log(channel, JSON.stringify({ success: result.success, mock: result.mock, messageId: result.messageId, error: result.error }));
            if (!result.success || result.mock) process.exitCode = 1;
        }
    }
    if (process.argv.includes('--save-channel')) {
        await ContactSettings.updateOne({ key: SINGLETON_KEY }, { $set: { 'social.whatsapp': CHANNEL } }, { upsert: true });
        const site = await SiteSettings.findOne({ key: SINGLETON_KEY });
        if (site) {
            const rows = (site.footer && site.footer.socials) || [];
            const other = rows.filter((r) => r.icon !== 'whatsapp' && !/whatsapp\.com|wa\.me/.test(r.href || ''));
            await SiteSettings.updateOne({ _id: site._id }, { $set: { 'footer.socials': [...other.map(r => r.toObject ? r.toObject() : r), { icon: 'whatsapp', href: CHANNEL }] } });
        }
        const contact = await ContactSettings.findOne({ key: SINGLETON_KEY }).lean();
        console.log('Saved CMS WhatsApp channel:', contact.social.whatsapp);
    }
    await mongoose.disconnect();
}
main().catch(async error => { console.error(error.message); await mongoose.disconnect(); process.exitCode = 1; });
