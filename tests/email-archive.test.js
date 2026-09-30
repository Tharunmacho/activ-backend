/**
 * The office's copy of every outgoing email (config.email.archiveCopy).
 *   node tests/email-archive.test.js
 */
const assert = require('assert');
const path = require('path');

let passed = 0; let failed = 0;
const check = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const load = (env) => {
    for (const k of ['EMAIL_ARCHIVE_COPY', 'EMAIL_ARCHIVE_MODE']) delete process.env[k];
    Object.assign(process.env, env);
    for (const id of Object.keys(require.cache)) {
        if (id.includes(`${path.sep}src${path.sep}config`) || id.endsWith('archiveCopy.js')) delete require.cache[id];
    }
    return require('../src/core/utils/archiveCopy').archiveFields;
};

console.log('email archive copy');
check('defaults to a BCC to info@activ.org.in', () => {
    assert.deepStrictEqual(load({})('member@example.com'), { bcc: 'info@activ.org.in' });
});
check('EMAIL_ARCHIVE_MODE=cc makes it a visible CC', () => {
    assert.deepStrictEqual(load({ EMAIL_ARCHIVE_MODE: 'cc' })('member@example.com'), { cc: 'info@activ.org.in' });
});
check('no duplicate when the mail is already to the archive box', () => {
    assert.deepStrictEqual(load({})('Info@Activ.org.in'), {});
});
check('a custom archive address is honoured', () => {
    assert.deepStrictEqual(load({ EMAIL_ARCHIVE_COPY: 'records@activ.org.in' })('a@b.c'), { bcc: 'records@activ.org.in' });
});
check('EMAIL_ARCHIVE_COPY=off disables the copy', () => {
    assert.deepStrictEqual(load({ EMAIL_ARCHIVE_COPY: 'off' })('a@b.c'), {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
