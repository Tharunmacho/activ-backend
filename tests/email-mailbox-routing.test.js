// Isolated fixtures only. Never reads .env, opens a socket, or touches a database.
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
dotenv.config = () => ({ parsed: {} });
process.env.NODE_ENV = 'test';
const loggerPath = require.resolve('../src/config/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info() {}, warn() {}, error() {}, debug() {} } };
const paths = ['../src/config', '../src/modules/notifications/emailAccounts',
    '../src/modules/notifications/email.service', '../src/core/utils/mailer', '../src/core/utils/archiveCopy'];
const baseEnv = { EMAIL_HOST: 'legacy-relay.fixture.test', EMAIL_PORT: '587', EMAIL_SECURE: 'false',
    EMAIL_USER: 'legacy-login-fixture', EMAIL_PASS: 'legacy-password-fixture', EMAIL_ARCHIVE_COPY: 'off',
    EMAIL_DEFAULT_FROM: 'legacy-from@example.test', EMAIL_USE_REGIONAL_FROM: 'true' };
const separateEnv = { EVENT_EMAIL_TRANSPORT: 'separate', EVENT_EMAIL_HOST: 'event-mail.fixture.test',
    EVENT_EMAIL_USER: 'event-login-fixture', EVENT_EMAIL_PASS: 'event-password-fixture',
    MEMBER_EMAIL_TRANSPORT: 'separate', MEMBER_EMAIL_HOST: 'member-mail.fixture.test',
    MEMBER_EMAIL_USER: 'member-login-fixture', MEMBER_EMAIL_PASS: 'member-password-fixture' };
let transports = [], sends = [], rejectUser = '', checks = 0;
nodemailer.createTransport = options => {
    const transport = { options: structuredClone(options),
        async sendMail(message) {
            sends.push({ options: structuredClone(options), message });
            if (options.auth.user === rejectUser) throw Object.assign(new Error('535 Fixture authentication failed'), { code: 'EAUTH' });
            return { messageId: 'offline-fixture-message', accepted: [message.to], rejected: [] };
        },
    };
    transports.push(transport);
    return transport;
};
function load(overrides = {}) {
    for (const key of Object.keys(process.env)) if (/^(?:EMAIL_|EVENT_EMAIL_|MEMBER_EMAIL_)/.test(key)) delete process.env[key];
    Object.assign(process.env, baseEnv, overrides);
    for (const modulePath of paths) delete require.cache[require.resolve(modulePath)];
    transports = []; sends = []; rejectUser = '';
    return { accounts: require('../src/modules/notifications/emailAccounts'),
        email: require('../src/modules/notifications/email.service'), mailer: require('../src/core/utils/mailer') };
}
function expectTransport(actual, category, overrides = {}) {
    assert.deepEqual(actual, {
        host: category === 'events' ? separateEnv.EVENT_EMAIL_HOST : separateEnv.MEMBER_EMAIL_HOST,
        port: 465, secure: true,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        auth: category === 'events'
            ? { user: separateEnv.EVENT_EMAIL_USER, pass: separateEnv.EVENT_EMAIL_PASS }
            : { user: separateEnv.MEMBER_EMAIL_USER, pass: separateEnv.MEMBER_EMAIL_PASS },
        ...overrides,
    });
}
const message = { to: 'recipient@example.test', subject: 'Offline mailbox routing fixture', text: 'Fixture only' };
async function test(name, body) {
    await body(); checks++;
    console.log(`PASS ${name}`);
}

async function main() {
    await test('shared mode preserves the base SMTP transport for both sender identities', async () => {
        const { accounts, email } = load({ ...separateEnv, EVENT_EMAIL_TRANSPORT: 'shared', MEMBER_EMAIL_TRANSPORT: 'shared' });
        for (const category of ['events', 'membership']) {
            const account = accounts.accountFor(category);
            assert.equal(account.host, baseEnv.EMAIL_HOST);
            assert.equal(account.user, baseEnv.EMAIL_USER);
            assert.equal(account.password, baseEnv.EMAIL_PASS);
            assert.equal(account.port, 587); assert.equal(account.secure, false);
            assert.equal(accounts.accountStatus(category).transport, 'shared');
            const result = await email.sendEmail({ ...message, category });
            assert.equal(result.success, true); assert(!result.mock);
        }
        assert.equal(sends.length, 2);
        for (const send of sends) assert.deepEqual(send.options.auth,
            { user: baseEnv.EMAIL_USER, pass: baseEnv.EMAIL_PASS });
    });

    await test('separate event and member mail use their own credentials and default TLS on 465', async () => {
        const { accounts, email } = load(separateEnv);
        for (const category of ['events', 'membership']) {
            const account = accounts.accountFor(category);
            assert.equal(account.isConfigured, true);
            assert.equal(account.port, 465); assert.equal(account.secure, true);
            assert.equal(account.useRegionalFrom, false);
            assert.equal(accounts.accountStatus(category).transport, 'separate');
            const result = await email.sendEmail({ ...message, category });
            assert.equal(result.success, true); assert(!result.mock);
        }
        assert.equal(transports.length, 2); assert.equal(sends.length, 2);
        expectTransport(sends[0].options, 'events'); expectTransport(sends[1].options, 'membership');
        assert.equal(sends[0].message.from, '"ACTIV Events" <events@activ.org.in>');
        assert.equal(sends[1].message.from, '"ACTIV Membership" <member@activ.org.in>');
        assert.equal(sends[0].message.replyTo, 'events@activ.org.in');
        assert.equal(sends[1].message.replyTo, 'member@activ.org.in');
        assert(sends.every(send => send.options.host !== baseEnv.EMAIL_HOST));
        await email.sendEmail({ ...message, category: 'events' });
        await email.sendEmail({ ...message, category: 'membership' });
        assert.equal(transports.length, 2, 'Each mailbox reuses only its own cached transport');
    });

    await test('separate port and TLS overrides are honored independently', async () => {
        const { email } = load({ ...separateEnv, EVENT_EMAIL_PORT: '587', EVENT_EMAIL_SECURE: 'false',
            MEMBER_EMAIL_PORT: '2525', MEMBER_EMAIL_SECURE: 'false' });
        await email.sendEmail({ ...message, category: 'events' });
        await email.sendEmail({ ...message, category: 'membership' });
        expectTransport(sends[0].options, 'events', { port: 587, secure: false });
        expectTransport(sends[1].options, 'membership', { port: 2525, secure: false });
    });

    await test('separate mailbox passwords preserve leading and trailing whitespace exactly', async () => {
        const eventPassword = '  event-password-with-spaces  ';
        const memberPassword = '\tmember-password-with-tabs\t';
        const { email } = load({ ...separateEnv, EVENT_EMAIL_PASS: eventPassword, MEMBER_EMAIL_PASS: memberPassword });
        await email.sendEmail({ ...message, category: 'events' });
        await email.sendEmail({ ...message, category: 'membership' });
        assert.equal(sends[0].options.auth.pass, eventPassword);
        assert.equal(sends[1].options.auth.pass, memberPassword);
    });

    await test('incomplete separate accounts cannot borrow legacy host, user or password', async () => {
        for (const [category, prefix] of [['events', 'EVENT_EMAIL'], ['membership', 'MEMBER_EMAIL']]) {
            for (const field of ['HOST', 'USER', 'PASS']) {
                const fixture = { ...separateEnv };
                delete fixture[`${prefix}_${field}`];
                const { accounts, email, mailer } = load(fixture);
                assert.equal(accounts.accountFor(category).isConfigured, false, `${prefix}_${field} required`);
                assert.equal(accounts.accountStatus(category).configured, false);
                const verification = await email.verifyConnection(category);
                assert.deepEqual(verification, { ok: false, configured: false,
                    error: `${prefix}_HOST / ${prefix}_USER / ${prefix}_PASS not set` });
                const result = await email.sendEmail({ ...message, category });
                assert.equal(result.mock, true, 'Unconfigured notification is explicitly marked as not sent');
                assert.equal(transports.length, 0); assert.equal(sends.length, 0);
                if (category === 'membership') {
                    const welcome = await mailer.send(message);
                    assert.equal(welcome.sent, false); assert.equal(welcome.skipped, true);
                    assert.equal(transports.length, 0); assert.equal(sends.length, 0);
                }
            }
        }
        const { email } = load({ EMAIL_PASS: '', EMAIL_PASSWORD: '' });
        for (const category of ['events', 'membership']) {
            const verification = await email.verifyConnection(category);
            assert.equal(verification.configured, false);
            assert.equal(verification.error, 'EMAIL_HOST / EMAIL_USER / EMAIL_PASS not set');
        }
        assert.equal(transports.length, 0); assert.equal(sends.length, 0);
    });

    await test('authentication failures never fall back to the legacy relay or the other mailbox', async () => {
        for (const category of ['events', 'membership']) {
            const { email } = load(separateEnv);
            rejectUser = category === 'events' ? separateEnv.EVENT_EMAIL_USER : separateEnv.MEMBER_EMAIL_USER;
            const result = await email.sendEmail({ ...message, category });
            assert.equal(result.success, false); assert(!result.mock);
            assert.match(result.error, /535/);
            assert.equal(transports.length, 1); assert.equal(sends.length, 1);
            expectTransport(sends[0].options, category);
        }
    });

    await test('the core mailer uses the separate member mailbox and preserves authentication failures', async () => {
        const { mailer } = load(separateEnv);
        const result = await mailer.send(message);
        assert.equal(result.sent, true); assert.equal(result.skipped, false);
        assert.equal(transports.length, 1); expectTransport(sends[0].options, 'membership');
        assert.equal(sends[0].message.from, 'ACTIV Membership <member@activ.org.in>');
        rejectUser = separateEnv.MEMBER_EMAIL_USER;
        const rejected = await mailer.send(message);
        assert.equal(rejected.sent, false); assert.match(rejected.error, /535/);
        assert.equal(transports.length, 1); assert.equal(sends.length, 2);
        expectTransport(sends[1].options, 'membership');
    });

    await test('public account status exposes neither login names nor passwords', async () => {
        const { accounts } = load(separateEnv);
        for (const category of ['events', 'membership']) {
            const status = accounts.accountStatus(category);
            assert.deepEqual(Object.keys(status).sort(), ['category', 'configured', 'from', 'host', 'port', 'secure', 'transport']);
            const serialized = JSON.stringify(status);
            for (const secret of [baseEnv.EMAIL_USER, baseEnv.EMAIL_PASS, separateEnv.EVENT_EMAIL_USER,
                separateEnv.EVENT_EMAIL_PASS, separateEnv.MEMBER_EMAIL_USER, separateEnv.MEMBER_EMAIL_PASS]) {
                assert(!serialized.includes(secret), 'Diagnostic output must not expose transport credentials');
            }
        }
    });
    console.log(`PASS ${checks} mailbox-routing regression groups. Fixtures only; no .env, network, database, or real messages.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
