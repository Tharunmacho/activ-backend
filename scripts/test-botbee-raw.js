require('dotenv').config();
const botbeeService = require('../src/modules/notifications/botbee.service');

async function testRaw() {
    const res1 = await botbeeService.sendTextMessage('919092317264', 'Hello tharun! Direct test message from BotBee ACTIV.');
    console.log('--- RAW BOTBEE RESPONSE FOR TEXT ---');
    console.log(JSON.stringify(res1, null, 2));

    const res2 = await botbeeService.sendTemplateMessage('919092317264', 'activ_registration_welcome', ['tharun']);
    console.log('--- RAW BOTBEE RESPONSE FOR TEMPLATE ---');
    console.log(JSON.stringify(res2, null, 2));

    process.exit(0);
}

testRaw();
