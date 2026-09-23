require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testEndpoints() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';

    const endpoints = [
        'https://app.botbee.io/api/v1/whatsapp/send',
        'https://app.botbee.io/api/v1/whatsapp/send/template',
        'https://app.botbee.io/api/v1/whatsapp/send-template',
        'https://app.botbee.io/api/v1/whatsapp/template/send',
        'https://app.botbee.io/api/v1/whatsapp/send_template',
        'https://app.botbee.io/api/v1/whatsapp/trigger-bot'
    ];

    for (const ep of endpoints) {
        console.log(`\nTesting endpoint: ${ep}...`);
        try {
            const res = await axios.post(ep, {
                apiToken,
                phone_number_id,
                phone_number,
                template_name: 'ccmsg',
                template_data: ['tharun', 'ACTIV', 'https://activ.org.in', 'tharunroobika@gmail.com'],
                language: 'en_US'
            });
            console.log('Response:', JSON.stringify(res.data, null, 2));
        } catch (err) {
            console.log('Status/Error:', err.response ? err.response.status : err.message, err.response ? err.response.data : '');
        }
    }

    process.exit(0);
}

testEndpoints();
