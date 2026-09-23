require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function getTemplates() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;

    console.log('Fetching BotBee template list for phone_number_id:', phone_number_id);
    try {
        const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/get/template/list', {
            apiToken,
            phone_number_id
        });
        console.log('Template List Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error('Error fetching template list:', err.message, err.response ? err.response.data : '');
    }

    process.exit(0);
}

getTemplates();
