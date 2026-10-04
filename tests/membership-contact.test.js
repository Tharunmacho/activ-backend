// Rendering and reply composition only. No SMTP, WhatsApp or database calls.
const assert = require('node:assert/strict');
const email = require('../src/modules/notifications/email.service');
const bot = require('../src/modules/notifications/botbeeWebhook.service');
const office = require('../src/modules/notifications/membershipContact');
const regional = { fromName: 'District Admin', replyTo: 'district@example.test',
    nearest: { name: 'Regional Fixture', regionName: 'District Fixture', tierLabel: 'District', phone: '9000000000' } };
async function main() {
    const sender = email.resolveSender(regional, 'state@example.test', 'membership');
    assert.equal(sender.replyTo, office.email);
    assert.equal(sender.fromName, office.name);
    assert.equal(sender.fromEmail, office.email);
    process.env.MEMBER_EMAIL_FROM = 'regional@example.test';
    assert.equal(email.resolveSender(regional, null, 'membership').fromEmail, office.email, 'an old regional sender setting cannot override the central membership sender');
    delete process.env.MEMBER_EMAIL_FROM;
    const html = email.buildHtmlTemplate({ title: 'Member activated', bodyHtml: '<p>Membership active.</p>', contact: regional });
    assert(html.includes(office.email) && html.includes(office.phone));
    assert(!html.includes('Regional Fixture') && !html.includes('District Fixture') && !html.includes('9000000000'));
    assert.equal(email.resolveSender(regional, 'event@example.test', 'events').replyTo, 'event@example.test');
    const eventHtml = email.buildHtmlTemplate({ title: 'Event booked', bodyHtml: '<p>Event confirmed.</p>', category: 'events', contact: regional });
    assert(eventHtml.includes('District Fixture'), 'event contact behavior is preserved');
    const reply = await bot.helpReply({ member: { fullName: 'Member Fixture', state: 'Region Fixture' } });
    assert(reply.includes(office.email) && reply.includes(office.phone));
    assert(!reply.includes('District Admin') && !reply.includes('Region Fixture'));
    const notices = require('../src/modules/notifications/notification.service');
    const saved = ['Member', 'ID', 'Student', 'Rs 500', '3 Oct 2027', 'https://example.test/dashboard', 'https://example.test/certificate', 'District Admin', '9000000000', 'district@example.test'];
    const params = notices.retryParams({event:'MEMBERSHIP_ACTIVATED', templateId:'activ_membership_active_v1'}, {params:saved});
    assert.deepEqual(params.slice(-3), [office.name, office.phone, office.email]);
    assert.deepEqual(notices.retryParams({event:'EVENT_BOOKING_CONFIRMED'}, {params:saved}), saved);
    console.log('Membership contact: central sender/reply-to, email footer and WhatsApp HELP passed; event contact behavior preserved.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
