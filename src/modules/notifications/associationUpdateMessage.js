const config = require('../../config');
const email = require('./email.service');
const { personalizeUpdate, personalizeText } = require('../common/recipientPersonalization');

const line = (value, max) => email.htmlToText(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const templateName = () => process.env.ASSOCIATION_UPDATE_WHATSAPP_TEMPLATE || 'activ_association_update_v2';
const templateCategory = () => String(process.env.ASSOCIATION_UPDATE_WHATSAPP_CATEGORY || 'MARKETING').toUpperCase() === 'UTILITY' ? 'UTILITY' : 'MARKETING';
const templateLanguage = () => process.env.ASSOCIATION_UPDATE_WHATSAPP_LANGUAGE || 'en_US';
const templateBody = 'Dear *{{1}}*,\n\n*ACTIV association news and updates*\n\n*{{2}}*\n{{3}}\n\nSign in to read the full update and view any poster or document:\n{{4}}\n\nYou can manage WhatsApp association updates in your ACTIV notification settings.';

// Public uploads are already validated by the update editor. Do not let a
// legacy data:/javascript: URL become an image or button in a mail client.
function mediaUrl(value) {
    const raw = String(value || '').trim();
    if (/^\/uploads\//.test(raw)) return `${require('../../config/publicUrl').publicOrigin()}${raw}`;
    try { const url = new URL(raw); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
    catch { return ''; }
}

function render(update, member) {
    update = personalizeUpdate(update, member);
    const name = line(personalizeText('{name}', member, update), 60) || 'ACTIVian';
    const title = line(update?.title, 200) || 'Association update';
    const text = email.htmlToText(update?.body || update?.summary || 'Please open the update to view the poster or document.');
    const summary = line(update?.summary || text, 350) || 'Please open the update to view the poster or document.';
    const base = String(config.frontendUrl || 'https://activ.org.in').replace(/\/+$/, '');
    const id = String(update?._id || update?.id || '');
    const url = `${base}/member/updates${id ? `/${encodeURIComponent(id)}` : ''}`;
    const settingsUrl = `${base}/member/settings`;
    const document = mediaUrl(update?.attachmentUrl);
    const bodyHtml = text.split(/\n\s*\n/).map(paragraph => `<p style="margin:0 0 16px;">${email.escape(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
    const html = email.buildHtmlTemplate({
        category: 'membership', title, recipientName: name, preheader: summary,
        badge: 'Association update', bodyHtml,
        poster: mediaUrl(update?.bannerUrl),
        actionButton: { label: 'Read the full update', url },
        secondaryButton: document ? { label: line(update?.attachmentLabel, 100) || 'Open document', url: document } : null,
        afterHtml: `<p style="margin:16px 0;">Thank you for being part of ACTIV.</p><p style="font-size:13px;line-height:1.6;">You received this update because it applies to your membership and region. <a href="${email.escape(settingsUrl)}">Manage update messages</a>.</p>`,
    });
    const params = [name, line(title, 150), summary, url];
    const whatsappText = templateBody.replace(/\{\{(\d)\}\}/g, (_, n) => params[Number(n) - 1]);
    return { subject: `ACTIV update: ${title}`, html,
        text: `Dear ${name},\n\n${title}\n\n${text}\n\nRead the full update: ${url}${document ? `\n${line(update?.attachmentLabel, 100) || 'Document'}: ${document}` : ''}\n\nThank you for being part of ACTIV.\nManage update messages: ${settingsUrl}`,
        params, whatsappText, template: templateName(), language: templateLanguage(), url };
}

function templateDefinition() {
    return { name: templateName(), language: templateLanguage(), category: templateCategory(), components: [
        { type: 'BODY', text: templateBody, example: { body_text: [['Tharun', 'Member learning programme',
            'Dear member, please join our upcoming learning programme. Open this update for the schedule and registration details.',
            'https://activ.org.in/member/updates/507f1f77bcf86cd799439011']] } },
        { type: 'FOOTER', text: require('./organizationBrand').FOOTER },
    ] };
}
module.exports = { render, templateName, templateLanguage, templateDefinition, mediaUrl };
