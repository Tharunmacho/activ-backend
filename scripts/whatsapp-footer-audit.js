#!/usr/bin/env node
// Default: a reviewable desired-footer manifest. --status only reads Meta;
// it never edits an approved template or sends messages to recipients.
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });
const axios = require('axios');
const config = require('../src/config');
const { FOOTER } = require('../src/modules/notifications/organizationBrand');
const definitions = require('../src/modules/notifications/notificationTemplates').WHATSAPP_TEMPLATES;
const association = require('../src/modules/notifications/associationUpdateMessage').templateDefinition();
const desired = [...new Map([...definitions.filter(item => item.meta).map(item => [item.name, { name: item.name, footer: item.footer || FOOTER }]),
    [association.name, { name: association.name, footer: FOOTER }]]).values()];
(async () => {
    const patch = process.argv.includes('--patch');
    if (!process.argv.includes('--status') && !patch) {
        console.log(JSON.stringify({ mode: 'preview', desiredFooter: FOOTER, templates: desired,
            nextStep: 'Existing approved Meta templates must be edited/reviewed in WhatsApp Manager. Local code cannot replace the footer in an already approved template. Template names and body parameters stay unchanged.' }, null, 2));
        return;
    }
    const token = process.env.META_ACCESS_TOKEN;
    const account = process.env.META_WABA_ID;
    if (!token || !account) throw new Error('META_ACCESS_TOKEN and META_WABA_ID are required to read template status.');
    const meta = config.metaCloud;
    const templates = [];
    let after;
    for (let page = 0; page < 20; page++) {
        const result = await axios.get(`${meta.baseUrl}/${meta.apiVersion}/${account}/message_templates`, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 20000,
            params: { fields: 'id,name,status,language,components', limit: 100, ...(after ? { after } : {}) },
        });
        templates.push(...(result.data?.data || []));
        if (!result.data?.paging?.next) break;
        after = result.data?.paging?.cursors?.after;
        if (!after) break;
    }
    const names = new Set(desired.map(item => item.name));
    // Include configured generic fallbacks too; these can have a different
    // approved name from the versioned definitions in this checkout.
    for (const name of Object.values(config.botbee.templates || {})) if (typeof name === 'string') names.add(name);
    const rows = templates.filter(item => names.has(item.name)).map(item => {
        const footer = item.components?.find(part => part.type === 'FOOTER')?.text || '';
        return { id: item.id, name: item.name, language: item.language, status: item.status, footer, matches: footer === FOOTER };
    });
    if (patch) {
        console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'review-only', applied: false, desiredFooter: FOOTER,
            source: 'Read-only Meta message_templates response',
            instruction: 'For each template, replace its FOOTER component text with desiredFooter. Preserve all other components, parameter positions, name, language and category. Re-read provider status before any change. This artifact is a component patch, not a complete Graph request body.',
            templates: rows.filter(item => !item.matches).map(item => ({ templateId: item.id, name: item.name, language: item.language, observedStatus: item.status,
                readyForReview: item.status === 'APPROVED', before: { type: 'FOOTER', text: item.footer }, after: { type: 'FOOTER', text: FOOTER },
                nonFooterDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(templates.find(template => template.id === item.id).components.filter(component => component.type !== 'FOOTER'))).digest('hex') })) }, null, 2));
        return;
    }
    console.log(JSON.stringify({ mode: 'read-only', desiredFooter: FOOTER, found: rows.length,
        needsProviderUpdate: rows.filter(item => !item.matches), matching: rows.filter(item => item.matches).map(item => item.name) }, null, 2));
})().catch(error => {
    // Axios error objects contain Authorization headers. Log only safe text.
    console.error(JSON.stringify({ error: String(error.response?.data?.error?.message || error.message).slice(0, 500) }));
    process.exitCode = 1;
});
