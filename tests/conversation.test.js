const assert = require('assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const bot = require('../src/modules/notifications/botbeeWebhook.service');
const plans = require('../src/modules/members/membershipplan.service');
const incomplete = { member: { fullName: 'Test Member', membershipStatus: 'pending' }, application: null };
const pending = { ...incomplete, application: { status: 'Pending' } };
const incoming = text => ({ from: '919999999999', text });

async function main() {
    for (const [text, intent] of [
        ['Sir once u check sir', 'STATUS'], ['hi what is my application status?', 'STATUS'],
        ['Hello how much is the membership fee?', 'FEES'], ['What are the benefits?', 'BENEFITS'],
        ['I need to fill my business details', 'FORMS'], ['Where do I upload documents?', 'FORMS'],
        ['I forgot my password', 'RESET'], ['Can I login using Google?', 'LOGIN'],
        ['Change my WhatsApp number', 'PROFILE'], ['Please send my membership card', 'CARD'],
        ['I have not paid', 'PAYMENT_ISSUE'], ['Money deducted but payment failed', 'PAYMENT_ISSUE'],
        ['I already paid membership fee', 'PAID'], ['I want to renew membership', 'RENEW'],
        ['Hello I want to register for the event', 'EVENTS'], ['thank you sir', 'THANKS'],
        ['ok sir', 'ACK'], ['How are you?', 'SOCIAL'], ['Hello sir', 'MENU'], ['வணக்கம்', 'MENU'],
        ['what should I do next?', 'FOLLOWUP'], ['something unrelated', null]
    ]) assert.equal(bot.parseCommand(text), intent, text);

    const check = await bot.composeReply(incoming('Sir once u check sir'), incomplete);
    assert.equal(check.command, 'STATUS');
    assert.match(check.reply, /not been submitted/);
    assert.doesNotMatch(check.reply, /could not match|Reply with one of/);
    const hello = await bot.composeReply(incoming('Hello sir'), incomplete);
    assert.match(hello.reply, /normal sentences/);
    assert.match(hello.reply, /not been submitted/);
    for (const identity of [null, incomplete, { ambiguous: true }, { unavailable: true }]) {
        assert.match((await bot.composeReply(incoming('thank you sir'), identity)).reply, /welcome/);
        assert.match((await bot.composeReply(incoming('forgot password'), identity)).reply, /forgot-password/);
    }
    const unknown = await bot.composeReply(incoming('Sir please'), incomplete);
    assert.equal(unknown.command, 'CLARIFY');
    assert.doesNotMatch(unknown.reply, /could not match|Reply with one of|not registered/);
    const forms = await bot.composeReply(incoming('How do I fill the form?'), incomplete);
    assert.match(forms.reply, /forms\/personal/); assert.match(forms.reply, /forms\/declaration/);
    const noPayment = await bot.composeReply(incoming('Please send direct UPI payment'), pending);
    assert.match(noPayment.reply, /No payment is due yet/); assert.doesNotMatch(noPayment.reply, /upi:\/\//);
    const followup = await bot.composeReply(incoming('send link'), pending, { previousCommand: 'UPI' });
    assert.equal(followup.command, 'UPI'); assert.match(followup.reply, /No payment is due yet/);
    const reset = await bot.composeReply(incoming('where to go'), incomplete, { previousCommand: 'RESET' });
    assert.equal(reset.command, 'RESET'); assert.match(reset.reply, /forgot-password/);
    const safe = await bot.composeReply(incoming('check sir'), { ambiguous: true });
    assert.match(safe.reply, /more than one/); assert.doesNotMatch(safe.reply, /Test Member/);
    plans.listActive = async () => [{ name: 'CMS plan', price: 1234, audience: 'business', experience: '0 – 5 years',
        membershipType: 'annual', features: ['Current CMS benefit'] }];
    const fees = await bot.composeReply(incoming('Hi how much membership fees'), null);
    assert.match(fees.reply, /1,234/); assert.match(fees.reply, /approval is required/);
    assert.doesNotMatch(fees.reply, /upi:\/\//);
    const benefits = await bot.composeReply(incoming('benefits'), null);
    assert.match(benefits.reply, /Current CMS benefit/);
    plans.listActive = async () => { throw new Error('offline'); };
    assert.match((await bot.composeReply(incoming('fees'), null)).reply, /membership-plans/);
    console.log('Natural sentences, conversational replies, live plan content, same-phone follow-ups and payment guards passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
