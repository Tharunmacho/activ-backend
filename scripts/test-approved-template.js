require('dotenv').config();
const botbeeService = require('../src/modules/notifications/botbee.service');

async function testApproved() {
    const phone = '919092317264';

    console.log('--- Testing Approved Template ccmsg ---');
    const res1 = await botbeeService.dispatch('template', phone, {
        phone_number: phone,
        template_name: 'ccmsg',
        template_data: ['tharun', 'ACTIV Membership', 'https://activ.org.in', 'tharunroobika@gmail.com'],
        language: 'en_US'
    }, 'ccmsg');
    console.log('Result for ccmsg:', JSON.stringify(res1, null, 2));

    console.log('\n--- Testing Approved Template regcnfrmmsg ---');
    const res2 = await botbeeService.dispatch('template', phone, {
        phone_number: phone,
        template_name: 'regcnfrmmsg',
        template_data: [
            'tharun', 'ACTIV Platform', 'tharun', '9092317264',
            'tharunroobika@gmail.com', 'ACTIV Membership Registration', 'ACTIV Office',
            '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com'
        ],
        language: 'en_GB'
    }, 'regcnfrmmsg');
    console.log('Result for regcnfrmmsg:', JSON.stringify(res2, null, 2));

    process.exit(0);
}

testApproved();
