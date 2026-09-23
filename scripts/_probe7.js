require('dotenv').config();
const axios = require('axios');
const b = require('../src/config').botbee;
const URL = `${b.baseUrl}/api/v1/whatsapp/send/template`;
const PH = '910000000000';
const NAME = 'activ_registration_welcome';
const variants = [
  ['template_name + en_US',   { template_name: NAME, language: 'en_US' }],
  ['template_name only',      { template_name: NAME }],
  ['template',                { template: NAME, language: 'en_US' }],
  ['name',                    { name: NAME, language: 'en_US' }],
  ['template_id numeric',     { template_id: '716936264681829', language: 'en_US' }],
  ['template_id row id',      { template_id: '224700', language: 'en_US' }],
  ['id row id',               { id: '224700', language: 'en_US' }],
  ['template_name + locale',  { template_name: NAME, locale: 'en_US' }],
  ['template_name + en',      { template_name: NAME, language: 'en' }],
  ['template_name+lang+data', { template_name: NAME, language: 'en_US', template_data: { '1': 'Tharun' } }],
];
(async () => {
  for (const [label, extra] of variants) {
    const r = await axios.post(URL, { apiToken: b.apiToken, phone_number_id: b.phoneNumberId, phone_number: PH, ...extra },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000, validateStatus: () => true });
    const m = (r.data && r.data.message) || JSON.stringify(r.data);
    console.log(`  ${label.padEnd(28)} ${String(m).slice(0,110)}`);
  }
})();
