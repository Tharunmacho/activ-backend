require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const botbeeService = require('../src/modules/notifications/botbee.service');

async function testSubscriberCreate() {
    const apiToken = config.botbee.apiToken;
    const phoneNumberID = config.botbee.phoneNumberId;
    const phone = '919092317264';
    const name = 'tharun';

    console.log('--- STEP 1: Creating Subscriber in BotBee ---');
    try {
        const createRes = await axios.post('https://app.botbee.io/api/v1/whatsapp/subscriber/create', {
            apiToken,
            phoneNumberID,
            name,
            phoneNumber: phone
        });
        console.log('Subscriber create response:', JSON.stringify(createRes.data, null, 2));
    } catch (e) {
        console.error('Subscriber create failed:', e.message, e.response ? e.response.data : '');
    }

    console.log('\n--- STEP 2: Retrying Send Message ---');
    const sendRes = await botbeeService.sendTextMessage(phone, 'Hello tharun! This is your automatic ACTIV WhatsApp welcome message.');
    console.log('Send message response:', JSON.stringify(sendRes, null, 2));

    process.exit(0);
}

testSubscriberCreate();
