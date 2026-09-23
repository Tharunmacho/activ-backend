require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testWelcomeSend() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';

    console.log('Sending activ_registration_welcome via BotBee send/template endpoint...');
    try {
        const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', {
            apiToken,
            phone_number_id,
            phone_number,
            template_id: '438245',
            template_data: ['Tharun']
        });
        console.log('BotBee Template Send Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error('Error:', err.message, err.response ? err.response.data : '');
    }

    process.exit(0);
}

testWelcomeSend();
