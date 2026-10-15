#!/usr/bin/env node
// Explicitly authorized by the user. Fixed recipients, no DB connection, no
// publication and no profile edits. Default creates a preview without sending.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
// Do not send the test to the normal office/archive mailbox.
process.env.EMAIL_ARCHIVE_COPY = 'off';
const allowedEmail = 'tharunroobika@gmail.com';
const allowedPhone = '919092317264';
const args = new Set(process.argv.slice(2));
const requested = [...args];
if (requested.some(arg => !['--send-email', '--send-whatsapp'].includes(arg))) throw new Error('Only --send-email and --send-whatsapp are supported. Recipients cannot be changed.');
const config = require('../src/config');
const messages = require('../src/modules/notifications/associationUpdateMessage');
const delivery = require('../src/modules/notifications/associationUpdateDelivery');
const member = { fullName: 'Tharun', email: allowedEmail, phoneNumber: allowedPhone };
const update = { title: 'Association update delivery test', summary: 'Your ACTIV email and WhatsApp update delivery check.',
    body: 'This is the association update delivery test you requested.\n\nFuture updates will follow the selected membership plan, member segment and region, together with your notification preferences. You can sign in to ACTIV to read the full update and its poster or document.\n\nThank you for helping us check the ACTIV experience.' };
const outputDir = path.resolve(__dirname, '../../artifacts');
fs.mkdirSync(outputDir, { recursive: true });
const rendered = messages.render(update, member);
fs.writeFileSync(path.join(outputDir, 'association-update-test-email.html'), rendered.html);
let previous = {};
try { previous = JSON.parse(fs.readFileSync(path.join(outputDir, 'association-update-live-test.json'), 'utf8')); } catch {}
const report = { at: new Date().toISOString(), email: previous.email || { attempted: false }, whatsapp: previous.whatsapp || { attempted: false },
    note: 'Provider acceptance is not proof of inbox/handset delivery. No database or member update was written.' };
const result = outcome => ({ accepted: !!(outcome.success && !outcome.mock), providerMessageId: outcome.messageId || undefined,
    provider: outcome.provider || undefined, error: outcome.error || undefined });
(async () => {
    assert.equal(config.email.archiveCopy, '', 'test must not CC/BCC an office mailbox');
    if (args.has('--send-email')) {
        // Check the final envelope as well as the high-level recipient. This
        // catches future archive/default-recipient changes before any SMTP call.
        const email = require('../src/modules/notifications/email.service');
        const transport = email.getTransporter('membership');
        if (transport) {
            const original = transport.sendMail.bind(transport);
            transport.sendMail = options => {
                assert.equal(options.to, allowedEmail); assert(!options.cc); assert(!options.bcc); assert(!options.envelope);
                return original(options);
            };
        }
        report.email = { attempted: true, testedAt: new Date().toISOString(), ...result(await delivery.sendPrepared('email', member, update, allowedEmail)) };
    }
    if (args.has('--send-whatsapp')) {
        const whatsapp = require('../src/modules/notifications/whatsappTemplate');
        const original = whatsapp.sendTemplateMessage.bind(whatsapp);
        whatsapp.sendTemplateMessage = (phone, ...rest) => { assert.equal(phone, allowedPhone); return original(phone, ...rest); };
        report.whatsapp = { attempted: true, testedAt: new Date().toISOString(), ...result(await delivery.sendPrepared('whatsapp', member, update, allowedPhone)) };
    }
    fs.writeFileSync(path.join(outputDir, 'association-update-live-test.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
    const email = require('../src/modules/notifications/email.service');
    email.memberTransporter?.close(); email.transporter?.close();
});
