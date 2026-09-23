require('dotenv').config();
const botbeeService = require('../src/modules/notifications/botbee.service');

async function testSend() {
    const testPhone = '918122282309';
    console.log("Testing live template send with template activ_registration_welcome...");
    
    const res = await botbeeService.sendTemplateMessage(
        testPhone,
        'activ_registration_welcome',
        ['Tharun Test User'],
        'en'
    );

    console.log("Send Result:");
    console.dir(res, { depth: null });
}

testSend().catch(console.error);
