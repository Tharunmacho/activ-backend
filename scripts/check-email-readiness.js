'use strict';

// Handshake only. No sendMail, notification workers, or database connection.
// Run from backend/: node scripts/check-email-readiness.js
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env'), quiet: true });
const nodemailer = require('nodemailer');
const { accountFor, accountStatus } = require('../src/modules/notifications/emailAccounts');

async function check(category) {
    const account = accountFor(category);
    const status = { ...accountStatus(category), authenticated: false };
    if (!status.configured) return status;
    const transport = nodemailer.createTransport({
        host: account.host, port: account.port, secure: account.secure,
        auth: { user: account.user, pass: account.password },
        connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    try {
        status.authenticated = (await transport.verify()) === true;
    } catch (error) {
        status.error = {
            code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'SMTP_CHECK_FAILED',
            responseCode: Number(error.responseCode) || null,
        };
    } finally {
        transport.close();
    }
    return status;
}

Promise.all(['events', 'membership'].map(check)).then(accounts => {
    console.log(JSON.stringify({
        checkedAt: new Date().toISOString(), accounts, messagesSent: 0,
        source: 'Local backend environment; deployed settings are not inspected.',
        limitation: 'SMTP authentication does not prove inbox delivery. Check provider delivery/bounce events separately.',
    }, null, 2));
    if (accounts.some(account => !account.authenticated)) process.exitCode = 1;
}).catch(() => {
    console.error('Email readiness check failed; connection details suppressed.');
    process.exitCode = 1;
});
