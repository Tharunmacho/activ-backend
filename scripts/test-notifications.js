#!/usr/bin/env node
/**
 * Prove the notification system before a member is ever messaged.
 *
 *   node scripts/test-notifications.js               everything below
 *   node scripts/test-notifications.js --env         what is / is not configured
 *   node scripts/test-notifications.js --email       real SMTP handshake + auth
 *   node scripts/test-notifications.js --whatsapp    the exact BotBee request
 *   node scripts/test-notifications.js --routing     regional Reply-To resolution
 *   node scripts/test-notifications.js --templates   the BotBee dashboard checklist
 *   node scripts/test-notifications.js --bot         the inbound keyword router
 *   node scripts/test-notifications.js --render      one rendered email, to a file
 *
 *   --send-email you@example.com     actually send one test email
 *   --send-whatsapp 9876543210       actually send one test WhatsApp message
 *
 * WHY THIS EXISTS. Every send in this system is designed to be non-blocking:
 * with no credentials it logs what it would have done and reports success, so
 * that a registration never fails because a mail host is down. That is the right
 * behaviour in production and it is exactly what makes a misconfiguration
 * invisible — nothing on any screen distinguishes "delivered" from "there is no
 * mail server". This script is the thing that tells them apart, on demand,
 * without messaging anybody.
 *
 * Exits non-zero when a check that was asked for genuinely fails, so it can be
 * used as a smoke test in a deploy pipeline.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');

const config = require('../src/config');
const emailService = require('../src/modules/notifications/email.service');
const botbeeService = require('../src/modules/notifications/botbee.service');
const templates = require('../src/modules/notifications/notificationTemplates');
const webhookService = require('../src/modules/notifications/botbeeWebhook.service');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : '';
};

// No flags at all means run every read-only check. The two `--send-*` flags are
// never implied: this script must be safe to run on production by default.
const ALL = !args.some((a) => a.startsWith('--') && a !== '--verbose');

const C = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[36m'
};
const ok = (m) => console.log(`  ${C.green}PASS${C.reset}  ${m}`);
const bad = (m) => console.log(`  ${C.red}FAIL${C.reset}  ${m}`);
const warn = (m) => console.log(`  ${C.yellow}WARN${C.reset}  ${m}`);
const info = (m) => console.log(`  ${C.dim}      ${m}${C.reset}`);
const head = (m) => console.log(`\n${C.bold}${C.blue}${m}${C.reset}\n${'─'.repeat(Math.min(m.length, 70))}`);

let failures = 0;
const fail = (m) => { failures += 1; bad(m); };

/* ══════════════════════════════════════════════════════ 1. configuration ═══ */

function checkEnv() {
    head('1. Credentials');

    const e = config.email;
    if (e.isConfigured) {
        ok(`Email configured — ${e.user} via ${e.host}:${e.port} (${e.secure ? 'TLS' : 'STARTTLS'})`);
    } else {
        warn('Email NOT configured — every email will be logged and skipped');
        info(`EMAIL_HOST ${e.host ? 'set' : 'MISSING'} · EMAIL_USER ${e.user ? 'set' : 'MISSING'} `
            + `· EMAIL_PASS ${e.password ? 'set' : 'MISSING'}`);
        info('A value still reading "your_..._here" counts as missing, by design.');
    }

    info(`From address      : ${e.defaultFrom}`);
    info(`From display name : ${e.fromName} (replaced per-region on application mail)`);
    info(`Regional From     : ${e.useRegionalFrom ? 'ON' : 'off — region goes in the display name'}`);
    info(`Fallback Reply-To : ${e.supportAddress}`);

    const b = config.botbee;
    console.log('');
    if (b.isConfigured) {
        ok(`BotBee configured — phone_number_id ${b.phoneNumberId}`);
    } else {
        warn('BotBee NOT configured — every WhatsApp message will be logged and skipped');
        info(`BOTBEE_API_TOKEN ${b.apiToken ? 'set' : 'MISSING'} `
            + `· BOTBEE_PHONE_NUMBER_ID ${b.phoneNumberId ? 'set' : 'MISSING'}`);
    }

    info(`Template endpoint : ${b.baseUrl}${b.sendTemplatePath}`);
    info(`Text endpoint     : ${b.baseUrl}${b.sendTextPath}`);
    info(`Auth style        : ${b.authStyle}`);

    console.log('');
    if (b.webhookVerifyToken) {
        ok('Webhook verify token set');
        info(`Register this URL on BotBee:`);
        info(`  ${config.backendUrl}/api/${config.apiVersion}/notifications/botbee/webhook`);
    } else {
        warn('BOTBEE_WEBHOOK_VERIFY_TOKEN is not set — the webhook handshake will be REFUSED');
        info('That is deliberate: an unauthenticated open webhook is not a safe default.');
    }

    /*
     * The trap that used to be here, checked explicitly. Two senders read two
     * different variable names for the same password; a `.env` carrying only the
     * old one left half the mail live and half silently mocking.
     */
    console.log('');
    if (process.env.EMAIL_PASSWORD && !process.env.EMAIL_PASS) {
        warn('Only EMAIL_PASSWORD is set. It is accepted, but EMAIL_PASS is the documented name.');
    }
}

/* ═════════════════════════════════════════════════ 2. SMTP handshake ═══ */

async function checkEmail() {
    head('2. SMTP connection');

    if (!emailService.isConfigured()) {
        warn('Skipped — no credentials. Mock mode verified instead:');
        const result = await emailService.sendEmail({
            to: 'nobody@example.com', subject: 'ACTIV mock check', html: '<p>x</p>'
        });
        if (result.success && result.mock) {
            ok('Unconfigured email resolves { success: true, mock: true } and does not throw');
            info('This is what keeps a registration from failing when mail is down.');
        } else {
            fail(`Mock mode misbehaved: ${JSON.stringify(result)}`);
        }
        return;
    }

    const verified = await emailService.verifyConnection();
    if (verified.ok) {
        ok('SMTP host reachable and credentials accepted');
    } else {
        fail(`SMTP verification failed: ${verified.error}`);
        if (/invalid login|username and password|535/i.test(verified.error || '')) {
            info('Gmail needs a 16-character App Password, not the account password:');
            info('  https://myaccount.google.com/apppasswords');
        }
    }
}

/* ═══════════════════════════════════════════ 3. the exact BotBee request ═══ */

function checkWhatsApp() {
    head('3. BotBee request shape');

    const request = botbeeService.buildRequest('template', {
        phone_number: '919876543210',
        template_name: 'activ_registration_welcome',
        template_data: ['Rajeshwari'],
        language: 'en'
    });

    console.log(`  POST ${request.url}`);
    console.log(`  ${C.dim}headers${C.reset} ${JSON.stringify(botbeeService.redactHeaders(request.headers), null, 2)
        .split('\n').join('\n  ')}`);
    console.log(`  ${C.dim}body${C.reset}    ${JSON.stringify(
        { ...request.body, apiToken: request.body.apiToken ? '***' : undefined }, null, 2
    ).split('\n').join('\n  ')}`);

    console.log('');
    info('If BotBee documents a different path or auth style, change it in .env:');
    info('  BOTBEE_TEMPLATE_ENDPOINT / BOTBEE_TEXT_ENDPOINT / BOTBEE_AUTH_STYLE');

    console.log('');
    const numbers = [
        ['9876543210', '919876543210', 'bare 10-digit'],
        ['+91 98765 43210', '919876543210', 'spaced with +91'],
        ['09876543210', '919876543210', 'domestic trunk zero'],
        ['00919876543210', '919876543210', 'international 00 prefix'],
        ['91-98765-43210', '919876543210', 'hyphenated'],
        ['12345', '', 'too short — rejected'],
        ['not a number', '', 'junk — rejected']
    ];

    for (const [input, expected, label] of numbers) {
        const got = botbeeService.normalizePhoneNumber(input);
        if (got === expected) ok(`${label.padEnd(24)} ${JSON.stringify(input)} → ${JSON.stringify(got)}`);
        else fail(`${label}: ${JSON.stringify(input)} → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
}

/* ══════════════════════════════════════════ 4. regional Reply-To routing ═══ */

async function checkRouting() {
    head('4. Regional Reply-To routing');

    const mongoose = require('mongoose');
    const regionalContacts = require('../src/modules/notifications/regionalContacts.service');

    // The pure part first — no database needed, so this check is meaningful
    // even on a machine that cannot reach the cluster.
    const derived = regionalContacts.derivedAddress('block', 'Ambattur');
    if (derived === `block.ambattur@${config.email.regionDomain}`) {
        ok(`Derived fallback address: "Ambattur" → ${derived}`);
    } else {
        fail(`Derived address wrong: ${derived}`);
    }

    if (regionalContacts.derivedAddress('district', '—') === '') {
        ok('A region name with no letters produces no address (rather than "district.@...")');
    } else {
        fail('An unusable region name produced an address');
    }

    const governs = regionalContacts.governs;
    const cases = [
        [{ state: 'Tamil Nadu' }, { state: 'tamil  nadu', district: 'Chennai' }, true, 'state admin covers any district in it'],
        [{ state: 'Tamil Nadu', district: 'Chennai' }, { state: 'Tamil Nadu', district: 'Coimbatore' }, false, 'district admin does not cover another district'],
        [{ state: 'Tamil Nadu', district: 'Chennai', block: 'Ambattur' }, { state: 'Tamil Nadu', district: 'Chennai', block: 'Ambattur' }, true, 'block admin covers their own block'],
        [{ state: 'Tamil Nadu', district: 'Chennai' }, { state: 'Tamil Nadu' }, false, 'district admin does not cover an applicant with no district']
    ];
    for (const [admin, region, expected, label] of cases) {
        const got = governs(admin, region);
        if (got === expected) ok(label);
        else fail(`${label} — got ${got}, expected ${expected}`);
    }

    // The live part. Skipped rather than failed when the cluster is unreachable:
    // an offline laptop is not a broken integration.
    console.log('');
    let connected = false;
    try {
        await mongoose.connect(config.db.uri, { serverSelectionTimeoutMS: 5000 });
        connected = true;
    } catch (error) {
        warn(`Database unreachable — live routing check skipped (${error.message})`);
        return;
    }

    try {
        const Application = require('../src/modules/applications/application.model');
        const sample = await Application.findOne().sort({ createdAt: -1 }).lean();

        if (!sample) {
            warn('No applications in the database — nothing to resolve against');
        } else {
            const contact = await regionalContacts.resolveForApplication(sample);
            const region = [sample.block, sample.district, sample.state].filter(Boolean).join(', ') || '(none)';

            ok(`Resolved a real application in ${region}`);
            info(`From display name : ${contact.fromName}`);
            info(`Reply-To          : ${contact.replyTo}`);

            for (const tier of regionalContacts.TIER_ORDER) {
                const entry = contact.contacts[tier];
                if (!entry) continue;
                info(`  ${entry.tierLabel.padEnd(9)} ${entry.regionName || '(unnamed)'} → ${entry.email} `
                    + `${entry.staffed ? `[${entry.name || 'staffed'}]` : '[NOT STAFFED — derived address]'}`);
            }

            if (!contact.nearest || !contact.nearest.staffed) {
                warn('No staffed admin governs this region. Replies go to a derived address '
                    + 'which must exist as a real mailbox, or they bounce.');
            }
        }
    } finally {
        if (connected) await mongoose.disconnect().catch(() => null);
    }
}

/* ═════════════════════════════════════════ 5. BotBee dashboard checklist ═══ */

function checkTemplates() {
    head('5. WhatsApp templates to create on BotBee');

    info('Create each body EXACTLY as printed under "Body". Do NOT insert any');
    info('variable -- nothing from the Custom Fields or Variables dropdowns.');
    info('');
    info('The BotBee send API discards variable values and delivers a literal');
    info('dash in every slot (see notificationTemplates.js for what was tested).');
    info('Members get their real name and details from the free-text message');
    info('this codebase composes, and from the bot reply when they answer.');
    console.log('');

    for (const t of templates.WHATSAPP_TEMPLATES) {
        console.log(`  ${C.bold}${t.name}${C.reset}`);
        console.log(`    ${C.dim}Category${C.reset}  ${t.category || 'Utility'}`);
        console.log(`    ${C.dim}Language${C.reset}  English (US)   ${C.dim}Header${C.reset} none   ${C.dim}Footer${C.reset} ACTIV Platform`);
        console.log(`    ${C.dim}Body${C.reset}      ${t.body}`);
        if (t.bodyWithVariables) {
            console.log(`    ${C.dim}--- once META_ACCESS_TOKEN is set, change the body to: ---${C.reset}`);
            console.log(`    ${C.dim}Body${C.reset}      ${t.bodyWithVariables}`);
            (t.params || []).forEach((p, i) => console.log(
                `    ${C.dim}Sample${C.reset}    ${i + 1} = ${(t.samples || [])[i] || '(fill one in)'}   ${C.dim}${p}${C.reset}`
            ));
        }
        console.log('');
    }
    info('ASCII only in the body — an em dash or a Rs symbol can fail review.');
    info('Switching back needs no code change: the service reads each template');
    info('variable_map at send time and sends exactly what that template declares.');
    info('Category Utility, not Marketing: these are transactional, and Utility is');
    info('cheaper and is not suppressed by marketing preferences on the handset.');

    // Every template a lifecycle event actually asks for must be on that list,
    // or the send is rejected by the provider at runtime with nothing here to
    // have warned about it.
    const declared = new Set(templates.WHATSAPP_TEMPLATES.map((t) => t.name));
    const used = new Set();
    for (const name of Object.keys(templates.TEMPLATES)) {
        const rendered = templates.render(name, { firstName: 'Test', name: 'Test Member' });
        if (rendered && rendered.whatsapp) used.add(rendered.whatsapp.template);
    }

    const missing = [...used].filter((n) => !declared.has(n));
    if (missing.length) fail(`Events reference templates that are not on the checklist: ${missing.join(', ')}`);
    else ok(`All ${used.size} templates used by lifecycle events are on the checklist`);
}

/* ══════════════════════════════════════════════ 6. the inbound bot router ═══ */

function checkBot() {
    head('6. Inbound WhatsApp bot');

    const cases = [
        ['STATUS', 'STATUS'], ['status', 'STATUS'], ['what is my application status', 'STATUS'],
        ['my membership status', 'STATUS'], ['membership status', 'STATUS'],
        ['HELP', 'HELP'], ['contact', 'HELP'], ['hi', 'HELP'],
        ['become member', 'HELP'], ['help & support', 'HELP'],
        ['I need help with the event', 'HELP'],
        ['EVENTS', 'EVENTS'], ['upcoming events', 'EVENTS'],
        ['asdkjhasd', null]
    ];
    for (const [input, expected] of cases) {
        const got = webhookService.parseCommand(input);
        if (got === expected) ok(`${JSON.stringify(input).padEnd(34)} → ${got || '(menu)'}`);
        else fail(`${JSON.stringify(input)} → ${got}, expected ${expected}`);
    }

    console.log('');
    const meta = webhookService.extractMessage({
        entry: [{ changes: [{ value: { messages: [{ from: '919876543210', text: { body: 'STATUS' }, id: 'wamid.X' }] } }] }]
    });
    if (meta && meta.from === '919876543210' && meta.text === 'STATUS') ok('Meta Cloud API webhook shape parsed');
    else fail(`Meta shape not parsed: ${JSON.stringify(meta)}`);

    const flat = webhookService.extractMessage({ phone: '9876543210', message: 'HELP' });
    if (flat && flat.text === 'HELP') ok('Flat webhook shape parsed');
    else fail(`Flat shape not parsed: ${JSON.stringify(flat)}`);

    const statusCallback = webhookService.extractMessage({
        entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }]
    });
    if (!statusCallback) ok('Delivery-status callback ignored (not answered as a message)');
    else fail('A delivery-status callback was treated as an inbound message');

    console.log('');
    const noToken = webhookService.verifyChallenge({ 'hub.verify_token': 'wrong', 'hub.challenge': '123' });
    if (!noToken.ok && noToken.status === 403) ok('Webhook handshake refuses a wrong verify token (403)');
    else fail(`Wrong token was not refused: ${JSON.stringify(noToken)}`);

    if (config.botbee.webhookVerifyToken) {
        const good = webhookService.verifyChallenge({
            'hub.mode': 'subscribe',
            'hub.verify_token': config.botbee.webhookVerifyToken,
            'hub.challenge': 'CHALLENGE123'
        });
        if (good.ok && good.body === 'CHALLENGE123') ok('Webhook handshake echoes the challenge for the right token');
        else fail(`Correct token was not accepted: ${JSON.stringify(good)}`);
    }
}

/* ═══════════════════════════════════════════════ 7. render a real email ═══ */

function checkRender() {
    head('7. Rendered email');

    const contact = {
        region: { state: 'Tamil Nadu', district: 'Coimbatore', block: 'Sulur' },
        nearest: {
            tier: 'block', tierLabel: 'Block', regionName: 'Sulur',
            email: 'r.kumar@activ.org.in', staffed: true, name: 'R. Kumar', phone: '+91 98765 43210'
        },
        contacts: {},
        replyTo: 'r.kumar@activ.org.in',
        fromName: 'ACTIV Sulur Block Office'
    };

    const rendered = templates.render('APPLICATION_APPROVED', {
        firstName: 'Rajeshwari', name: 'Rajeshwari Muthukrishnan', reference: 'A4F2C1'
    });

    const html = emailService.buildHtmlTemplate({
        title: rendered.email.title,
        recipientName: 'Rajeshwari Muthukrishnan',
        preheader: rendered.email.preheader,
        bodyHtml: rendered.email.bodyHtml,
        actionButton: rendered.email.actionButton,
        facts: rendered.email.facts,
        contact
    });

    const sender = emailService.resolveSender(contact);
    console.log(`  From     : ${sender.fromHeader}`);
    console.log(`  Reply-To : ${sender.replyTo}`);
    console.log(`  Subject  : ${rendered.email.subject}`);

    const out = path.join(__dirname, '..', 'logs', 'sample-notification-email.html');
    try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, html, 'utf8');
        ok(`Rendered HTML written to ${out}`);
        info('Open it in a browser to check the layout before anything is sent.');
    } catch (error) {
        warn(`Could not write the sample file: ${error.message}`);
    }

    // Escaping is not cosmetic here: a rejection reason is free text an admin
    // typed, and it goes straight into markup.
    const injected = emailService.escape('<script>alert(1)</script> & "quoted"');
    if (!injected.includes('<script>') && injected.includes('&lt;script&gt;')) {
        ok('Free text is HTML-escaped before it reaches an inbox');
    } else {
        fail(`Escaping failed: ${injected}`);
    }

    const text = emailService.htmlToText('<p>First</p><p>Second</p><li>Item</li>');
    if (text.includes('First') && text.includes('Second') && !text.includes('FirstSecond')) {
        ok('Plain-text alternative preserves block boundaries');
    } else {
        fail(`Text alternative is wrong: ${JSON.stringify(text)}`);
    }
}

/* ═══════════════════════════════════════════════════════ live sends ═══ */

async function liveSends() {
    const emailTo = valueOf('--send-email');
    const waTo = valueOf('--send-whatsapp');

    if (emailTo) {
        head(`Sending a real email to ${emailTo}`);
        const html = emailService.buildHtmlTemplate({
            title: 'ACTIV test message',
            recipientName: 'Tester',
            preheader: 'Delivery test from the ACTIV platform.',
            bodyHtml: '<p style="margin:0 0 12px 0;">If you are reading this, outbound email works.</p>',
            facts: [{ label: 'Sent at', value: new Date().toLocaleString('en-IN') }]
        });
        const result = await emailService.sendEmail({ to: emailTo, subject: 'ACTIV test message', html });
        if (result.mock) warn('Not sent — email is not configured');
        else if (result.success) ok(`Sent. Message id ${result.messageId}`);
        else fail(`Send failed: ${result.error}`);
    }

    if (waTo) {
        head(`Sending a real WhatsApp message to ${waTo}`);
        const result = await botbeeService.sendTextMessage(
            waTo, 'ACTIV test message. If you are reading this, outbound WhatsApp works.'
        );
        if (result.mock) warn('Not sent — BotBee is not configured');
        else if (result.success) ok(`Sent. Message id ${result.messageId}`);
        else fail(`Send failed: ${result.error}`);
    }
}

/* ═══════════════════════════════════════════════════════════ main ═══ */

(async() => {
    console.log(`\n${C.bold}ACTIV notification diagnostics${C.reset}`);

    if (ALL || has('--env')) checkEnv();
    if (ALL || has('--email')) await checkEmail();
    if (ALL || has('--whatsapp')) checkWhatsApp();
    if (ALL || has('--routing')) await checkRouting();
    if (ALL || has('--templates')) checkTemplates();
    if (ALL || has('--bot')) checkBot();
    if (ALL || has('--render')) checkRender();

    await liveSends();

    console.log('');
    if (failures) {
        console.log(`${C.red}${C.bold}${failures} check(s) failed.${C.reset}\n`);
        process.exit(1);
    }
    console.log(`${C.green}${C.bold}All checks passed.${C.reset}`);
    if (!config.email.isConfigured || !config.botbee.isConfigured) {
        console.log(`${C.yellow}Some credentials are still placeholders — see section 1 above.${C.reset}`);
    }
    console.log('');
    process.exit(0);
})().catch((error) => {
    console.error(`\n${C.red}Diagnostics crashed:${C.reset}`, error);
    process.exit(1);
});
