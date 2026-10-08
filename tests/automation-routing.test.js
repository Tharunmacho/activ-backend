const assert = require('assert/strict');
const config = require('../src/config');
const bot = require('../src/modules/notifications/botbeeWebhook.service');
const membership = require('../src/modules/notifications/membershipBot');
const accounts = require('../src/modules/notifications/emailAccounts');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

async function main() {
    assert.equal(accounts.categoryForEvent('EVENT_BOOKING_CONFIRMED'), 'events');
    assert.equal(accounts.categoryForEvent('EVENT_PARTICIPANT_REMINDER'), 'events');
    assert.equal(accounts.categoryForEvent('APPLICATION_SUBMITTED'), 'membership');
    assert.equal(accounts.categoryForEvent('MEMBERSHIP_RENEWAL_DUE'), 'membership');
    assert.equal(accounts.categoryForEvent('PASSWORD_RESET'), 'membership');
    assert.equal(accounts.accountFor('events').user, config.email.user);
    assert.equal(accounts.accountFor('membership').user, config.email.user);
    assert.equal(accounts.accountFor('membership').defaultFrom, 'member@activ.org.in');
    const email = require('../src/modules/notifications/email.service');
    assert.equal(email.resolveSender(null, null, 'membership').fromEmail, 'member@activ.org.in');
    assert.equal(email.resolveSender(null, null, 'events').fromEmail, config.email.defaultFrom);
    const originalPassword = process.env.MEMBER_EMAIL_PASS;
    process.env.MEMBER_EMAIL_PASS = 'test-only-password';
    // Stubbed delivery must also work without a developer's local SMTP secrets.
    config.email.host = 'smtp.example.test';
    config.email.user = 'relay@example.test';
    config.email.password = 'test-only-password';
    const sent = [];
    email.initialised = true;
    email.transporter = { sendMail: async mail => { sent.push({ category:'events', from:mail.from }); return {messageId:'event-test'}; } };
    email.memberTransporter = { sendMail: async mail => { sent.push({ category:'membership', from:mail.from }); return {messageId:'member-test'}; } };
    await email.sendEmail({to:'test@example.com', subject:'Event', text:'Test', category:'events'});
    await email.sendEmail({to:'test@example.com', subject:'Membership', text:'Test', category:'membership'});
    assert.deepEqual(sent.map(row => row.category), ['events','membership']);
    assert.match(sent[1].from, /<member@activ.org.in>/);
    if (originalPassword === undefined) delete process.env.MEMBER_EMAIL_PASS; else process.env.MEMBER_EMAIL_PASS = originalPassword;

    for (const [text, command] of [['Member','STATUS'],['my membership status','STATUS'],['renew my membership','RENEW'],
        ['pay membership','PAYMENT'],['UPI','UPI'],['already paid','PAID'],['become member','REGISTER'],['hello','MENU']]) {
        assert.equal(bot.parseCommand(text), command, text);
    }
    assert.match(bot.notRegisteredReply(), /\/register/);
    const member = { fullName:'Tharun', membershipNumber:'ACTIV-123', membershipStatus:'pending' };
    assert.match(await membership.reply({ member, application:null }), /\/member\/forms\/personal/);
    assert.match(await membership.reply({ member, application:{status:'Pending'} }, 'UPI'), /No payment is due yet/);
    assert.match(await membership.reply({ member, application:{status:'Rejected',rejectionReason:'Update details'} }), /Update details/);
    assert.match(await membership.reply({ member, application:{status:'Approved'} }), /membership-plans/);
    assert.match(await membership.reply({ member:{...member,membershipStatus:'active',membershipType:'lifetime'},application:null },'UPI'), /No renewal is needed/);
    assert.match(await membership.reply({ member:{...member,membershipStatus:'active',membershipType:'annual',membershipExpiresAt:'2099-01-01'},application:null },'PAYMENT'), /No payment is due now/);
    assert.match(await membership.reply({ member:{...member,membershipStatus:'expired',membershipType:'annual',membershipExpiresAt:'2020-01-01'},application:null },'RENEW'), /renewal is available/);
    assert.match(await membership.reply({ member:{...member,membershipStatus:'cancelled'},application:null },'UPI'), /before making another payment/);
    const link = new URL(membership.upiLink({amount:5000,reference:'ACTIV 123',name:'Test & Name'}));
    assert.equal(link.searchParams.get('am'), '5000.00');
    assert.equal(link.searchParams.get('pa'), 'mab.037244012240037@axisbank');
    assert.equal(link.searchParams.get('tn'), 'Membership ACTIV 123 Test & Name');
    assert.equal(membership.upiLink({amount:0}), '');
    const { isWhatsAppEventLink, normalizeWhatsAppEventLink } = require('../src/modules/events/whatsappLink');
    assert.ok(isWhatsAppEventLink('https://chat.whatsapp.com/DdQbFhsqkp7izglTv2MqF?mode=ems_copy_c'));
    assert.ok(!isWhatsAppEventLink('https://chat.whatsapp.com.evil.test/abc'));
    for (const value of [
        '  chat.whatsapp.com/AbC123?mode=ems_copy_c  ',
        'https://CHAT.WHATSAPP.COM/AbC123?mode=ems_copy_c',
        'https://www.whatsapp.com/channel/0029AbC123',
        'https://chat.whatsapp.com/AbC123/#invite',
        '',
    ]) assert.ok(isWhatsAppEventLink(value), value);
    assert.equal(normalizeWhatsAppEventLink('  CHAT.WHATSAPP.COM/AbC123?mode=ems_copy_c  '),
        'https://chat.whatsapp.com/AbC123?mode=ems_copy_c');
    for (const value of [
        'https://chat.whatsapp.com/', 'https://chat.whatsapp.com/abc/extra',
        'https://chat.whatsapp.com@evil.test/abc', 'https://user@chat.whatsapp.com/abc',
        'javascript:alert(1)', 'http://chat.whatsapp.com/abc', 'https://chat.whatsapp.com:8080/abc',
        'https://chat.whatsapp.com/ab c', 'https://whatsapp.com/not-a-channel/abc',
    ]) assert.ok(!isWhatsAppEventLink(value), value);
    const Event = require('../src/modules/events/event.model');
    const inviteDoc = new Event({ whatsappChannelUrl: ' chat.whatsapp.com/AbC123?mode=ems_copy_c ' });
    assert.equal(inviteDoc.whatsappChannelUrl, 'https://chat.whatsapp.com/AbC123?mode=ems_copy_c');
    assert.equal(inviteDoc.validateSync()?.errors?.whatsappChannelUrl, undefined);
    assert.ok(new Event({ whatsappChannelUrl: 'https://example.test/invite' }).validateSync()?.errors?.whatsappChannelUrl);
    const flex = require('../src/modules/notifications/whatsappFlex');
    const result = flex.readableParams('confirmed', {eventTitle:'Event',bookingRef:'REF',viewUrl:'https://activ.org.in/events/test',whatsappChannelUrl:'https://chat.whatsapp.com/abc123',videoUrl:'https://youtu.be/abc',seats:1});
    assert.match(result.rendered, /\*WhatsApp group:\*\nhttps:\/\/chat.whatsapp.com\/abc123/);
    assert.match(result.rendered, /\*Event video:\*\nhttps:\/\/youtu.be\/abc/);
    assert.equal(result.params[9], 'https://activ.org.in/events/test');
    assert.ok(result.params.every(value => !/[\r\n]/.test(value)));
    assert.ok(result.rendered.length <= 1024);
    const groupContext = {eventTitle:'Event',bookingRef:'REF',viewUrl:'https://activ.org.in/events/test',whatsappChannelUrl:'https://chat.whatsapp.com/abc123',seats:1};
    const steps = flex.flexSteps('confirmed', groupContext, flex.READABLE_NAMES.confirmed);
    assert.equal(steps[0].template, 'activ_evt_confirmed_whatsapp_image_v2');
    assert.equal(steps[0].params.length, 12);
    assert.equal(steps[0].params[10], 'WhatsApp group');
    assert.equal(steps[0].params[11], groupContext.whatsappChannelUrl);
    assert.equal(steps[1].template, flex.READABLE_NAMES.confirmed.image);
    assert.equal(steps[1].params.length, 10);
    assert.equal(steps[1].params[9], groupContext.viewUrl);
    const pdfContext = {...groupContext,attachments:[{name:'Agenda.pdf',url:'https://api.activ.org.in/uploads/agenda.pdf',type:'application/pdf'}]};
    const pdfMessage = flex.readableParams('confirmed',pdfContext);
    assert.ok(pdfMessage.rendered.indexOf('Supporting PDF') > pdfMessage.rendered.indexOf('WhatsApp group'));
    assert.match(pdfMessage.rendered,/Open document:\* https:\/\/api.activ.org.in\/uploads\/agenda.pdf/);
    const pdfSteps = flex.flexSteps('confirmed',pdfContext,flex.READABLE_NAMES.confirmed);
    assert.equal(pdfSteps[0].template,'activ_evt_confirmed_whatsapp_document_image_v3');
    assert.equal(pdfSteps[0].params.length,14);
    assert.equal(pdfSteps[1].template,'activ_evt_confirmed_whatsapp_image_v2');
    console.log('Email account routing, membership journeys, UPI amount/encoding and group links passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
