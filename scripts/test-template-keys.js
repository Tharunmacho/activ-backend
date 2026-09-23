require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testKeys() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';

    const payloads = [
        {
            name: 'template_name + language',
            data: { apiToken, phone_number_id, phone_number, template_name: 'regcnfrmmsg', language: 'en_GB' }
        },
        {
            name: 'template_id (DB id 419760)',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760' }
        },
        {
            name: 'template_id (Meta id 1381433743953987)',
            data: { apiToken, phone_number_id, phone_number, template_id: '1381433743953987' }
        },
        {
            name: 'whatsapp_business_id 115270',
            data: { apiToken, phone_number_id: '115270', phone_number, template_name: 'regcnfrmmsg' }
        }
    ];

    for (const p of payloads) {
        console.log(`\nTesting ${p.name}...`);
        try {
            const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', p.data);
            console.log('Response:', JSON.stringify(res.data, null, 2));
        } catch (err) {
            console.log('Error:', err.message, err.response ? err.response.data : '');
        }
    }

    process.exit(0);
}

testKeys();
