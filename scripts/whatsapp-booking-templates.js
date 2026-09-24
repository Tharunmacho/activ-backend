#!/usr/bin/env node
/**
 * The detailed WhatsApp event-booking templates, on Meta.
 *
 *   node scripts/whatsapp-booking-templates.js            print what would be submitted
 *   node scripts/whatsapp-booking-templates.js --submit   create them for Meta review
 *   node scripts/whatsapp-booking-templates.js --status   show each one's review status
 *
 * Needs META_ACCESS_TOKEN and META_WABA_ID (the WhatsApp Business Account id —
 * Meta Business Suite -> WhatsApp Manager -> Account tools, or Business
 * Settings -> WhatsApp accounts). The token must carry
 * `whatsapp_business_management`.
 *
 * Nothing is sent to anybody. Creating a template only puts it into review;
 * once `--status` says APPROVED, set its name in backend/.env
 * (BOTBEE_TPL_BOOKING, BOTBEE_TPL_BOOKING_CANCEL, BOTBEE_TPL_BOOKING_REMINDER)
 * and restart. Until then the booking messages keep going out through the
 * already-approved generic event template, so nothing breaks while waiting.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const templates = require('../src/modules/notifications/notificationTemplates');

const args = new Set(process.argv.slice(2));
const token = process.env.META_ACCESS_TOKEN || '';
const waba = process.env.META_WABA_ID || '';
const version = process.env.META_API_VERSION || 'v21.0';
const base = (process.env.META_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, '');
const language = process.env.META_TEMPLATE_LANGUAGE || 'en_US';

const booking = templates.WHATSAPP_TEMPLATES.filter((t) => t.meta);

const payloadFor = (t) => ({
    name: t.name,
    language,
    category: 'UTILITY',
    components: [
        {
            type: 'BODY',
            text: t.bodyWithVariables,
            example: { body_text: [t.samples] }
        },
        { type: 'FOOTER', text: 'ACTIV Platform' }
    ]
});

const need = () => {
    if (!token || !waba) {
        console.error('\nSet META_ACCESS_TOKEN and META_WABA_ID in backend/.env first.\n');
        process.exit(1);
    }
};

(async() => {
    if (args.has('--status')) {
        need();
        for (const t of booking) {
            try {
                const res = await axios.get(`${base}/${version}/${waba}/message_templates`, {
                    params: { name: t.name, fields: 'name,status,language,rejected_reason' },
                    headers: { Authorization: `Bearer ${token}` },
                    timeout: 20000
                });
                const rows = (res.data && res.data.data) || [];
                console.log(`${t.name.padEnd(28)} ${rows.length
                    ? rows.map((r) => `${r.status} (${r.language})${r.rejected_reason && r.rejected_reason !== 'NONE'
                        ? ` - ${r.rejected_reason}` : ''}`).join(', ')
                    : 'not created'}   -> ${t.envKey}=${t.name}`);
            } catch (error) {
                console.log(`${t.name}: ${JSON.stringify((error.response && error.response.data) || error.message)}`);
            }
        }
        return;
    }

    if (!args.has('--submit')) {
        console.log('\nDRY RUN - these would be submitted for review (add --submit):\n');
        for (const t of booking) {
            console.log(`== ${t.name}   (${t.envKey})`);
            console.log(t.bodyWithVariables);
            console.log('Samples:', t.samples.map((s, i) => `{{${i + 1}}}=${s}`).join(' | '));
            console.log('');
        }
        return;
    }

    need();
    for (const t of booking) {
        try {
            const res = await axios.post(`${base}/${version}/${waba}/message_templates`, payloadFor(t), {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 20000
            });
            console.log(`${t.name}: submitted - ${JSON.stringify(res.data)}`);
        } catch (error) {
            console.log(`${t.name}: ${JSON.stringify((error.response && error.response.data) || error.message)}`);
        }
    }
    console.log('\nRun with --status in a few minutes. When APPROVED, put the names in backend/.env and restart.');
})();
