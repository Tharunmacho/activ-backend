// Real rendering + dispatcher + email envelope; only provider I/O and logs
// are replaced. No database, email or WhatsApp message is sent by this test.
const assert = require('node:assert/strict');
const config = require('../src/config');
const templates = require('../src/modules/notifications/notificationTemplates');
const email = require('../src/modules/notifications/email.service');
const whatsapp = require('../src/modules/notifications/whatsappTemplate');
const service = require('../src/modules/notifications/notification.service');
const context = {
    noRegionalContact: true, reference: 'TEST-APP', applicationRef: 'TEST-APP',
    memberTypeLabel: 'Business membership', businessName: 'Test business',
    submittedLabel: '13 October 2026', endorsedBy: 'Test Block Admin', endorsedTierLabel: 'Block',
    decidedBy: 'Test State Admin', reason: 'Update the unreadable document',
    planName: 'Beginner', membershipNumber: 'ACTIV-BEG-20261013-001',
    feeLabel: 'Rs 100', amountLabel: 'Rs 100', orderId: 'TEST-ORDER',
    activatedLabel: '13 October 2026', validUntilLabel: '12 October 2027',
    daysLeft: 30, expiresInLabel: 'in 30 days', paymentUrl: 'https://activ.org.in/payment/membership-plans',
    eventTitle: 'Test event', bookingRef: 'TEST-BOOKING', dateLabel: '15 October 2026',
    timeLabel: '10:00 AM IST', whenLabel: '15 October 2026, 10:00 AM IST',
    venue: 'Test hall', venueLabel: 'Test hall', seats: 1, seatsLabel: '1 seat',
    settledVia: 'online', paymentLabel: 'Paid online', language: 'English',
    contactName: 'Event organiser', contactPhone: '+919999999999',
    contactEmail: 'old-contact@example.test', contactLine: 'old-contact@example.test',
    viewUrl: 'https://activ.org.in/events/test/book?ref=TEST-BOOKING',
    eventUrl: 'https://activ.org.in/events/test', registerUrl: 'https://meet.google.com/test',
    participantName: 'Test attendee', bookerName: 'Test booker',
    applicantName: 'Test applicant', applicantRegion: 'Test region',
};
const recipient = { name: 'Test member', phone: '919999999999', email: 'test@example.invalid', state: 'Tamil Nadu', district: 'Test district', block: 'Test block' };
const emailEvents = [];
const waEvents = [];
let activeEvent;
email.getTransporter = () => ({ sendMail: async mail => {
    emailEvents.push({ event: activeEvent, ...mail }); return { messageId: `email-${activeEvent}` };
} });
config.email.host = 'smtp.example.test'; config.email.user = 'test'; config.email.password = 'test';
config.email.isConfigured = true;
whatsapp.sendTemplateMessage = async (to, template, params) => {
    waEvents.push({ event: activeEvent, template, params });
    return { success: true, provider: 'meta', to, template, messageId: `wa-${activeEvent}` };
};
service.log = async entry => entry;
async function main() {
    const companyFailure = templates.render('PAYMENT_FAILED', { ...context, ...recipient, orderType: 'company_listing' });
    assert.equal(companyFailure.email.title, 'Business publishing payment attempt unsuccessful');
    assert.equal(companyFailure.email.actionButton.label, 'View payment status');
    const companyReceipt = templates.render('COMPANY_PAYMENT_CONFIRMED', { ...context, ...recipient });
    assert.equal(companyReceipt.email.actionButton.label, 'View receipt');
    const events = Object.keys(templates.TEMPLATES);
    for (const event of events) {
        activeEvent = event;
        const expectedEmail = /^EVENT_/.test(event) ? 'events@activ.org.in' : 'member@activ.org.in';
        const spec = templates.render(event, { ...context, ...recipient, firstName: 'Test' });
        const result = await service.dispatchLifecycleEvent(event, recipient, context);
        if (spec.email) {
            assert.equal(result.channels.email?.success, true, `${event}: email dispatched`);
            const mail = emailEvents.find(row => row.event === event);
            assert.ok(mail, `${event}: email reaches provider`);
            assert.ok(mail.from.includes(expectedEmail), `${event}: sender inbox`);
            assert.equal(mail.replyTo, expectedEmail, `${event}: replies inbox`);
            assert.ok(mail.html.includes(expectedEmail), `${event}: body queries inbox`);
            assert.ok(!mail.html.includes('old-contact@example.test'), `${event}: old event contact not published`);
        }
        if (spec.whatsapp?.template) {
            assert.equal(result.channels.whatsapp?.success, true, `${event}: WhatsApp dispatched`);
            const sent = waEvents.find(row => row.event === event);
            assert.ok(sent, `${event}: WhatsApp reaches provider`);
            if (!/^ADMIN_/.test(event) && event !== 'ACCOUNT_REGISTERED') {
                assert.ok(sent.params.join(' ').includes(expectedEmail), `${event}: WhatsApp queries inbox`);
            }
            assert.ok(!sent.params.join(' ').includes('old-contact@example.test'), `${event}: old email not sent`);
        }
    }
    // Online, participant and oversized messages must retain the official inbox.
    for (const event of ['EVENT_BOOKING_CONFIRMED', 'EVENT_BOOKING_REMINDER', 'EVENT_BOOKING_CANCELLED',
        'EVENT_BOOKING_WAITLISTED', 'EVENT_PARTICIPANT_CONFIRMED', 'EVENT_PARTICIPANT_REMINDER', 'EVENT_PARTICIPANT_CANCELLED']) {
        for (const isOnline of [false, true]) {
            const out = templates.render(event, { ...context, ...recipient, isOnline, supportEmail: '',
                eventTitle: 'Long event title '.repeat(25), attendeeNote: 'Note '.repeat(400),
                participantNames: Array.from({ length: 10 }, (_, i) => `Participant ${i}`) });
            for (let step = out.whatsapp; step; step = step.fallback) {
                assert.ok(step.params.join(' ').includes('events@activ.org.in'), `${event}: ${step.template} keeps support`);
                assert.ok(step.params.every(value => !/[\r\n]/.test(value)), `${event}: Meta-safe parameters`);
            }
        }
    }
    console.log(`${events.length} notification types checked; ${emailEvents.length} email and ${waEvents.length} WhatsApp dispatch paths passed. Event/member sender, reply-to, body, fallback and long-message contact checks passed.`);
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
