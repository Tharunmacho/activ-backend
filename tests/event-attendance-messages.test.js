// Real context builders, renderers and channel dispatcher; provider/DB I/O is replaced.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const bookings = require('../src/modules/events/eventbooking.service');
const changes = require('../src/modules/events/eventChanges.service');
const registry = require('../src/modules/notifications/notificationTemplates');
const flex = require('../src/modules/notifications/whatsappFlex');
const notifications = require('../src/modules/notifications/notification.service');
const emails = [];
const messages = [];
notifications.log = async row => row;
require('../src/modules/notifications/email.service').sendEmail = async options => {
    emails.push(options);
    return { success: true, messageId: `email-${emails.length}`, provider: 'smtp' };
};
require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage = async (phone, template, params) => {
    messages.push({ phone, template, params });
    return { success: true, messageId: `whatsapp-${messages.length}`, provider: 'meta', to: phone };
};
const recipient = { name: 'Fixture attendee', email: 'fixture@example.test', phone: '919999999999' };
const event = {
    _id: new mongoose.Types.ObjectId().toString(), title: 'Beyond Business: How to Build a Brand That Lasts',
    slug: 'beyond-business', status: 'published', startAt: new Date(Date.now() + 86400000 * 4),
    endAt: new Date(Date.now() + 86400000 * 4 + 10800000), mode: 'online', onlinePlatform: 'Zoom',
    onlineUrl: 'https://zoom.us/meeting/register/fixture?source=event&test=1',
    videoUrl: 'https://www.youtube.com/watch?v=fixture1234&feature=share',
    whatsappChannelUrl: 'https://chat.whatsapp.com/FixtureInvite',
    attachments: [{ name: 'Agenda.pdf', url: 'https://example.test/agenda.pdf', type: 'application/pdf', size: 100 }],
    registrationNote: 'Bring your questions for the discussion.',
};
const booking = { eventId: event._id, bookingRef: 'ACTIVB-FIXTURE-123', bookedBy: recipient,
    status: 'active', noOfPersons: 1, totalAmount: 0, payment: { status: 'not_required' }, participants: [] };
const registration = { _id: new mongoose.Types.ObjectId().toString(), eventId: event._id,
    status: 'registered', payment: { status: 'not_required' } };
const formats = [
    { event, label: 'Online registration link', url: event.onlineUrl },
    { event: { ...event, onlineUrl: 'https://zoom.us/j/123456789?pwd=fixture' }, label: 'Online joining link', url: 'https://zoom.us/j/123456789?pwd=fixture' },
    { event: { ...event, mode: 'offline', category: 'ZOOM', onlinePlatform: '', venue: '' }, label: 'Online registration link', url: event.onlineUrl },
    { event: { ...event, mode: 'offline', venue: 'Community Hall', venueAddress: 'Chennai', venueMapUrl: 'https://maps.google.com/?q=Community+Hall' }, label: 'Venue directions', url: 'https://maps.google.com/?q=Community+Hall' },
    { event: { ...event, onlineUrl: '' }, label: 'Online event details', url: '/events/beyond-business' },
];
const bodyOf = message => {
    const definition = registry.WHATSAPP_TEMPLATES.find(item => item.name === message.template);
    assert(definition, `Missing template definition: ${message.template}`);
    return flex.renderBody(definition.bodyWithVariables, message.params);
};
async function main() {
    for (const sample of formats) for (const [kind, bookingEvent, legacyEvent] of [
        ['confirmed', 'EVENT_BOOKING_CONFIRMED', 'EVENT_REGISTERED'],
        ['reminder', 'EVENT_BOOKING_REMINDER', 'EVENT_REMINDER'],
        ['updated', 'EVENT_UPDATED', 'EVENT_UPDATED'],
    ]) {
        const contexts = [
            [bookingEvent, await bookings.messageContext(booking, kind, { eventSnapshot: sample.event })],
            [legacyEvent, changes.registrationContext(registration, sample.event)],
        ];
        for (const [name, context] of contexts) {
            const result = await notifications._deliverLifecycleEvent(name, recipient, { ...context, noRegionalContact: true });
            assert.equal(result.channels.email.success, true, name);
            assert.equal(result.channels.whatsapp.success, true, name);
            const body = bodyOf(messages.at(-1));
            assert(body.includes(`*${sample.label}:*\n`), `${name}: ${sample.label}`);
            assert(body.includes(sample.url));
            assert(body.includes(`*Event video:*\n${event.videoUrl}\n\n`));
            assert(body.includes(event.whatsappChannelUrl));
            assert(!body.includes('Event attendance'));
            assert(body.length <= 1024);
            const email = emails.at(-1);
            assert.equal(email.to, recipient.email);
            assert(email.html.includes(event.videoUrl.replace(/&/g, '&amp;')));
            assert(email.html.includes(event.whatsappChannelUrl));
            assert(email.html.replace(/&amp;/g, '&').includes(sample.url), `${name}: email attendance URL for ${sample.label}`);
            assert(email.files.some(file => file.path === event.attachments[0].url));
            if (sample.label === 'Venue directions') assert(!email.html.includes(event.onlineUrl.replace(/&/g, '&amp;')));
        }
    }
    for (const status of ['waitlist', 'pending', 'cancelled']) {
        const rendered = registry.render('EVENT_UPDATED', { ...await bookings.messageContext(booking, 'updated', { eventSnapshot: event }), bookingStatus: status });
        const output = JSON.stringify(rendered);
        for (const url of [event.videoUrl, event.onlineUrl, event.whatsappChannelUrl, event.attachments[0].url]) {
            assert(!output.includes(url), `${status} receives no private attendance resources`);
        }
        assert(bodyOf(rendered.whatsapp).includes('*Registration status:*'));
    }
    const legacyWaitlist = changes.registrationContext({ ...registration, status: 'waitlist' }, event);
    assert.equal(legacyWaitlist.registerUrl, '');
    assert.equal(legacyWaitlist.videoUrl, '');
    assert.deepEqual(legacyWaitlist.attachments, []);
    for (const [field, value, label] of [
        ['videoUrl', 'https://youtu.be/newfixture', 'event video'],
        ['whatsappChannelUrl', 'https://chat.whatsapp.com/NewFixture', 'WhatsApp updates link'],
        ['attachments', [{ name: 'Updated.pdf', url: 'https://example.test/new.pdf' }], 'supporting documents'],
        ['registrationNote', 'New instructions for attendees.', 'attendee instructions'],
    ]) {
        const updated = { ...event, [field]: value };
        assert(changes.describeChange(event, updated).changeSummary.includes(label));
        assert.notEqual(changes.registrationContext(registration, event).data.changeSnapshotKey,
            changes.registrationContext(registration, updated).data.changeSnapshotKey, 'Stale queued updates are invalidated');
        assert.equal(changes.describeChange(updated, { ...updated }), null, 'An unchanged resource does not trigger another notice');
    }
    const noVideo = registry.render('EVENT_BOOKING_CONFIRMED', { ...await bookings.messageContext(booking, 'confirmed', { eventSnapshot: event }), videoUrl: '' });
    assert(!bodyOf(noVideo.whatsapp).includes('*Event video:*'));
    const oversized = { ...await bookings.messageContext(booking, 'confirmed', { eventSnapshot: event }),
        attachments: [{ name: 'Large.pdf', url: 'https://example.test/large.pdf', size: 30 * 1024 * 1024 }] };
    const largeEmail = registry.render('EVENT_UPDATED', oversized).email;
    assert(largeEmail.afterHtml.includes('https://example.test/large.pdf'));
    assert(!largeEmail.afterHtml.includes('sent to you on WhatsApp'));
    // Review of the new layout must not drop the links from the accepted notice.
    for (const name of ['EVENT_BOOKING_CONFIRMED', 'EVENT_BOOKING_REMINDER', 'EVENT_UPDATED']) {
        const rendered = registry.render(name, await bookings.messageContext(booking, 'confirmed', { eventSnapshot: event }));
        let fallback = rendered.whatsapp;
        while (fallback && fallback.template !== 'activ_record_update_v1') fallback = fallback.fallback;
        assert(fallback, name);
        const body = bodyOf(fallback);
        for (const url of [event.onlineUrl, event.videoUrl, event.whatsappChannelUrl]) assert(body.includes(url), `${name}: fallback preserves ${url}`);
        assert(body.includes('Online registration link:'));
        assert(body.length <= 1024);
    }
    console.log(`PASS ${messages.length} complete email/WhatsApp dispatcher cases: registration/join/directions, legacy bookings, video/group/documents, updates, eligibility and exact links.`);
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
