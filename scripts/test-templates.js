require('dotenv').config();
const botbeeService = require('../src/modules/notifications/botbee.service');

async function testTemplates() {
    const templatesToTest = [
        'membership',
        'cnfrm',
        'fb_wa',
        'system_order_success_notification_new',
        'activ_registration_welcome'
    ];

    for (const t of templatesToTest) {
        console.log(`\nTesting template: ${t}...`);
        const res = await botbeeService.dispatch('template', '919092317264', {
            phone_number: '919092317264',
            template_name: t,
            template_data: ['tharun']
        }, t);
        console.log(`Result for ${t}:`, JSON.stringify(res, null, 2));
    }

    process.exit(0);
}

testTemplates();
