const assert = require('node:assert/strict');
const { FOOTER } = require('../src/modules/notifications/organizationBrand');
const definitions = require('../src/modules/notifications/notificationTemplates').WHATSAPP_TEMPLATES;
const association = require('../src/modules/notifications/associationUpdateMessage').templateDefinition();
assert(FOOTER.length <= 60, 'full association name fits the provider footer');
for (const definition of definitions.filter(item => item.meta && item.footer)) {
    assert.equal(definition.footer, FOOTER, `${definition.name} uses the full association name`);
}
assert.equal(association.components.find(item => item.type === 'FOOTER').text, FOOTER);
assert(definitions.find(item => item.name === 'activ_record_update_v1'), 'approved workflow name is preserved');
const html = require('../src/modules/notifications/email.service').buildHtmlTemplate({ title: 'Local test', bodyHtml: '<p>Test</p>', recipientName: 'Test member' });
assert.match(html.slice(html.indexOf('<!-- Footer -->')), /Adidravidar Confederation of Trade and Industrial Vision/);
console.log('PASS all declared WhatsApp footers and email footer use the full association name; template names preserved');
