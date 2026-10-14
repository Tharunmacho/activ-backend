// Offline: every send is recorded locally, with no database or provider calls.
const assert = require('assert/strict');
const config = require('../src/config');
const sender = require('../src/modules/notifications/whatsappTemplate');
const { sendChannel } = require('../src/modules/events/eventChannel');
const calls = [];
let error = '';
sender.sendTemplateMessage = async (...args) => {
    calls.push(args);
    return args[1] === config.botbee.templates.eventChannel && error
        ? { success: false, error } : { success: true, messageId: 'fixture-accepted' };
};
async function main() {
    config.botbee.templates.eventChannel = 'activ_event_channel_v2';
    config.botbee.templates.event = 'approved-event';
    const context = { eventTitle: 'Fixture event', bookingRef: 'TEST-BOOKING', whenLabel: 'Future fixture date',
        whatsappChannelUrl: 'https://whatsapp.com/channel/TEST' };
    const approved = await sendChannel('919999999999', 'Fixture member', context);
    assert.equal(approved.template, 'activ_event_channel_v2');
    assert.equal(calls.length, 1);
    assert.deepEqual(approved.params, [context.eventTitle, context.bookingRef, context.whatsappChannelUrl]);
    for (const reason of ['(#132001) Template name does not exist in the translation', 'Message template is not approved']) {
        calls.length = 0; error = reason;
        const fallback = await sendChannel('919999999999', 'Fixture member', context);
        assert.equal(fallback.outcome.success, true);
        assert.equal(calls.length, 2);
        assert.equal(fallback.template, 'approved-event');
        assert.equal(fallback.requestedTemplate, 'activ_event_channel_v2');
        assert.ok(fallback.params[2].includes(context.whatsappChannelUrl));
        assert.ok(fallback.params[2].includes(context.bookingRef));
        assert.ok(fallback.params[2].includes('events@activ.org.in'));
    }
    for (const reason of ['ETIMEDOUT', 'Invalid phone number', '131026 Message undeliverable', 'Token expired']) {
        calls.length = 0; error = reason;
        const result = await sendChannel('919999999999', 'Fixture member', context);
        assert.equal(result.outcome.success, false);
        assert.equal(calls.length, 1, 'uncertain/permanent failures do not produce duplicate fallback sends');
    }
    console.log('Event channel delivery checks passed: dedicated utility, approved fallback retaining link/contact, and no fallback for uncertain outcomes.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
