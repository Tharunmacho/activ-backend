/**
 * The membership journey's messages — what each renders to, and which one each
 * review decision sends.
 *
 * PURE UNIT, NO DB AND NO NETWORK. The dispatcher and the two record lookups are
 * replaced with recorders, so the assertions are about the words and the
 * decisions this code makes.
 *
 *   node tests/membership-messages.test.js
 */

const fs = require('fs');
const path = require('path');
const templates = require('../src/modules/notifications/notificationTemplates');
const config = require('../src/config');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

const MEMBERSHIP_EVENTS = [
    'ACCOUNT_REGISTERED', 'APPLICATION_SUBMITTED', 'APPLICATION_ENDORSED', 'CORRECTION_REQUESTED',
    'APPLICATION_APPROVED', 'PAYMENT_REQUIRED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_RENEWAL_DUE',
    'ADMIN_NEW_APPLICATION'
];

/** A full context, as the call sites build it, with the office the dispatcher adds. */
const full = {
    name: 'Tharun Kumar', firstName: 'Tharun', email: 'tharun@example.com', phone: '+919876543210',
    state: 'Tamil Nadu', district: 'Chennai', block: 'Guindy',
    officeName: 'Guindy Block Admin', officePhone: '+91 90000 00000', officeEmail: 'block.guindy@activ.org.in',
    reference: 'A1B2C3', applicantName: 'Tharun Kumar', businessName: 'Sri Lakshmi Enterprises',
    memberTypeLabel: 'Business membership', regionLabel: 'Guindy, Chennai, Tamil Nadu', submittedLabel: '27 September 2026',
    reviews: { block: { state: 'approved', byLine: 'Approved · 28 September 2026' }, district: { state: 'pending' }, state: { state: 'pending' } },
    blockOffice: 'Guindy Block Admin', districtOffice: 'Chennai District Admin', stateOffice: 'Tamil Nadu State Admin',
    endorsedBy: 'Guindy Block Admin', endorsedTierLabel: 'Block', decidedBy: 'Tamil Nadu State Admin',
    decidedLabel: '29 September 2026', reason: 'The GST certificate could not be read.', reasonHtml: 'The GST certificate could not be read.',
    planName: 'Growth Member', feeLabel: '₹5,000', planBand: '5 – 10 years', planFeatures: ['Directory access', 'Events'],
    amountLabel: '₹5,000', orderId: 'ORD-1', membershipNumber: '64F0C0FF', membershipType: 'annual',
    activatedLabel: '30 September 2026', validUntilLabel: '30 September 2027', daysLeft: 30, expiresInLabel: 'in 30 days',
    applicantEmail: 'tharun@example.com', applicantPhone: '+919876543210', applicantRegion: 'Guindy, Chennai, Tamil Nadu',
    adminRegion: 'Guindy, Chennai, Tamil Nadu', adminTierLabel: 'Block', reviewPath: '/block-admin/approvals'
};

/** Every string anywhere in a rendered message. */
const strings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
    return out;
};

/** The template chain, flattened. */
const chainOf = (wa) => {
    const list = [];
    for (let step = wa; step && step.template; step = step.fallback) list.push(step);
    return list;
};

/* Optional companion checkout: backend-only CI can still test message rendering. */
const websiteRoot = process.env.ACTIV_WEBSITE_ROOT || path.join(__dirname, '..', '..', 'website');
const appPath = path.join(websiteRoot, 'src', 'App.tsx');
const appTsx = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : null;
const ROUTES = [...(appTsx || '').matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
if (appTsx === null) console.log('SKIP: website route checks (set ACTIV_WEBSITE_ROOT to the website checkout to include them).');
const routeExists = (url) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    return ROUTES.some((r) => new RegExp(`^${r.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(p));
};

const testRendering = () => {
    section('every membership event renders cleanly, full and bare');
    const specs = templates.WHATSAPP_TEMPLATES;

    for (const event of MEMBERSHIP_EVENTS) {
        for (const [label, ctx] of [['full', full], ['bare', { name: '', firstName: '' }]]) {
            const out = templates.render(event, ctx);
            check(`${event} (${label}) renders`, !!out);
            if (!out) continue;

            const bad = strings(out).filter((s) => /\bundefined\b|\bnull\b|NaN|\[object Object\]/.test(s));
            check(`${event} (${label}) has no undefined/null/NaN text`, !bad.length, bad[0] && bad[0].slice(0, 120));

            if (out.email) {
                check(`${event} (${label}) email has a subject and a body`, !!out.email.subject && !!out.email.bodyHtml);
                const button = out.email.actionButton && out.email.actionButton.url;
                if (appTsx !== null) check(`${event} (${label}) button goes to a real page`, !button || routeExists(button), button);
            }

            const steps = chainOf(out.whatsapp);
            check(`${event} (${label}) has a WhatsApp template`, steps.length > 0);
            for (const step of steps) {
                check(`${event} (${label}) ${step.template}: no empty slot`,
                    step.params.every((p) => String(p === undefined || p === null ? '' : p).trim()),
                    JSON.stringify(step.params));
                const spec = specs.find((s) => s.name === step.template && s.meta);
                if (spec) {
                    check(`${event} (${label}) ${step.template}: ${spec.params.length} slots filled`,
                        step.params.length === spec.params.length, `${step.params.length} vs ${spec.params.length}`);
                    const placeholders = (spec.bodyWithVariables.match(/\{\{\d+\}\}/g) || []).length;
                    check(`${step.template}: body placeholders match its params`, placeholders === spec.params.length);
                }
            }
            if (label === 'full') {
                check(`${event} text names membership support`, !out.whatsapp.text || event === 'ADMIN_NEW_APPLICATION'
                    || (out.whatsapp.text.includes('member@activ.org.in') && out.whatsapp.text.includes('+91 82201 12188')));
            }
        }
    }
};

const testWording = () => {
    section('the words say what the review model says');
    const approved = templates.render('APPLICATION_APPROVED', full);
    check('approval quotes the resolved fee', approved.email.subject.includes('₹5,000'));
    check('approval highlights the plan and fee', approved.email.highlight && approved.email.highlight.value === '₹5,000');
    check('approval button pays that fee', approved.email.actionButton.label === 'Pay ₹5,000 now');

    const noPlan = templates.render('APPLICATION_APPROVED', { ...full, planName: '', feeLabel: '' });
    check('with no single plan, it asks them to choose rather than naming a price',
        !noPlan.email.highlight && noPlan.email.actionButton.label === 'Choose your plan and pay');

    const endorsed = templates.render('APPLICATION_ENDORSED', full);
    check('an endorsement says the State decides', /State Admin/.test(endorsed.email.bodyHtml)
        && /final decision/.test(endorsed.email.preheader));
    check('an endorsement never claims membership', !/membership is (now )?active|you are (now )?a member/i.test(strings(endorsed).join(' ')));

    const received = templates.render('APPLICATION_SUBMITTED', full);
    check('received says all three review together', /Block, District and State Admins are reviewing it now/.test(received.email.bodyHtml));
    check('no message describes the old one-tier-at-a-time relay',
        !MEMBERSHIP_EVENTS.some((e) => /then District, then State|now with the District/.test(strings(templates.render(e, full)).join(' '))));

    const expired = templates.render('MEMBERSHIP_RENEWAL_DUE', { ...full, daysLeft: 0 });
    check('an expired membership is said to have expired', /has expired/.test(expired.email.subject));
};

const testDecisions = async() => {
    section('which message each review decision sends');
    const notificationService = require('../src/modules/notifications/notification.service');
    const membershipContext = require('../src/modules/notifications/membershipContext');
    const applicationService = require('../src/modules/applications/application.service');

    const sent = [];
    notificationService.dispatchLifecycleEvent = async(event, to, payload) => { sent.push({ event, payload }); return {}; };
    membershipContext.forApplication = async() => ({ ...full, business: null, region: {} });
    membershipContext.planFor = async() => ({ planName: 'Growth Member', feeLabel: '₹5,000' });

    const app = (over = {}) => ({ _id: '64f0c0ffee000000000000a1', userId: '64f0c0ffee000000000000b2', fullName: 'Tharun',
        email: 't@example.com', status: 'Pending', reviews: {}, ...over });
    const run = async(application, tier, action, extra) => {
        sent.length = 0;
        await applicationService.notifyApplicant(application, tier, action, extra);
        return sent.map((s) => s.event);
    };

    check('Block approves an open file -> APPLICATION_ENDORSED',
        (await run(app({ reviews: { block: { decision: 'approved', adminType: 'BlockAdmin' } } }), 'block', 'approve'))
            .join() === 'APPLICATION_ENDORSED');
    check('Block OBJECTS -> nothing to the applicant',
        (await run(app({ reviews: { block: { decision: 'rejected', adminType: 'BlockAdmin' } } }), 'block', 'reject')).length === 0);
    check('District objects -> nothing to the applicant',
        (await run(app(), 'district', 'reject')).length === 0);
    check('Block approves after the District approved for itself -> nothing (they heard better news)',
        (await run(app({ reviews: { district: { decision: 'approved', adminType: 'DistrictAdmin' },
            block: { decision: 'approved', adminType: 'BlockAdmin' } } }), 'block', 'approve')).length === 0);
    check('District approves a file the State already approved -> nothing',
        (await run(app({ status: 'Approved' }), 'district', 'approve')).length === 0);
    check('State approves -> APPLICATION_APPROVED with the plan and fee',
        (await run(app({ status: 'Approved' }), 'state', 'approve')).join() === 'APPLICATION_APPROVED'
            && sent[0].payload.feeLabel === '₹5,000');
    check('State rejects -> CORRECTION_REQUESTED with the reason',
        (await run(app({ status: 'Rejected' }), 'state', 'reject', { reason: 'Unreadable GST' })).join() === 'CORRECTION_REQUESTED'
            && sent[0].payload.reason === 'Unreadable GST');
    check('Super Admin approves -> APPLICATION_APPROVED',
        (await run(app({ status: 'Approved' }), 'super', 'approve')).join() === 'APPLICATION_APPROVED');
};

const testRenewalWindows = () => {
    section('renewal reminder windows');
    const { windowFor } = require('../src/modules/notifications/membershipRenewal.service');
    check('45 days out: none', windowFor(45) === null);
    check('30 days out: the 30-day reminder', windowFor(30) === 30);
    check('12 days out: still the 30-day one', windowFor(12) === 30);
    check('7 days out: the 7-day reminder', windowFor(7) === 7);
    check('expiry day: the expired notice', windowFor(0) === 0);
    check('3 days after: still the expired notice', windowFor(-3) === 0);
    check('two weeks after: nothing more', windowFor(-14) === null);
};

const testConfig = () => {
    section('every template the journey sends is named in config');
    const t = config.botbee.templates;
    for (const key of ['accountWelcome', 'applicationReceived', 'applicationProgress', 'membershipApproved',
        'applicationDeclined', 'paymentPending', 'membershipActive', 'membershipRenewal', 'adminNewApplication',
        'accountWelcomeV2', 'applicationReceivedV2', 'adminNewApplicationV2']) {
        check(`config.botbee.templates.${key}`, !!t[key] && templates.WHATSAPP_TEMPLATES.some((s) => s.name === t[key]), t[key]);
    }
};

const testPlatinumRequest = () => {
    section('platinum request: the member is told, the office is told who to call');
    const mine = templates.render('PLATINUM_REQUESTED', {
        name: 'Tharun Kumar', firstName: 'Tharun', priceLabel: '₹2,00,000', planName: 'Platinum Lifetime',
        preferredContactLabel: 'WhatsApp', preferredTime: 'After 6 pm'
    });
    check('member: bell, email and WhatsApp', !!(mine && mine.inApp && mine.email && mine.whatsapp));
    check('member: says how they will be reached', /whatsapp/i.test(mine.inApp.message) && /After 6 pm/.test(mine.inApp.message));
    check('member: price in the email highlight', mine.email.highlight && mine.email.highlight.value === '₹2,00,000');
    check('member: WhatsApp falls back to an approved template', !!mine.whatsapp.template);

    const office = templates.render('ADMIN_PLATINUM_REQUEST', {
        name: 'ACTIV Office', applicantName: 'Tharun', applicantPhone: '9876543210', applicantEmail: 't@x.com',
        region: { block: 'Guindy', district: 'Chennai', state: 'Tamil Nadu' }, preferredContactLabel: 'Phone call',
        message: '<script>x</script>', priceLabel: '₹2,00,000'
    });
    const labels = (office.email.facts || []).filter((f) => f.value).map((f) => f.label);
    check('office: email only', !!office.email && !office.whatsapp && !office.inApp);
    check('office: name, mobile and region to call', ['Member', 'Mobile', 'Block', 'District', 'State'].every((l) => labels.includes(l)), labels.join(','));
    check('office: the member\'s message is escaped', !office.email.bodyHtml.includes('<script>'));
    check('both events are in the notification log enum', (() => {
        const src = fs.readFileSync(path.join(__dirname, '../src/modules/notifications/notificationLog.model.js'), 'utf8');
        return src.includes("'PLATINUM_REQUESTED'") && src.includes("'ADMIN_PLATINUM_REQUEST'");
    })());
};

const testContactAndRegion = () => {
    section('the contact is one person; the region is three fields');
    const help = (ctx) => templates.render('ACCOUNT_REGISTERED', ctx).whatsapp.text.split('Need help?')[1] || '';

    // A region office with no phone must not borrow ACTIV's number.
    const noPhone = help({ ...full, officePhone: '' });
    check('no phone -> ACTIV office as a set', /ACTIV Membership/.test(noPhone) && /82201 12188/.test(noPhone)
        && /member@activ\.org\.in/.test(noPhone) && !/Guindy/.test(noPhone), noPhone);
    const whole = help(full);
    check('regional contact is replaced by membership support', /ACTIV Membership/.test(whole) && /82201 12188/.test(whole)
        && /member@activ\.org\.in/.test(whole) && !/Guindy|90000 00000|block\.guindy@/.test(whole), whole);

    for (const ev of ['ACCOUNT_REGISTERED', 'APPLICATION_SUBMITTED', 'ADMIN_NEW_APPLICATION']) {
        const r = templates.render(ev, full);
        const labels = (r.email.facts || []).map((f) => f.label);
        check(`${ev}: email has Block, District, State`, ['Block', 'District', 'State'].every((l) => labels.includes(l))
            && !labels.includes('Region'), labels.join(','));
        check(`${ev}: WhatsApp has three region lines`, /Block: Guindy/.test(r.whatsapp.text)
            && /District: Chennai/.test(r.whatsapp.text) && /State: Tamil Nadu/.test(r.whatsapp.text));
        const chain = chainOf(r.whatsapp);
        check(`${ev}: v2 first, v1 behind it`, /_v2$/.test(chain[0].template) && /_v1$/.test((chain[1] || {}).template || ''),
            chain.map((c) => c.template).join(' -> '));
        const spec = templates.WHATSAPP_TEMPLATES.find((s) => s.name === chain[0].template);
        check(`${ev}: v2 param count matches its spec`, spec && spec.params.length === chain[0].params.length);
    }

    // An admin alert reads the APPLICANT's region, not the admin's own blank one.
    const admin = templates.render('ADMIN_NEW_APPLICATION', {
        ...full, state: '', district: '', block: '', region: { state: 'Kerala', district: 'Kochi', block: 'Edappally' }
    });
    check('admin alert: applicant region from ctx.region', /Block: Edappally/.test(admin.whatsapp.text));
};

(async() => {
    try {
        testRendering();
        testWording();
        await testDecisions();
        testRenewalWindows();
        testConfig();
        testContactAndRegion();
        testPlatinumRequest();
    } catch (error) {
        failed++;
        console.log(`  FAIL  crashed — ${error && error.stack}`);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
