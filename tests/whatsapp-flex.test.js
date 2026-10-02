/**
 * The flexible event WhatsApp templates (src/modules/notifications/whatsappFlex.js):
 * every combination of present and missing event fields produces a correct
 * message — nothing invented, no empty variable, nothing Meta refuses — and
 * the chains only use them once their BOTBEE_TPL_*_FLEX flag is set.
 *
 * PURE UNIT, NO DB AND NO NETWORK. Nothing here sends anything.
 *
 *   node tests/whatsapp-flex.test.js
 */

const flex = require('../src/modules/notifications/whatsappFlex');
const templates = require('../src/modules/notifications/notificationTemplates');
const { sanitizeParams } = require('../src/modules/notifications/whatsappTemplate');
const config = require('../src/config');

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
    if (ok) { passed++; return true; }
    failed++; failures.push(`${label}${detail ? '  — ' + detail : ''}`);
    console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
    return false;
};
const say = (label, ok, detail) => { if (check(label, ok, detail)) console.log(`  ok    ${label}`); };
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

/* Phrases that only an invented fact could put in a message. */
const INVENTED = [
    /ACTIV Office/i, /82201\s?12188/, /enquiry@activ\.org\.in/i, /the ACTIV office/i,
    /photo\s*ID/i, /30 minutes/i, /5 minutes/i, /stable internet/i, /Rajesh/i,
    /will be added here soon/i, /reach you (soon|shortly)/i, /Not specified/i, /Not given/i, /undefined|null|NaN|\[object/
];

const VARS = (message) => (flex.BODIES[message].match(/\{\{\d+\}\}/g) || []).length;

/* ============================================================ 1. the templates */

const testDefinitions = () => {
    section('The template definitions pass Meta\'s submission rules');
    say('ten original and four readable templates', flex.TEMPLATE_DEFS.length === 14);
    for (const t of flex.TEMPLATE_DEFS) {
        const problems = flex.lintTemplate(t);
        say(`${t.name}: ${problems.length ? problems.join('; ') : 'clean'}`, problems.length === 0);
        say(`${t.name}: UTILITY, meta, footer ≤ 60`, t.category === 'Utility' && t.meta && t.footer.length <= 60);
        say(`${t.name}: no promotional wording`, !/offer|discount|buy|sale|free gift|limited time|hurry|don't miss|exclusive/i
            .test(t.bodyWithVariables));
    }
    const names = flex.TEMPLATE_DEFS.map((t) => t.name);
    say('every name unique', new Set(names).size === names.length);
    say('image variants carry an IMAGE header, plain ones none',
        flex.TEMPLATE_DEFS.every((t) => (/_plain_/.test(t.name) ? !t.header : t.header === 'IMAGE')));
    say('listed in WHATSAPP_TEMPLATES (so the script submits them)',
        names.every((n) => templates.WHATSAPP_TEMPLATES.some((t) => t.name === n && t.meta && t.flex)));
    say('lint catches a variable at the very end', flex.lintTemplate({ bodyWithVariables: 'Hi {{1}}', samples: ['x'] }).length > 0);
    say('lint catches touching variables', flex.lintTemplate({ bodyWithVariables: 'Hi {{1}}{{2}} ok', samples: ['a', 'b'] }).length > 0);
};

/* ===================================================== 2. every field combination */

const BASE = {
    bookingRef: 'ACTIVB-FLEX-0001',
    eventTitle: 'Entrepreneurs Awareness Programme',
    bookerName: 'Sampath Kumar',
    seats: 1,
    seatsLabel: '1 seat',
    viewUrl: 'https://activ.org.in/events/eap/book?ref=ACTIVB-FLEX-0001',
    eventUrl: 'https://activ.org.in/events/eap'
};

/* Optional fields, each with a distinctive value so its presence can be asserted. */
const OPTIONAL = {
    date: { dateLabel: 'Friday, 23 October 2026', timeLabel: '9:00 AM – 5:00 PM IST', startClock: '9:00 AM IST' },
    venue: { venueLabel: 'Annamalai Hall, Chidambaram' },
    map: { mapUrl: 'https://maps.app.goo.gl/zzMAP' },
    cName: { contactName: 'K. Ravi' },
    cPhone: { contactPhone: '+919840012345' },
    cEmail: { contactEmail: 'events-desk@example.org' },
    notes: { attendeeNote: 'Bring your visiting cards\nLunch is provided' },
    language: { language: 'Tamil' },
    topic: { topic: 'MSME credit schemes' },
    video: { videoUrl: 'https://youtu.be/zzVIDEO' },
    paid: { settledVia: 'online', amountLabel: 'Rs 1,500', paymentLabel: 'Paid online' },
    many: { seats: 2, seatsLabel: '2 seats', participantNames: ['Sampath Kumar', 'Priya Devi'] }
};
const KEYS = Object.keys(OPTIONAL);

/** Label that must appear exactly when the field is present (for the messages that print it). */
const MARK = {
    map: /Map: https:\/\/maps\.app\.goo\.gl\/zzMAP/,
    cName: /K\. Ravi/,
    cPhone: /\+91 98400 12345/,
    cEmail: /events-desk@example\.org/,
    notes: /Note: Bring your visiting cards; Lunch is provided/,
    language: /Language: Tamil/,
    topic: /Topic: MSME credit schemes/,
    video: /Event video: https:\/\/youtu\.be\/zzVIDEO/,
    paid: /Rs 1,500 · Paid online/,
    venue: /Annamalai Hall, Chidambaram/,
    date: /Friday, 23 October 2026 · 9:00 AM – 5:00 PM IST/
};

/* Which marks each message prints at all. */
const PRINTS = {
    confirmed: ['map', 'cName', 'cPhone', 'cEmail', 'notes', 'language', 'topic', 'video', 'paid', 'venue', 'date'],
    online: ['cName', 'cPhone', 'cEmail', 'notes', 'language', 'topic', 'video', 'paid', 'date'],
    reminder: ['map', 'cName', 'cPhone', 'cEmail', 'notes', 'language', 'topic', 'video', 'paid', 'venue', 'date'],
    cancelled: ['cName', 'cPhone', 'cEmail', 'date'],
    waitlist: ['cName', 'cPhone', 'cEmail', 'language', 'venue', 'date']
};

const ctxFor = (mask, message, extra = {}) => {
    const ctx = { ...BASE, settledVia: 'free', ...extra };
    KEYS.forEach((k, i) => { if (mask & (1 << i)) Object.assign(ctx, OPTIONAL[k]); });
    if (message === 'online') {
        Object.assign(ctx, { isOnline: true, onlinePlatform: 'Zoom' });
        delete ctx.venueLabel; delete ctx.mapUrl;
    }
    if (message === 'reminder') ctx.startsInLabel = 'tomorrow';
    if (message === 'cancelled') ctx.reason = mask & 1 ? 'Venue unavailable' : '';
    return ctx;
};

const validate = (message, ctx, label) => {
    const out = flex.flexParams(message, ctx);
    const n = VARS(message);
    let ok = true;
    const fail = (what) => { ok = false; check(`${label}: ${what}`, false, JSON.stringify(out.params)); };
    if (out.missing.length) fail(`unexpected missing ${out.missing.join(', ')}`);
    if (out.params.length !== n) fail(`${out.params.length} params for ${n} variables`);
    out.params.forEach((p, i) => {
        if (!String(p).trim()) fail(`{{${i + 1}}} empty`);
        if (/[\n\t]| {5,}/.test(p)) fail(`{{${i + 1}}} has a newline/tab/5 spaces`);
        if (p === '–' || p === '-') fail(`{{${i + 1}}} is a dash placeholder`);
    });
    if (JSON.stringify(sanitizeParams(out.params)) !== JSON.stringify(out.params)) fail('the send path would rewrite a value');
    if (out.rendered.length > flex.BODY_LIMIT) fail(`rendered ${out.rendered.length} > ${flex.BODY_LIMIT}`);
    const hits = INVENTED.filter((re) => re.test(out.rendered));
    if (hits.length) fail(`invented: ${hits.join(', ')}`);
    if (out.dropped.length) fail(`dropped ${out.dropped.join(', ')} at normal sizes`);
    // Present → printed; absent → its label is nowhere.
    for (const key of PRINTS[message]) {
        const present = Object.keys(OPTIONAL[key]).every((f) => ctx[f] !== undefined && ctx[f] !== '');
        if (key === 'paid' && ctx.settledVia !== 'online') continue;
        if (message === 'cancelled' && key === 'paid') continue;
        if (present && !MARK[key].test(out.rendered)) fail(`${key} present but not printed`);
        if (!present && MARK[key].test(out.rendered)) fail(`${key} absent but printed`);
    }
    if (!/Organiser:/.test(out.rendered) === !!(ctx.contactName || ctx.contactPhone || ctx.contactEmail)) {
        fail('"Organiser:" label does not follow the contact fields');
    }
    for (const [re, field] of [[/Language:/, 'language'], [/Topic:/, 'topic'], [/Note:/, 'attendeeNote'], [/Event video:/, 'videoUrl']]) {
        if (re.test(out.rendered) && !ctx[field]) fail(`"${re.source}" printed with no ${field}`);
    }
    if (!out.params.includes(ctx.bookingRef)) fail('booking ID not a whole parameter');
    return ok;
};

const testCombinations = () => {
    section('Every combination of present / missing fields (2^12 per message)');
    for (const message of ['confirmed', 'online', 'reminder', 'cancelled', 'waitlist']) {
        let okCount = 0;
        const total = 1 << KEYS.length;
        for (let mask = 0; mask < total; mask += 1) {
            if (validate(message, ctxFor(mask, message), `${message} mask ${mask}`)) okCount += 1;
            if (failed > 40) break;
        }
        say(`${message}: ${okCount}/${total} combinations correct`, okCount === total);
    }

    // Online link kinds, with and without a start time.
    for (const [url, re] of [
        ['', /the organiser has not published the joining link yet/],
        ['https://zoom.us/meeting/register/abc', /register at https:\/\/zoom\.us\/meeting\/register\/abc and your personal joining link appears/],
        ['https://zoom.us/j/123', /join at https:\/\/zoom\.us\/j\/123/]
    ]) {
        for (const startClock of ['', '3:00 PM IST']) {
            const ctx = { ...BASE, settledVia: 'free', isOnline: true, onlinePlatform: 'Zoom', registerUrl: url, startClock };
            const out = flex.flexParams('online', ctx);
            say(`online, link "${url || 'none'}", start ${startClock || 'unknown'}: right instruction`, re.test(out.params[3]), out.params[3]);
            say('  …start time only when the event has one', /3:00 PM IST/.test(out.params[3]) === !!(startClock && url), out.params[3]);
        }
    }
    const noPlatform = flex.flexParams('online', { ...BASE, isOnline: true, registerUrl: 'https://zoom.us/j/1' });
    say('online with no platform: "Online", no platform invented', /^Online — join at/.test(noPlatform.params[3]), noPlatform.params[3]);

    // Money is what it is.
    const offline = flex.flexParams('confirmed', { ...BASE, settledVia: 'offline', amountLabel: 'Rs 800', paymentLabel: 'Paid to the organiser (UPI)' });
    say('paid to the organiser: amount + how', /Rs 800 · Paid to the organiser \(UPI\)/.test(offline.params[4]), offline.params[4]);
    const free = flex.flexParams('confirmed', { ...BASE, settledVia: 'free' });
    say('free: "Free entry", no amount', /Free entry/.test(free.params[4]) && !/Rs/.test(free.params[4]), free.params[4]);
    const part = flex.flexParams('confirmed', { ...BASE, forParticipant: true, bookerName: 'Tharun', participantName: 'Priya',
        settledVia: 'online', amountLabel: 'Rs 1,500', paymentLabel: 'Paid online' });
    say('participant: who booked it, never the booker\'s payment', /Booked for you by Tharun/.test(part.params[4])
        && !/Rs 1,500/.test(part.rendered) && part.params[0] === 'Priya', JSON.stringify(part.params));

    // The bare minimum an event can have: a title. Still a complete message.
    const bare = flex.flexParams('confirmed', { ...BASE, settledVia: 'free' });
    say('title only: When says the date is not set yet', bare.params[2] === 'Date to be confirmed', bare.params[2]);
    say('title only: Where says the venue is not announced', bare.params[3] === 'To be announced by the organiser', bare.params[3]);
    say('title only: details are just the seat and the fee', bare.params[4] === '1 seat · Free entry', bare.params[4]);
    say('reminder leads with how soon', /^Starts tomorrow · Friday/.test(
        flex.flexParams('reminder', { ...BASE, ...OPTIONAL.date, startsInLabel: 'tomorrow' }).params[2]));
    const noName = flex.flexParams('confirmed', { ...BASE, bookerName: '' });
    say('no name on the booking: "Member"', noName.params[0] === 'Member');
};

/* ============================================================ 3. length budget */

const testBudget = () => {
    section('Over-long events stay under Meta\'s 1024 characters (#132005)');
    const huge = {
        ...BASE, ...OPTIONAL.date, ...OPTIONAL.cName, ...OPTIONAL.cPhone, ...OPTIONAL.cEmail, ...OPTIONAL.language,
        ...OPTIONAL.video, ...OPTIONAL.paid, ...OPTIONAL.many,
        eventTitle: 'A '.repeat(200),
        venueLabel: 'Very long venue name and address line '.repeat(8),
        mapUrl: `https://maps.example.com/${'x'.repeat(250)}`,
        topic: 'Topic words '.repeat(30),
        attendeeNote: Array.from({ length: 6 }, (_, i) => `Note number ${i} with quite a lot of words in it to fill the space up`).join('\n'),
        participantNames: Array.from({ length: 12 }, (_, i) => `Participant Name ${i}`),
        seats: 12, seatsLabel: '12 seats'
    };
    for (const message of ['confirmed', 'reminder', 'waitlist', 'cancelled']) {
        const out = flex.flexParams(message, { ...huge, reason: 'A long reason '.repeat(40) });
        say(`${message}: rendered ${out.rendered.length} ≤ ${flex.BODY_LIMIT}`, out.rendered.length <= flex.BODY_LIMIT);
        say(`${message}: booking ID and link intact`, out.params.includes(BASE.bookingRef)
            && out.params.some((p) => p === BASE.viewUrl || p === BASE.eventUrl), JSON.stringify(out.params));
        say(`${message}: seats kept`, /12 seats/.test(out.rendered));
        say(`${message}: no empty value`, out.params.every((p) => String(p).trim()));
    }
    const out = flex.flexParams('confirmed', huge);
    say('the least important items go first (video, topic, attendees)', ['video', 'topic', 'attendees']
        .every((k) => out.dropped.includes(k)), out.dropped.join(', '));
    say('the fee is never dropped', /Rs 1,500/.test(out.rendered));
    const steps = flex.flexSteps('confirmed', huge, { image: 'activ_evt_confirmed_v3' }, []);
    const skipped = [];
    flex.flexSteps('confirmed', huge, { image: 'activ_evt_confirmed_v3' }, skipped);
    say('what was left out is recorded for the delivery log', steps.length === 1 && skipped.some((s) => /left out/.test(s)), skipped.join(' | '));

    const online = flex.flexParams('online', { ...huge, isOnline: true, onlinePlatform: 'Zoom',
        registerUrl: `https://zoom.us/meeting/register/${'y'.repeat(300)}` });
    say(`online, long everything: rendered ${online.rendered.length} ≤ ${flex.BODY_LIMIT}`, online.rendered.length <= flex.BODY_LIMIT);
};

/* ================================================== 4. missing essentials */

const testMissing = () => {
    section('A booking without its ID or a link skips the template (never padded)');
    const skipped = [];
    const steps = flex.flexSteps('confirmed', { ...BASE, bookingRef: '' }, { image: 'a_v1', plain: 'a_plain_v1' }, skipped);
    say('no booking ID → no step', steps.length === 0);
    say('…and both skips are recorded', skipped.length === 2 && skipped.every((s) => /booking ID/.test(s)), skipped.join(' | '));
    const noLink = flex.flexSteps('confirmed', { ...BASE, viewUrl: '', eventUrl: '' }, { image: 'a_v1' }, []);
    say('no link at all → no step', noLink.length === 0);
    const off = [];
    say('nothing switched on → no step and nothing logged', flex.flexSteps('confirmed', BASE, {}, off).length === 0 && off.length === 0);
    const plain = flex.flexSteps('reminder', BASE, { image: 'r_v1', plain: 'r_plain_v1' }, []);
    say('image variant first, then the no-header one', plain.length === 2 && plain[0].template === 'r_v1'
        && !plain[0].noHeader && plain[1].noHeader === true);
};

/* ================================================ 5. wiring into the chains */

const chainOf = (wa) => { const out = []; for (let s = wa; s; s = s.fallback) out.push(s); return out; };
const FLAGS = ['bookingFlex', 'bookingFlexPlain', 'webinarFlex', 'webinarFlexPlain', 'reminderFlex', 'reminderFlexPlain',
    'cancelFlex', 'cancelFlexPlain', 'waitlistFlex', 'waitlistFlexPlain'];

const renderCtx = (over = {}) => ({
    kind: 'confirmed', ...BASE, name: 'Sampath Kumar', firstName: 'Sampath', bookerEmail: 'b@example.com',
    ...OPTIONAL.date, whenLabel: 'Friday, 23 October 2026, 9:00 AM IST', venueLabel: 'Annamalai Hall, Chidambaram',
    formatLabel: 'In-person event', participantNames: ['Sampath Kumar'], settledVia: 'free', paymentLabel: 'Not required',
    contactName: '', contactPhone: '', contactEmail: '', contactLine: '', attendeeNote: '',
    posterUrl: 'https://activ.org.in/uploads/poster.jpg', data: { bookingRef: BASE.bookingRef, eventId: 'e1' },
    ...over
});

const testWiring = () => {
    section('Chains: flexible templates only once their flag is set');
    const TPL = config.botbee.templates;
    const saved = Object.fromEntries(FLAGS.map((k) => [k, TPL[k]]));
    const cases = [
        ['EVENT_BOOKING_CONFIRMED', renderCtx(), 'activ_evt_confirmed'],
        ['EVENT_BOOKING_CONFIRMED', renderCtx({ isOnline: true, onlinePlatform: 'Zoom', registerUrl: 'https://zoom.us/j/1',
            venueLabel: 'Online (Zoom)', formatLabel: 'Online webinar on Zoom' }), 'activ_evt_online'],
        ['EVENT_BOOKING_REMINDER', renderCtx({ kind: 'reminder', startsInLabel: 'tomorrow' }), 'activ_evt_reminder'],
        ['EVENT_BOOKING_CANCELLED', renderCtx({ kind: 'cancelled', reason: 'Duplicate' }), 'activ_evt_cancelled'],
        ['EVENT_BOOKING_WAITLISTED', renderCtx({ kind: 'waitlist' }), 'activ_evt_waitlist'],
        ['EVENT_PARTICIPANT_CONFIRMED', renderCtx({ participantName: 'Priya', participantEmail: 'p@example.com' }), 'activ_evt_confirmed'],
        ['EVENT_PARTICIPANT_REMINDER', renderCtx({ kind: 'reminder', participantName: 'Priya', startsInLabel: 'tomorrow' }), 'activ_evt_reminder'],
        ['EVENT_PARTICIPANT_CANCELLED', renderCtx({ kind: 'cancelled', participantName: 'Priya' }), 'activ_evt_cancelled']
    ];
    try {
        FLAGS.forEach((k) => { TPL[k] = ''; });
        for (const [eventName, ctx] of cases) {
            const chain = chainOf(templates.render(eventName, ctx).whatsapp);
            say(`flags unset: ${eventName}${ctx.isOnline ? ' (online)' : ''} never uses a flexible template`,
                !chain.some((s) => /^activ_evt_/.test(s.template)), chain.map((s) => s.template).join(' > '));
        }

        FLAGS.forEach((k) => { TPL[k] = 'true'; });
        for (const [eventName, ctx, prefix] of cases) {
            const rendered = templates.render(eventName, ctx);
            const chain = chainOf(rendered.whatsapp);
            const [first, second, third] = chain;
            const label = `${eventName}${ctx.isOnline ? ' (online)' : ''}`;
            say(`flags on: ${label} → ${prefix} (image) first, even with no organiser contact or notes`,
                first.template === (Object.values(flex.NAMES).find((n) => n.image.startsWith(prefix)) || {}).image, chain.map((s) => s.template).join(' > '));
            say(`  …with the poster header`, first.headerImage === ctx.posterUrl);
            say(`  …then ${prefix} (no header)`, second.template === (Object.values(flex.NAMES).find((n) => n.image.startsWith(prefix)) || {}).plain && !second.headerImage);
            say('  …then the existing chain as the fallback', !!third && !/^activ_evt_/.test(third.template), third && third.template);
            say('  …every parameter filled', chain.every((s) => (s.params || []).every((p) => String(p).trim())));
            const hits = INVENTED.filter((re) => re.test(first.params.join('\n')));
            say('  …nothing invented', hits.length === 0, hits.join(', '));
        }

        // A deployment that names its own approved template.
        TPL.bookingFlex = 'activ_evt_confirmed_v3';
        TPL.bookingFlexPlain = 'none';
        const named = chainOf(templates.render('EVENT_BOOKING_CONFIRMED', renderCtx()).whatsapp);
        say('an explicit name is used as given; `none` switches a variant off',
            named[0].template === 'activ_evt_confirmed_v3' && !named.some((s) => s.template === 'activ_evt_confirmed_plain_v3'),
            named.map((s) => s.template).join(' > '));

        // Participant: their name, the booker named, no payment.
        TPL.bookingFlex = 'true';
        const p = chainOf(templates.render('EVENT_PARTICIPANT_CONFIRMED', renderCtx({ participantName: 'Priya',
            settledVia: 'online', amountLabel: 'Rs 1,500', paymentLabel: 'Paid online' })).whatsapp)[0];
        say('participant message greets the participant and names the booker, no amount',
            p.params[0] === 'Priya' && /Booked for you by Sampath Kumar/.test(p.params[4]) && !/1,500/.test(p.params.join(' ')),
            JSON.stringify(p.params));
    } finally {
        FLAGS.forEach((k) => { TPL[k] = saved[k]; });
    }
};

(async() => {
    try {
        testDefinitions();
        for (const isOnline of [false, true]) {
            const message = isOnline ? 'online' : 'confirmed';
            for (const settledVia of ['free', 'online', 'offline']) {
                const ctx = { ...BASE, isOnline, settledVia, onlinePlatform: 'Zoom',
                    ...OPTIONAL.date, ...OPTIONAL.venue, registrationNo: `${BASE.bookingRef}-P1`,
                    amountLabel: settledVia === 'free' ? '' : 'Rs 1,500',
                    paymentLabel: settledVia === 'online' ? 'Paid online' : 'Paid to the organiser' };
                const readable = flex.readableParams(message, ctx);
                say(`${message}/${settledVia}: ten one-line parameters`, readable.params.length === 10
                    && readable.params.every((v) => v && !/[\n\t]/.test(v)));
                say(`${message}/${settledVia}: date, time, seats, payment and references on separate lines`,
                    readable.rendered.includes('*Date:* Friday, 23 October 2026\n')
                    && readable.rendered.includes('*Time:* ')
                    && readable.rendered.includes('*Seats:* 1 seat\n')
                    && readable.rendered.includes('*Payment:* ')
                    && readable.rendered.includes(`*Booking ID:* ${BASE.bookingRef}\n`)
                    && readable.rendered.includes(`*Entry reference:* ${BASE.bookingRef}-P1\n`));
                say(`${message}/${settledVia}: payment is truthful`, settledVia === 'free'
                    ? readable.params[6] === 'Free entry' : readable.params[6].includes('Rs 1,500') && !readable.params[6].includes('Free entry'));
                say(`${message}/${settledVia}: approved-name switch uses the right slot contract`,
                    flex.flexSteps('confirmed', ctx, flex.READABLE_NAMES[message], []).every((step) => step.params.length === 10));
                const mixed = flex.flexSteps('confirmed', ctx, { image: flex.NAMES[message].image, plain: flex.READABLE_NAMES[message].plain }, []);
                say(`${message}/${settledVia}: old and new contracts can coexist`, mixed[0].params.length === 7 && mixed[1].params.length === 10);
            }
        }
        testCombinations();
        testBudget();
        testMissing();
        testWiring();
    } catch (error) {
        failed++;
        failures.push(`crashed: ${error && error.stack}`);
        console.log(error);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) { console.log(failures.slice(0, 60).map((f) => `  - ${f}`).join('\n')); process.exit(1); }
    process.exit(0);
})();
