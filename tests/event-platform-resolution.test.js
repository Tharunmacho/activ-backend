// Pure context/render regressions: no database connection and no messages sent.
process.env.NODE_ENV = 'test';
process.env.EVENT_REMINDERS_ENABLED = 'false';
process.env.PAYMENT_RECONCILE_ENABLED = 'false';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const bookings = require('../src/modules/events/eventbooking.service');
const changes = require('../src/modules/events/eventChanges.service');
const registry = require('../src/modules/notifications/notificationTemplates');
const flex = require('../src/modules/notifications/whatsappFlex');

const event = {
    _id: '507f1f77bcf86cd799439011', title: 'Business opportunities', slug: 'business-opportunities',
    status: 'published', startAt: new Date('2030-11-01T09:30:00Z'), endAt: new Date('2030-11-01T12:30:00Z'),
    mode: 'online', onlineUrl: 'https://meet.google.com/abc-defg-hij',
    onlinePlatform: '', category: 'ZOOM', venue: 'Zoom', venueAddress: '',
};
const booking = {
    eventId: event._id, bookingRef: 'ACTIVB-PLATFORM-TEST', status: 'active',
    bookedBy: { name: 'Fixture attendee' }, noOfPersons: 1, totalAmount: 0,
    payment: { status: 'not_required' }, participants: [],
};
const registration = { _id: '507f1f77bcf86cd799439012', eventId: event._id,
    status: 'registered', payment: { status: 'not_required' } };
const lifecycle = [
    ['confirmed', 'EVENT_BOOKING_CONFIRMED', 'EVENT_REGISTERED'],
    ['reminder', 'EVENT_BOOKING_REMINDER', 'EVENT_REMINDER'],
    ['updated', 'EVENT_UPDATED', 'EVENT_UPDATED'],
];
const bodyOf = message => {
    const definition = registry.WHATSAPP_TEMPLATES.find(item => item.name === message.template);
    // Installations may configure a provider-owned final fallback whose fixed
    // body is not local; its dynamic parameters still must obey this policy.
    return definition ? flex.renderBody(definition.bodyWithVariables, message.params) : (message.params || []).join('\n');
};
const withoutUrls = text => text.replace(/https?:\/\/[^\s"<>]+/g, '');

async function main() {
    let cases = 0;
    for (const sample of [
        { saved: '', url: event.onlineUrl, expected: '' },
        { saved: undefined, url: 'https://zoom.us/j/123456789', expected: '' },
        { saved: '   ', url: 'https://zoom.us/meeting/register/test', expected: '' },
        { saved: '', url: '', expected: '' },
        { saved: 'Google Meet', url: event.onlineUrl, expected: 'Google Meet' },
        { saved: 'zoom', url: 'https://zoom.us/meeting/register/test', expected: 'Zoom' },
        // Saved custom platforms remain exactly as the organiser entered them.
        { saved: 'ACTIV private meeting room', url: 'https://example.test/room', expected: 'ACTIV private meeting room' },
        { saved: 'Zoom partner classroom', url: 'https://example.test/classroom', expected: 'Zoom partner classroom' },
    ]) {
        const snapshot = { ...event, onlinePlatform: sample.saved, onlineUrl: sample.url };
        assert.equal(bookings.attendanceOf(snapshot).platform, sample.expected);
        for (const [kind, bookingName, legacyName] of lifecycle) {
            const contexts = [
                [bookingName, await bookings.messageContext(booking, kind, { eventSnapshot: snapshot })],
                [legacyName, changes.registrationContext(registration, snapshot)],
            ];
            for (const [name, context] of contexts) {
                cases++;
                assert.equal(context.onlinePlatform, sample.expected, name);
                assert.equal(context.venueLabel, sample.expected ? `Online (${sample.expected})` : 'Online', name);
                assert.equal(context.registerUrl, sample.url, `${name}: private link is preserved`);
                const result = registry.render(name, context);
                const body = bodyOf(result.whatsapp);
                assert(body.includes(`*Where:* ${sample.expected ? `Online on ${sample.expected}` : 'Online'}\n`), name);
                if (sample.url) assert(body.includes(sample.url), `${name}: joining/registration link survives`);
                assert(result.email, name);
                if (!sample.expected) {
                    // Include fallback template bodies and free text, not just the first template.
                    const output = [JSON.stringify(result)];
                    for (let message = result.whatsapp; message; message = message.fallback) output.push(bodyOf(message));
                    assert(!/\bZoom\b|Google Meet|Online webinar/i.test(withoutUrls(output.join('\n'))), `${name}: no inferred platform`);
                    for (const fact of result.email.facts || []) {
                        if (/^(format|where|venue)$/i.test(fact.label)) assert.equal(fact.value, 'Online', name);
                    }
                }
            }
        }
    }
    // Legacy records still infer online mode from a link/category, without inferring a platform label.
    const legacy = { ...event, mode: 'offline' };
    assert.equal(bookings.attendanceOf(legacy).isOnline, true);
    assert.equal(bookings.attendanceOf(legacy).platform, '');
    const realVenue = { ...legacy, venue: 'Community Hall', venueAddress: 'Chennai',
        venueMapUrl: 'https://maps.google.com/?q=Community+Hall', onlinePlatform: 'Zoom' };
    assert.equal(bookings.attendanceOf(realVenue).isOnline, false);
    const inPerson = await bookings.messageContext(booking, 'confirmed', { eventSnapshot: realVenue });
    assert.equal(inPerson.venueLabel, 'Community Hall, Chennai');
    assert.equal(inPerson.registerUrl, '');
    assert.equal(inPerson.mapUrl, realVenue.venueMapUrl);
    assert(bodyOf(registry.render('EVENT_BOOKING_CONFIRMED', inPerson).whatsapp).includes('*Where:* Community Hall, Chennai'));

    // Even a stale/replayed descriptive label cannot override a blank optional platform.
    const stale = { ...await bookings.messageContext(booking, 'confirmed', { eventSnapshot: event }),
        onlinePlatform: ' ', venue: 'Online (Zoom)', venueLabel: 'Online (Zoom)', formatLabel: 'Online webinar on Zoom' };
    const rendered = registry.render('EVENT_BOOKING_CONFIRMED', stale);
    assert(!/\bZoom\b/.test(withoutUrls(JSON.stringify(rendered))));
    assert.equal(stale.venueLabel, 'Online (Zoom)', 'Rendering must not mutate the saved context');
    for (const status of ['waitlist', 'pending', 'cancelled']) {
        const restricted = registry.render('EVENT_UPDATED', { ...stale, bookingStatus: status });
        assert(!JSON.stringify(restricted).includes(event.onlineUrl), `${status}: no private joining link`);
    }
    console.log(`PASS ${cases} event lifecycle cases: explicit platform only, blank Online labels, every WhatsApp fallback, private links and physical venues.`);
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
