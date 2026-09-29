/**
 * Render every membership-journey message to disk — each email as an HTML file,
 * and the WhatsApp text beside it — so they can be read before a member ever
 * receives one. Nothing is sent.
 *
 *   node scripts/preview-membership-messages.js [outDir]
 *
 * Open the .html files in a browser (the logo is the hosted one here, since the
 * embedded `cid:` logo only resolves inside a real email).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const templates = require('../src/modules/notifications/notificationTemplates');
const emailService = require('../src/modules/notifications/email.service');

const out = process.argv[2] || path.join(os.tmpdir(), 'activ-membership-previews');
fs.mkdirSync(out, { recursive: true });
process.env.EMAIL_LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://activ.org.in/logo_ACTIVian-removebg-preview.png';

const office = { name: 'Guindy Block Admin', phone: '+91 90000 00000', email: 'block.guindy@activ.org.in' };
const contact = { nearest: { regionName: 'Guindy', tierLabel: 'Block', name: '', phone: office.phone, email: office.email } };
const base = {
    name: 'Tharun Kumar', firstName: 'Tharun', email: 'tharun@example.com', phone: '+91 98765 43210',
    state: 'Tamil Nadu', district: 'Chennai', block: 'Guindy',
    officeName: office.name, officePhone: office.phone, officeEmail: office.email,
    reference: 'A1B2C3', applicantName: 'Tharun Kumar', businessName: 'Sri Lakshmi Enterprises',
    memberTypeLabel: 'Business membership', regionLabel: 'Guindy, Chennai, Tamil Nadu', submittedLabel: '27 September 2026',
    blockOffice: 'Guindy Block Admin', districtOffice: 'Chennai District Admin', stateOffice: 'Tamil Nadu State Admin',
    reviews: { block: { state: 'pending' }, district: { state: 'pending' }, state: { state: 'pending' } }
};

const CASES = {
    '1-account-registered': ['ACCOUNT_REGISTERED', {}],
    '2-application-submitted': ['APPLICATION_SUBMITTED', {}],
    '3-admin-new-application': ['ADMIN_NEW_APPLICATION', {
        name: 'Guindy Block Admin', applicantEmail: 'tharun@example.com', applicantPhone: '+91 98765 43210',
        applicantRegion: 'Guindy, Chennai, Tamil Nadu', adminRegion: 'Guindy, Chennai, Tamil Nadu',
        adminTierLabel: 'Block', reviewPath: '/block-admin/approvals'
    }],
    '4-block-approved': ['APPLICATION_ENDORSED', {
        endorsedBy: 'Guindy Block Admin', endorsedTierLabel: 'Block', decidedLabel: '28 September 2026',
        reviews: { block: { state: 'approved', byLine: 'Approved · 28 September 2026' }, district: { state: 'pending' }, state: { state: 'pending' } }
    }],
    '5-district-approved': ['APPLICATION_ENDORSED', {
        endorsedBy: 'Chennai District Admin', endorsedTierLabel: 'District', decidedLabel: '29 September 2026',
        reviews: { block: { state: 'approved', byLine: 'Approved · 28 September 2026' },
            district: { state: 'approved', byLine: 'Approved · 29 September 2026' }, state: { state: 'pending' } }
    }],
    '6-approved-ready-for-payment': ['APPLICATION_APPROVED', {
        decidedBy: 'Tamil Nadu State Admin', decidedLabel: '30 September 2026',
        planName: 'Growth Member', feeLabel: '₹5,000', planBand: '5 – 10 years',
        reviews: { block: { state: 'approved', byLine: 'Approved · 28 September 2026' },
            district: { state: 'approved', byLine: 'Approved · 29 September 2026' },
            state: { state: 'approved', byLine: 'Approved · 30 September 2026' } }
    }],
    '7-not-approved': ['CORRECTION_REQUESTED', {
        decidedBy: 'Tamil Nadu State Admin', decidedLabel: '30 September 2026',
        reason: 'The GST certificate uploaded could not be read. Please upload a clear copy.',
        reasonHtml: 'The GST certificate uploaded could not be read. Please upload a clear copy.'
    }],
    '8-payment-pending': ['PAYMENT_REQUIRED', { amountLabel: '₹5,000', planName: 'Growth Member', reference: 'ORD-8F2K1Q' }],
    '9-membership-active': ['MEMBERSHIP_ACTIVATED', {
        membershipNumber: '64F0C0FF', planName: 'Growth Member', amountLabel: '₹5,000', orderId: 'MOJO5A01234',
        activatedLabel: '1 October 2026', validUntilLabel: '1 October 2027', stage: 'active'
    }],
    '10-renewal-due': ['MEMBERSHIP_RENEWAL_DUE', {
        membershipNumber: '64F0C0FF', planName: 'Growth Member', validUntilLabel: '1 October 2027', daysLeft: 30, expiresInLabel: 'in 30 days'
    }]
};

for (const [file, [event, extra]] of Object.entries(CASES)) {
    const ctx = { ...base, ...extra };
    const r = templates.render(event, ctx);
    if (r.email) {
        const html = emailService.buildHtmlTemplate({ ...r.email, recipientName: ctx.name, contact });
        fs.writeFileSync(path.join(out, `${file}.html`), html);
    }
    const steps = [];
    for (let s = r.whatsapp; s && s.template; s = s.fallback) steps.push(`${s.template}(${s.params.length})`);
    fs.writeFileSync(path.join(out, `${file}.whatsapp.txt`),
        `SUBJECT: ${r.email ? r.email.subject : '(no email)'}\nTEMPLATE CHAIN: ${steps.join(' -> ')}\n\n${r.whatsapp.text}\n`);
}
console.log(`Previews written to ${out}`);
