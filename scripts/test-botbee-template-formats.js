require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testFormats() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';

    const payloads = [
        {
            name: 'Format 1: template_name + template_data',
            data: { apiToken, phone_number_id, phone_number, template_name: 'membership', template_data: ['tharun'] }
        },
        {
            name: 'Format 2: template_name + template_jsoncode',
            data: { apiToken, phone_number_id, phone_number, template_name: 'membership' }
        },
        {
            name: 'Format 3: is_template=1',
            data: { apiToken, phone_number_id, phone_number, is_template: '1', template_name: 'membership' }
        },
        {
            name: 'Format 4: template_id',
            data: { apiToken, phone_number_id, phone_number, template_id: 'membership' }
        }
    ];

    for (const p of payloads) {
        console.log(`\nTesting ${p.name}...`);
        try {
            const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send', p.data);
            console.log('Response:', JSON.stringify(res.data, null, 2));
        } catch (err) {
            console.log('Error:', err.message, err.response ? err.response.data : '');
        }
    }

    process.exit(0);
}

testFormats();
