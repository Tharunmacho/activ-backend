const assert = require('assert/strict');
const { Readable } = require('stream');
const axios = require('axios');
const Event = require('../src/modules/events/event.model');
const service = require('../src/modules/events/eventbooking.service');
const templates = require('../src/modules/notifications/notificationTemplates');
const { validateDocument } = require('../src/modules/events/eventDocument');
const channel = 'https://whatsapp.com/channel/0029VaDdseGKLaHrWNV7ZK1X';

async function main() {
    const oldGet = axios.get;
    const oldFind = Event.findById;
    const oldMedia = process.env.PUBLIC_MEDIA_URL;
    try {
        for (const [type, bytes] of [
            ['text/html', '<!doctype html><html>App</html>'],
            ['application/octet-stream', '<html>App</html>'],
        ]) {
            const stream = Readable.from([Buffer.from(bytes)]);
            axios.get = async () => ({ headers: { 'content-type': type }, data: stream });
            await assert.rejects(validateDocument('https://example.org/file.pdf'), /web page|usable file/);
            assert.equal(stream.destroyed, true);
        }
        axios.get = async () => ({ headers: { 'content-type': 'application/pdf' }, data: Readable.from([Buffer.from('%PDF-1.4 test')]) });
        assert.equal(await validateDocument('https://example.org/file.pdf'), true);

        process.env.PUBLIC_MEDIA_URL = 'https://api.activ.org.in';
        Event.findById = () => ({ lean: async () => ({
            title: 'Current event', startAt: new Date('2026-10-23T03:30:00Z'), endAt: new Date('2026-10-23T11:30:00Z'),
            venue: 'Chidambaram', whatsappChannelUrl: channel,
            attachments: [{ name: 'Agenda.pdf', url: 'https://activ.org.in/uploads/agenda.pdf', type: 'application/pdf' }],
        }) });
        const ctx = await service.messageContext({ eventId: 'sample', eventTitle: 'Old event title',
            bookingRef: 'TEST-123', bookedBy: { name: 'Test' }, noOfPersons: 1, totalAmount: 0, participants: [], payment: { status: 'not_required' } });
        assert.equal(ctx.eventTitle, 'Current event');
        assert.match(ctx.dateLabel, /23 October 2026/);
        assert.equal(ctx.attachments[0].url, 'https://api.activ.org.in/uploads/agenda.pdf');
        assert.equal(ctx.whatsappChannelUrl, channel);
        const Log = require('../src/modules/notifications/notificationLog.model');
        const log = new Log({ event: 'EVENT_CHANNEL_CONFIRMED', channel: 'whatsapp', recipient: '919092317264', status: 'sent' });
        assert.ok(!log.validateSync()?.errors?.event);
        for (const event of ['EVENT_BOOKING_CONFIRMED', 'EVENT_BOOKING_REMINDER', 'EVENT_PARTICIPANT_CONFIRMED', 'EVENT_PARTICIPANT_REMINDER']) {
            const result = templates.render(event, ctx);
            assert.ok(result.email.afterHtml.includes(channel), event);
            assert.ok(result.whatsapp.text.includes(channel), event);
        }
        const without = templates.render('EVENT_BOOKING_CONFIRMED', { ...ctx, whatsappChannelUrl: '' });
        assert.ok(!without.email.afterHtml.includes('WhatsApp channel'));
        const invalid = new Event({ whatsappChannelUrl: 'https://example.org/channel/123' }).validateSync();
        assert.ok(invalid.errors.whatsappChannelUrl);
        for (const name of ['activ_event_channel_v1', 'activ_event_document_readable_v2']) {
            assert.deepEqual(require('../src/modules/notifications/whatsappFlex').lintTemplate(templates.WHATSAPP_TEMPLATES.find(t => t.name === name)), []);
        }
        console.log('Event content, channel links, file URL routing and HTML rejection checks passed.');
    } finally {
        axios.get = oldGet;
        Event.findById = oldFind;
        if (oldMedia === undefined) delete process.env.PUBLIC_MEDIA_URL; else process.env.PUBLIC_MEDIA_URL = oldMedia;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
