require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function checkLiveStatus() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;

    const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/get/template/list', { apiToken, phone_number_id });
    const list = res.data.message || [];
    const t = list.find(x => x.template_name === 'activ_registration_welcome');

    console.log('--- ACTIV REGISTRATION WELCOME TEMPLATE STATUS ON BOTBEE ---');
    if (t) {
        console.log(JSON.stringify(t, null, 2));
    } else {
        console.log('Template activ_registration_welcome NOT FOUND in BotBee list yet. List contains:', list.map(x => x.template_name));
    }

    process.exit(0);
}

checkLiveStatus();
