const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const SMTP_KEYS = new Set([
    'EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_SECURE', 'EMAIL_USER', 'EMAIL_PASS', 'EMAIL_PASSWORD',
    ...['EVENT_EMAIL', 'MEMBER_EMAIL'].flatMap(prefix =>
        ['TRANSPORT', 'HOST', 'PORT', 'SECURE', 'USER', 'PASS'].map(field => `${prefix}_${field}`)),
]);

/**
 * A container's environment is supplied at startup. EMAIL_CONFIG_FILE is an
 * explicit alternative for deployments that mount a file for live rotation.
 * The file owns all SMTP settings; missing values never borrow stale process
 * credentials. Other application settings are neither read nor overwritten.
 */
const readSmtpSettings = () => {
    const configuredFile = String(process.env.EMAIL_CONFIG_FILE || '').trim();
    if (!configuredFile) {
        return { valid: true, values: Object.fromEntries(
            [...SMTP_KEYS].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])
        ) };
    }

    try {
        const source = fs.readFileSync(path.resolve(BACKEND_ROOT, configuredFile), 'utf8');
        if (source.length > 1024 * 1024) return { valid: false, values: {} };
        const values = {};
        for (const line of source.split(/\r?\n/)) {
            const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
            if (!SMTP_KEYS.has(key)) continue;
            // SMTP values must be single-line dotenv assignments. Reject
            // duplicates so editing one password cannot leave another active.
            const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
            if (!assignment || Object.hasOwn(values, key)) return { valid: false, values: {} };
            const raw = assignment[1];
            if (/^['"`]/.test(raw)) {
                const quote = raw[0];
                const end = raw.lastIndexOf(quote);
                if (end === 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) {
                    return { valid: false, values: {} };
                }
            }
            const parsed = dotenv.parse(line);
            if (!Object.hasOwn(parsed, key) || /[\r\n\0]/.test(parsed[key])) return { valid: false, values: {} };
            values[key] = parsed[key];
        }
        // Explicit selectors prevent a partly replaced file from silently
        // switching a previously separate mailbox to the shared relay.
        if (!['shared', 'separate'].includes(values.EVENT_EMAIL_TRANSPORT)
            || !['shared', 'separate'].includes(values.MEMBER_EMAIL_TRANSPORT)) {
            return { valid: false, values: {} };
        }
        return { valid: true, values };
    } catch {
        // Never retain the last password if the configured file disappears or
        // cannot be read. The next successful read can recover automatically.
        return { valid: false, values: {} };
    }
};

module.exports = { readSmtpSettings };
