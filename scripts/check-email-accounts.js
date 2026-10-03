require('dotenv').config();
const email = require('../src/modules/notifications/email.service');
const { accountFor } = require('../src/modules/notifications/emailAccounts');
(async () => {
    for (const category of ['events', 'membership']) {
        const account = accountFor(category);
        if (!account.isConfigured) { console.log(`${category}: credentials not configured`); process.exitCode = 1; continue; }
        const transport = email.getTransporter(category);
        try {
            await transport.verify();
            console.log(`${category}: SMTP authentication verified for ${account.user}`);
            if (process.argv.includes('--send-test')) {
                const result = await email.sendEmail({ category, to: 'tharunroobika@gmail.com',
                    subject: `[TEST] ACTIV ${category} sender`,
                    text: `This test verifies that ${category} notifications use ${account.user}. No registration or payment has been made.`,
                });
                console.log(JSON.stringify({category,success:result.success,mock:result.mock,sender:result.sender,messageId:result.messageId,error:result.error}));
                if (!result.success || result.mock) process.exitCode = 1;
            }
        } catch (error) { console.log(`${category}: ${error.code || 'SMTP verification failed'}`); process.exitCode = 1; }
    }
})().catch(error => { console.error(error.code || 'Email check failed'); process.exitCode = 1; });
