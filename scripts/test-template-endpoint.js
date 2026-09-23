require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testTemplateEndpoint() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';

    const payloads = [
        {
            name: 'ccmsg with template_name',
            data: { apiToken, phone_number_id, phone_number, template_name: 'ccmsg', template_data: ['tharun', 'ACTIV', 'https://activ.org.in', 'tharunroobika@gmail.com'] }
        },
        {
            name: 'regcnfrmmsg with template_name',
            data: {
                apiToken, phone_number_id, phone_number, template_name: 'regcnfrmmsg',
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
        },
        {
            name: 'ccmsg with template_id 1058861310370772',
            data: { apiToken, phone_number_id, phone_number, template_id: '1058861310370772', template_data: ['tharun', 'ACTIV', 'https://activ.org.in', 'tharunroobika@gmail.com'] }
        },
        {
            name: 'regcnfrmmsg with template_id 1381433743953987',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '1381433743953987',
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
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

testTemplateEndpoint();
