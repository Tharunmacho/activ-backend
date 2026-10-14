// Exercise retry routing with provider/model guards stubbed; no external calls.
const assert = require('assert/strict');
const Log = require('../src/modules/notifications/notificationLog.model');
const changes = require('../src/modules/events/eventChanges.service');
const bookings = require('../src/modules/events/eventbooking.service');
const sender = require('../src/modules/notifications/whatsappTemplate');
const email = require('../src/modules/notifications/email.service');
const service = require('../src/modules/notifications/notification.service');
const logId = '1234567890abcdef12345678';
let current, reason = '', guardCalls = 0, sends = 0, bookingRebuilds = 0;
Log.findById = async () => current;
changes.reasonToSkipRegistrationNotice = async () => { guardCalls++; return reason; };
bookings.resendLoggedMessage = async () => { bookingRebuilds++; return { skipped: true, reason: 'Fixture modern booking missing' }; };
sender.sendTemplateMessage = email.sendEmail = async () => { sends++; return { success: true, messageId: 'fixture-message' }; };
function row(event, channel = 'whatsapp', data = { lifecycleData: { registrationId: 'legacy-registration' } }) {
    return { _id: logId, event, channel, recipient: channel === 'email' ? 'fixture@example.test' : '919999999999',
        templateId: 'approved-template', data: { ...data, params: ['Fixture'], emailHtml: '<p>Fixture</p>' },
        status: 'failed', deliveryStatus: 'failed', async save() { return this; } };
}
async function main() {
    for (const event of ['EVENT_REGISTERED', 'EVENT_REMINDER', 'EVENT_BOOKING_WAITLISTED']) {
        for (const channel of ['whatsapp', 'email']) {
            current = row(event, channel); reason = 'Registration cancelled';
            const prior = sends;
            assert.equal((await service.retryLog(logId)).skipped, true);
            assert.equal(sends, prior, `${event} ${channel} cannot replay cancelled records`);
            reason = '';
            assert.equal((await service.retryLog(logId)).outcome.success, true);
            assert.equal(sends, prior + 1);
        }
    }
    assert.equal(guardCalls, 12);
    assert.equal(bookingRebuilds, 0, 'validated legacy rows do not enter modern booking lookup');
    current = row('EVENT_REMINDER', 'whatsapp', {}); reason = 'Original registration cannot be verified';
    assert.equal((await service.retryLog(logId)).skipped, true, 'old reminders without metadata fail closed');
    current = row('EVENT_BOOKING_WAITLISTED', 'whatsapp', {});
    assert.equal((await service.retryLog(logId)).skipped, true);
    assert.equal(bookingRebuilds, 1, 'modern waitlist rows retain their current-state rebuild');
    console.log('Legacy notification retry routing passed: current-state guard, both channels and separated legacy/modern waitlists.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
