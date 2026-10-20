// All SMTP calls are fixtures. Files contain only generated test credentials;
// dotenv.config is disabled before any application module is imported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config = () => ({ parsed: {} });
const nodemailer = require('nodemailer');
const loggerPath = require.resolve('../src/config/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true,
    exports: { info() {}, warn() {}, error() {}, debug() {} } };
process.env.NODE_ENV = 'test';
const baseline = { EMAIL_HOST: 'smtp.old.fixture.test', EMAIL_PORT: '587', EMAIL_SECURE: 'false',
    EMAIL_USER: 'old-user-fixture', EMAIL_PASS: 'old-password-fixture', EMAIL_ARCHIVE_COPY: 'off',
    EVENT_EMAIL_TRANSPORT: 'shared', MEMBER_EMAIL_TRANSPORT: 'shared' };
const modules = ['../src/config', '../src/modules/notifications/emailAccounts',
    '../src/modules/notifications/email.service', '../src/core/utils/mailer', '../src/core/utils/archiveCopy'];
let transports, sends, closed, behavior;
nodemailer.createTransport = options => {
    const snapshot = structuredClone(options);
    const transport = {
        async sendMail(message) {
            sends.push({ options: snapshot, message });
            if (behavior) return behavior(snapshot, message);
            return { messageId: `fixture-${sends.length}`, accepted: [message.to], rejected: [] };
        },
        async verify() { return true; },
        close() { closed++; },
    };
    transports.push({ options: snapshot, transport });
    return transport;
};
function load(overrides = {}) {
    for (const key of Object.keys(process.env)) if (/^(?:EMAIL_|EVENT_EMAIL_|MEMBER_EMAIL_)/.test(key)) delete process.env[key];
    Object.assign(process.env, baseline, overrides);
    for (const name of modules) delete require.cache[require.resolve(name)];
    transports = []; sends = []; closed = 0; behavior = null;
    return { accounts: require('../src/modules/notifications/emailAccounts'),
        email: require('../src/modules/notifications/email.service'), mailer: require('../src/core/utils/mailer') };
}
const message = { to: 'recipient@example.test', subject: 'Rotation fixture', text: 'No real message' };
const accepted = mail => ({ accepted: [mail.to], rejected: [], messageId: 'fixture-accepted' });
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'activ-smtp-rotation-'));
const settingsPath = path.join(temporary, 'smtp.env');
const sharedFile = (password = 'file-password-fixture') =>
    `EVENT_EMAIL_TRANSPORT=shared\nMEMBER_EMAIL_TRANSPORT=shared\nEMAIL_HOST=smtp.file.fixture.test\nEMAIL_USER=file-user-fixture\nEMAIL_PASS="${password}"\nEMAIL_PORT=587\nEMAIL_SECURE=false\n`;

async function main() {
    await test('shared SMTP rotates each changed connection field and reuses unchanged settings', async () => {
        const { email, mailer } = load();
        for (const send of [() => email.sendEmail({ ...message, category: 'events' }),
            () => email.sendEmail(message), () => mailer.send(message)]) {
            await send(); await send();
        }
        assert.equal(transports.length, 3, 'One cached transport per sender/category');
        const changes = { EMAIL_HOST: 'email-smtp.ap-south-1.fixture.test', EMAIL_PORT: '465',
            EMAIL_SECURE: 'true', EMAIL_USER: 'ses-smtp-user-fixture', EMAIL_PASS: '  SES password exact  ' };
        for (const [key, value] of Object.entries(changes)) {
            const before = transports.length;
            process.env[key] = value;
            await email.sendEmail({ ...message, category: 'events' });
            await email.sendEmail(message);
            await mailer.send(message);
            assert.equal(transports.length, before + 3, `${key} refreshes all sender caches`);
        }
        const latest = sends.at(-1).options;
        assert.equal(latest.host, changes.EMAIL_HOST); assert.equal(latest.port, 465); assert.equal(latest.secure, true);
        assert.equal(latest.auth.user, changes.EMAIL_USER); assert.equal(latest.auth.pass, changes.EMAIL_PASS);
        assert.equal(closed, 0);
    });

    await test('separate mailbox rotations stay isolated and switches to shared use current SES settings', async () => {
        const { email } = load({ EVENT_EMAIL_TRANSPORT: 'separate', MEMBER_EMAIL_TRANSPORT: 'separate',
            EVENT_EMAIL_HOST: 'events.fixture.test', EVENT_EMAIL_USER: 'event-user', EVENT_EMAIL_PASS: 'event-pass',
            MEMBER_EMAIL_HOST: 'members.fixture.test', MEMBER_EMAIL_USER: 'member-user', MEMBER_EMAIL_PASS: 'member-pass' });
        await email.sendEmail({ ...message, category: 'events' }); await email.sendEmail(message);
        process.env.MEMBER_EMAIL_USER = 'member-user-two'; process.env.MEMBER_EMAIL_PASS = 'member-pass-two';
        await email.sendEmail(message); await email.sendEmail({ ...message, category: 'events' });
        assert.equal(transports.length, 3);
        assert.equal(sends[2].options.auth.user, 'member-user-two');
        assert.equal(sends[3].options.auth.user, 'event-user');
        process.env.EVENT_EMAIL_TRANSPORT = 'shared'; process.env.MEMBER_EMAIL_TRANSPORT = 'shared';
        process.env.EMAIL_USER = 'new-ses-user'; process.env.EMAIL_PASS = 'new-ses-pass';
        await email.sendEmail({ ...message, category: 'events' }); await email.sendEmail(message);
        assert.equal(transports.length, 5);
        assert.equal(sends[4].options.auth.user, 'new-ses-user'); assert.equal(sends[5].options.auth.user, 'new-ses-user');
    });

    await test('missing or invalid updated settings disable old transports and can recover', async () => {
        const { email, mailer, accounts } = load();
        await email.sendEmail(message); await mailer.send(message);
        process.env.EMAIL_PASSWORD = 'stale-legacy-alias';
        for (const [key, value] of [['EMAIL_PASS', ''], ['EMAIL_HOST', ''], ['EMAIL_PORT', 'invalid'],
            ['EMAIL_SECURE', 'invalid'], ['MEMBER_EMAIL_TRANSPORT', 'seperete']]) {
            const original = process.env[key]; process.env[key] = value;
            const previous = sends.length;
            assert.equal(accounts.accountFor('membership').isConfigured, false);
            assert.equal((await email.sendEmail(message)).mock, true);
            assert.equal((await mailer.send(message)).sent, false);
            assert.equal(sends.length, previous, `${key} cannot send through a stale transport`);
            process.env[key] = original;
            assert.equal((await email.sendEmail(message)).success, true);
            assert.equal((await mailer.send(message)).sent, true);
        }
        delete process.env.EMAIL_PASS;
        assert.equal(accounts.accountFor('membership').password, 'stale-legacy-alias',
            'Legacy EMAIL_PASSWORD is used only when EMAIL_PASS is absent, not explicitly empty');
    });

    await test('rotation leaves an in-flight attempt intact and does not repeat it', async () => {
        const { email } = load();
        let release;
        behavior = (options, mail) => options.auth.user === baseline.EMAIL_USER
            ? new Promise(resolve => { release = () => resolve(accepted(mail)); })
            : accepted(mail);
        const oldSend = email.sendEmail(message);
        assert.equal(sends.length, 1);
        process.env.EMAIL_USER = 'rotated-user';
        const newSend = await email.sendEmail(message);
        assert.equal(newSend.success, true);
        assert.equal(sends.length, 2); assert.equal(closed, 0);
        release();
        assert.equal((await oldSend).success, true);
        assert.equal(sends.length, 2); assert.equal(closed, 0);
    });

    await test('failed authentication makes exactly one attempt and never falls back after rotation', async () => {
        const { email, mailer } = load();
        await email.sendEmail(message);
        process.env.EMAIL_USER = 'rejected-user';
        behavior = () => { throw new Error('535 Fixture authentication failed'); };
        const start = sends.length;
        assert.equal((await email.sendEmail(message)).success, false);
        assert.equal((await mailer.send(message)).sent, false);
        assert.equal(sends.length, start + 2);
        assert(sends.slice(start).every(send => send.options.auth.user === 'rejected-user'));
    });

    await test('explicit file rotation is authoritative, exact, and restricted to SMTP settings', async () => {
        fs.writeFileSync(settingsPath, sharedFile('  file password spaces  ') + 'JWT_SECRET=must-not-overwrite\n');
        const beforeSecret = process.env.JWT_SECRET;
        const { email, mailer, accounts } = load({ EMAIL_CONFIG_FILE: settingsPath });
        await email.sendEmail(message); await mailer.send(message);
        assert.equal(sends[0].options.auth.pass, '  file password spaces  ');
        assert.equal(process.env.EMAIL_USER, baseline.EMAIL_USER, 'File never mutates process.env');
        assert.equal(process.env.JWT_SECRET, beforeSecret);
        fs.writeFileSync(settingsPath, sharedFile('rotated-file-password'));
        await email.sendEmail(message); await mailer.send(message);
        assert.equal(sends[2].options.auth.pass, 'rotated-file-password');
        assert.equal(sends[3].options.auth.pass, 'rotated-file-password');
        assert.equal(transports.length, 4);
        fs.writeFileSync(settingsPath, sharedFile().replace('EMAIL_USER=file-user-fixture\n', ''));
        assert.equal(accounts.accountFor('membership').isConfigured, false);
        assert.equal((await email.sendEmail(message)).mock, true);
        assert.equal(sends.length, 4, 'Incomplete files never borrow process credentials');
    });

    await test('dotenv quoting preserves hashes, literal slashes, and surrounding password whitespace', async () => {
        const { email, accounts } = load({ EMAIL_CONFIG_FILE: settingsPath });
        const password = '  fixture#hash\\n\\r\\literal spaces  ';
        fs.writeFileSync(settingsPath, sharedFile().replace('EMAIL_PASS="file-password-fixture"',
            `EMAIL_PASS='${password}' # this is a comment`));
        await email.sendEmail(message);
        assert.equal(sends[0].options.auth.pass, password);
        assert.equal(accounts.accountStatus('membership').transport, 'shared');
        fs.writeFileSync(settingsPath, sharedFile().replace('EMAIL_PASS="file-password-fixture"',
            'EMAIL_PASS="fixture#hash" # another comment'));
        await email.sendEmail(message);
        assert.equal(sends[1].options.auth.pass, 'fixture#hash');
        assert.equal(transports.length, 2);
    });

    await test('invalid, duplicated, removed or partial files fail closed and recover without restart', async () => {
        const { email, accounts } = load({ EMAIL_CONFIG_FILE: settingsPath });
        fs.writeFileSync(settingsPath, sharedFile());
        await email.sendEmail(message);
        for (const broken of [sharedFile() + 'EMAIL_PASS=second-value\n',
            sharedFile().replace('EMAIL_PASS="file-password-fixture"', 'EMAIL_PASS="unclosed'),
            sharedFile().replace('EVENT_EMAIL_TRANSPORT=shared\n', ''), '',
            sharedFile().replace('EMAIL_PASS="file-password-fixture"', 'EMAIL_PASS="line\\nbreak"')]) {
            fs.writeFileSync(settingsPath, broken);
            const count = sends.length;
            assert.equal((await email.sendEmail(message)).mock, true); assert.equal(sends.length, count);
            assert.match((await email.verifyConnection('membership')).error, /EMAIL_CONFIG_FILE/);
            const diagnostic = JSON.stringify(accounts.accountStatus('membership'));
            assert.match(diagnostic, /EMAIL_CONFIG_FILE/);
            assert(!diagnostic.includes(settingsPath)); assert(!diagnostic.includes('file-password-fixture'));
            fs.writeFileSync(settingsPath, sharedFile());
            assert.equal((await email.sendEmail(message)).success, true);
        }
        fs.unlinkSync(settingsPath);
        const count = sends.length;
        assert.equal((await email.sendEmail(message)).mock, true); assert.equal(sends.length, count);
        fs.writeFileSync(settingsPath, sharedFile('recovered-password'));
        assert.equal((await email.sendEmail(message)).success, true);
        assert.equal(sends.at(-1).options.auth.pass, 'recovered-password');
    });

    await test('relative file paths resolve against the backend root and empty opt-in returns to current environment', async () => {
        const backendRoot = path.resolve(__dirname, '..');
        const { email } = load({ EMAIL_CONFIG_FILE: path.relative(backendRoot, settingsPath) });
        assert.equal((await email.sendEmail(message)).success, true);
        assert.equal(sends[0].options.host, 'smtp.file.fixture.test');
        process.env.EMAIL_CONFIG_FILE = '';
        await email.sendEmail(message);
        assert.equal(sends[1].options.host, baseline.EMAIL_HOST);
        assert.equal(sends.length, 2);
    });
    console.log(`PASS ${checks} credential-rotation regression groups. No network or real messages.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    // Only the exact test-generated paths are removed; no recursive deletion.
    if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    fs.rmdirSync(temporary);
});
