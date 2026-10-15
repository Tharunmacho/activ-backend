#!/usr/bin/env node
// Prints a reviewable template by default. --status is read-only; --submit
// creates only this template for Meta review and never messages any recipient.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { templateDefinition } = require('../src/modules/notifications/associationUpdateMessage');
const definition = templateDefinition();
const args = new Set(process.argv.slice(2));
(async () => {
    if (!args.has('--status') && !args.has('--submit')) { console.log(JSON.stringify(definition, null, 2)); return; }
    const token = process.env.META_ACCESS_TOKEN;
    const waba = process.env.META_WABA_ID;
    if (!token || !waba) throw new Error('Set META_ACCESS_TOKEN and META_WABA_ID to check or submit the template.');
    const config = require('../src/config').metaCloud;
    const url = `${config.baseUrl}/${config.apiVersion}/${waba}/message_templates`;
    const options = { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 };
    const found = await axios.get(url, { ...options, params: { name: definition.name, fields: 'name,status,language,category,components', limit: 100 } });
    const existing = (found.data?.data || []).find(item => item.name === definition.name && item.language === definition.language);
    if (existing) {
        const body = existing.components?.find(component => component.type === 'BODY')?.text;
        console.log(JSON.stringify({ name: definition.name, language: definition.language, status: existing.status,
            category: existing.category, contractMatches: body === definition.components[0].text }));
    } else if (args.has('--submit')) {
        const result = await axios.post(url, definition, options);
        console.log(JSON.stringify({ name: definition.name, language: definition.language, status: result.data?.status || 'SUBMITTED_FOR_REVIEW', category: result.data?.category || definition.category }));
    } else console.log(JSON.stringify({ name: definition.name, language: definition.language, status: 'NOT_CREATED' }));
})().catch(error => {
    // Axios error objects contain Authorization headers; never dump them.
    console.error(JSON.stringify({ error: String(error.response?.data?.error?.message || error.message || 'Template request failed').slice(0, 500), code: error.response?.data?.error?.code }));
    process.exitCode = 1;
});
