// Offline formatting and actual dispatcher fallback tests. No provider/DB I/O.
const assert = require('node:assert/strict');
const standard = require('../src/modules/notifications/whatsappStandard');
const registry = require('../src/modules/notifications/notificationTemplates');
const flex = require('../src/modules/notifications/whatsappFlex');
const service = require('../src/modules/notifications/notification.service');
const sender = require('../src/modules/notifications/whatsappTemplate');
const botbee = require('../src/modules/notifications/botbee.service');
const config = require('../src/config');
const { sendDocument } = require('../src/modules/events/eventDocument');
const context = { noRegionalContact: true, name: 'Fixture member', firstName: 'Fixture', bookerName: 'Fixture booker',
    eventTitle: 'Fixture workshop', bookingRef: 'ACTIVB-FIXTURE', dateLabel: '23 October 2026', timeLabel: '10:00 AM IST',
    whenLabel: '23 October 2026, 10:00 AM IST', startsInLabel: 'tomorrow', venueLabel: 'Fixture hall',
    viewUrl: 'https://activ.org.in/events/workshop/book?ref=ACTIVB-FIXTURE', eventUrl: 'https://activ.org.in/events/workshop',
    seats: 2, seatsLabel: '2 seats', settledVia: 'online', amountLabel: 'Rs 500', paymentLabel: 'Paid online',
    reason: 'Duplicate booking', planName: 'Intermediate', previousPlanName: 'Beginner', feeLabel: 'Rs 1,000',
    membershipNumber: 'ACTIV-BEG-20261012-001', validUntilLabel: '11 October 2027', orderId: 'ORD-FIXTURE',
    companyName: 'Fixture company', reference: 'APPLICATION-FIXTURE' };
const events = ['EVENT_BOOKING_CONFIRMED','EVENT_PARTICIPANT_CONFIRMED','EVENT_REGISTERED','EVENT_BOOKING_REMINDER',
    'EVENT_PARTICIPANT_REMINDER','EVENT_REMINDER','EVENT_BOOKING_CANCELLED','EVENT_PARTICIPANT_CANCELLED','EVENT_BOOKING_WAITLISTED',
    'PAYMENT_FAILED','EVENT_PAYMENT_FAILED','COMPANY_PAYMENT_CONFIRMED','MEMBERSHIP_PLAN_ADVANCED','MEMBERSHIP_STATUS_CHANGED','EVENT_UPDATED','EVENT_CANCELLED'];
async function main() {
    assert.equal(standard.WHATSAPP_TEMPLATES.length, 18);
    for (const definition of standard.WHATSAPP_TEMPLATES) assert.deepEqual(flex.lintTemplate(definition), [], definition.name);
    for (const event of events) for (const online of [false, true]) for (const channel of ['', 'https://whatsapp.com/channel/FIXTURE']) {
        const ctx = { ...context, isOnline: online, onlinePlatform: 'Zoom', participantName: 'Fixture attendee',
            whatsappChannelUrl: channel, ...(online ? { registerUrl: 'https://zoom.us/meeting/register/FIXTURE' } : {}) };
        const rendered = standard.prepare(event, ctx);
        assert.ok(rendered, event);
        assert.ok(rendered.rendered.length <= 1024, event);
        assert.ok(rendered.params.every(value => value && !/[\r\n\t]| {5,}/.test(value)), event);
        assert.ok(!/\*Details:\*.*Seats:.*Queries:/.test(rendered.rendered));
        assert.ok(rendered.rendered.includes(/^EVENT_/.test(event) ? 'events@activ.org.in' : 'member@activ.org.in'));
        const actual = registry.render(event, ctx).whatsapp;
        assert.ok(/_standard_/.test(actual.template), event);
        assert.ok(actual.fallback, 'Existing approved fallback is retained');
        if (event.startsWith('EVENT_PARTICIPANT_')) {
            assert.ok(!actual.params.includes('Rs 500'), 'Participant does not receive the booker payment');
            assert.ok(!actual.params.includes(context.viewUrl), 'Participant does not receive the booker management URL');
        }
        if (channel && /^EVENT_.*_(CONFIRMED|REMINDER)$|^EVENT_REMINDER$/.test(event)) {
            assert.ok(rendered.rendered.includes(`*WhatsApp updates for this event:*\n${channel}\n\n`), 'Channel has its own labelled line');
        }
    }
    const huge = standard.prepare('EVENT_BOOKING_REMINDER', { ...context, name: 'Name '.repeat(200),
        eventTitle: 'Event '.repeat(300), venueLabel: 'Venue '.repeat(300) });
    assert.ok(huge && huge.rendered.length <= 1024);
    assert.ok(huge.params.includes(context.bookingRef));
    assert.ok(huge.params.includes(context.viewUrl));
    assert.equal(standard.prepare('EVENT_BOOKING_REMINDER', { ...context, viewUrl: `https://activ.org.in/${'x'.repeat(1500)}` }), null,
        'An oversize exact URL is never silently damaged');
    for (const event of ['ACCOUNT_REGISTERED','APPLICATION_SUBMITTED','APPLICATION_ENDORSED','APPLICATION_APPROVED',
        'CORRECTION_REQUESTED','PAYMENT_REQUIRED','MEMBERSHIP_ACTIVATED','MEMBERSHIP_RENEWAL_DUE']) {
        const out = registry.render(event, context);
        assert.ok(out.whatsapp.template && !/_standard_/.test(out.whatsapp.template), 'Existing sectioned member templates are preserved');
    }
    config.botbee.alsoSendText = true;
    service.log = async row => row;
    const calls = [];
    const textCalls = [];
    let failure = '';
    let refuseAllTemplates = false;
    botbee.sendTextMessage = async (to, text) => {
        textCalls.push({ to, text });
        return { success: true, provider: 'botbee', messageId: 'offline-text-fixture', to };
    };
    sender.sendTemplateMessage = async (to, template, params, language, text, options) => {
        calls.push({ to, template, params, options });
        return failure && (refuseAllTemplates || /_standard_/.test(template))
            ? { success: false, provider: 'meta', error: failure, template }
            : { success: true, provider: 'meta', messageId: 'offline-fixture', template };
    };
    const recipient = { name: 'Fixture member', phone: '919999999999' };
    const dispatch = () => service._deliverLifecycleEvent('EVENT_BOOKING_REMINDER', recipient, context);
    failure = '132001 Template name does not exist';
    const fallback = await dispatch();
    assert.ok(fallback.channels.whatsapp.success);
    assert.ok(calls.length > 1 && !/_standard_/.test(calls.at(-1).template), 'Pending new layouts fall back to the approved chain');
    assert.equal(textCalls.length, 0, 'An accepted approved fallback does not also send text');
    for (const error of ['ETIMEDOUT', 'Token expired', '131026 Message undeliverable']) {
        calls.length = 0; failure = error;
        const result = await dispatch();
        assert.equal(result.channels.whatsapp.success, false);
        assert.equal(calls.length, 1, 'Uncertain/permanent failures do not send duplicate template attempts');
        assert.equal(textCalls.length, 0, 'Uncertain/permanent failures do not send a second body through text rescue');
    }
    refuseAllTemplates = true; failure = '132001 Template name does not exist'; calls.length = 0;
    const definiteRefusal = await dispatch();
    assert.equal(definiteRefusal.channels.whatsapp.success, false);
    assert.ok(calls.length > 1, 'Definite refusals still walk the template fallback chain');
    assert.equal(textCalls.length, 1, 'Definite refusals retain one configured text rescue after templates are exhausted');
    assert.equal(definiteRefusal.rows.whatsappText.providerMessageId, 'offline-text-fixture');
    refuseAllTemplates = false;
    const params = ['Fixture member','Agenda.pdf','Fixture workshop','23 October 2026, 10 AM IST','ACTIVB-FIXTURE'];
    const header = { link: 'https://example.invalid/agenda.pdf', filename: 'Agenda.pdf' };
    failure = ''; calls.length = 0;
    assert.equal((await sendDocument(recipient.phone, 'activ_event_document_v1', params, header)).template, 'activ_event_document_standard_v1');
    assert.deepEqual(calls[0].params, params);
    assert.deepEqual(calls[0].options.headerDocument, header);
    failure = 'Template is not approved'; calls.length = 0;
    assert.equal((await sendDocument(recipient.phone, 'activ_event_document_v1', params, header)).template, 'activ_event_document_v1');
    assert.equal(calls.length, 2);
    failure = 'ETIMEDOUT'; calls.length = 0;
    assert.equal((await sendDocument(recipient.phone, 'activ_event_document_v1', params, header)).outcome.success, false);
    assert.equal(calls.length, 1);
    failure = ''; calls.length = 0;
    assert.equal((await sendDocument(recipient.phone, 'custom_document', params, header)).template, 'custom_document');
    console.log('PASS standard WhatsApp layouts: 18 definitions, 16 workflows, online/offline/channel matrix, participant privacy, exact IDs/URLs, approved fallbacks and document captions.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
