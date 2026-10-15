const axios = require('axios');
const config = require('../../config');
const messages = require('./associationUpdateMessage');
const whatsapp = require('./whatsappTemplate');
let cached, pending;

// Approval checks never send a message. Cache across recipients so a broadcast
// needs one provider read per interval, rather than one read per member.
async function status() {
    const meta = config.metaCloud;
    const account = String(process.env.META_WABA_ID || '').trim();
    if (whatsapp.providerName() !== 'meta') {
        return { ready: true, checked: false };
    }
    if (!meta.accessToken || !account) {
        return { ready: false, checked: false, status: 'UNKNOWN',
            reason: 'Association Update WhatsApp delivery is waiting for Meta approval verification. Configure META_WABA_ID and META_ACCESS_TOKEN so approval can be checked.' };
    }
    const definition = messages.templateDefinition();
    const key = `${account}:${definition.name}:${definition.language}`;
    if (cached?.key === key && cached.until > Date.now()) return cached.result;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
        let result;
        try {
            const response = await axios.get(`${meta.baseUrl}/${meta.apiVersion}/${account}/message_templates`, {
                headers: { Authorization: `Bearer ${meta.accessToken}` }, timeout: 10000,
                params: { name: definition.name, fields: 'name,status,language,components', limit: 100 },
            });
            const template = response.data?.data?.find(item => item.name === definition.name && item.language === definition.language);
            const approved = template?.status === 'APPROVED';
            const body = template?.components?.find(item => item.type === 'BODY')?.text;
            const matches = body === definition.components.find(item => item.type === 'BODY').text;
            result = { checked: true, ready: approved && matches, status: template?.status || 'NOT_CREATED',
                reason: approved && !matches ? 'The approved WhatsApp template does not match this update format.'
                    : approved ? '' : `Association Update WhatsApp template is ${template?.status || 'not available'}. Waiting for Meta approval.` };
        } catch {
            // Never serialize an Axios error: it can contain the auth header.
            result = { checked: true, ready: false, status: 'UNKNOWN', reason: 'WhatsApp template approval could not be verified. It will be checked again.' };
        }
        cached = { key, result, until: Date.now() + (result.status === 'UNKNOWN' ? 60000 : 5 * 60000) };
        return result;
    })();
    pending = { key, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
}
const clearCache = () => { cached = undefined; pending = undefined; };
module.exports = { status, clearCache };
