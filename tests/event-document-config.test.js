const assert = require('node:assert/strict');
const configPath = require.resolve('../src/config');
for (const [value, expected] of [[undefined, 'activ_event_document_v1'], ['activ_event_document_v1', 'activ_event_document_v1'], ['activ_event_document_readable_v2', 'activ_event_document_readable_v2'], ['none', 'none'], ['approved_custom_document', 'approved_custom_document']]) {
    if (value === undefined) delete process.env.BOTBEE_TPL_EVENT_DOCUMENT;
    else process.env.BOTBEE_TPL_EVENT_DOCUMENT = value;
    delete require.cache[configPath];
    assert.equal(require('../src/config').botbee.templates.eventDocument, expected);
}
console.log('PASS: document template defaults and explicit approved, custom, disabled and v2 configurations are preserved.');
