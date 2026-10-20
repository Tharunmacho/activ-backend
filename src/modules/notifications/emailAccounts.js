const config = require('../../config');
const { readSmtpSettings } = require('./emailRuntimeConfig');

const categoryForEvent = (event = '') => /^EVENT_/.test(event) ? 'events' : 'membership';
const prefixFor = (category, values) => {
    const prefix = category === 'events' ? 'EVENT_EMAIL' : 'MEMBER_EMAIL';
    return values[`${prefix}_TRANSPORT`] === 'separate' ? prefix : 'EMAIL';
};
const accountPrefix = (category = 'membership') => prefixFor(category, readSmtpSettings().values);
const accountFor = (category = 'membership') => {
    const base = config.email;
    const office = category === 'events' ? require('./eventContact') : require('./membershipContact');
    const { values, valid } = readSmtpSettings();
    const prefix = prefixFor(category, values);
    const separate = prefix !== 'EMAIL';
    const selector = values[`${category === 'events' ? 'EVENT_EMAIL' : 'MEMBER_EMAIL'}_TRANSPORT`];
    const validSelector = selector === undefined || selector === '' || ['shared', 'separate'].includes(selector);
    const real = value => {
        const text = String(value || '').trim();
        return /^(your[-_. ]|changeme|xxx|<|replace)|(_here|-here)$/i.test(text) ? '' : text;
    };
    // An explicitly separate mailbox never borrows the shared relay's host or
    // credentials. Missing or rejected credentials must not route back to Brevo.
    const user = real(values[`${prefix}_USER`]);
    const rawPassword = values[`${prefix}_PASS`] ?? (separate ? '' : values.EMAIL_PASSWORD);
    // Placeholder validation trims only for checking; real passwords are exact.
    const password = real(rawPassword) ? String(rawPassword) : '';
    const host = real(values[`${prefix}_HOST`]);
    const port = Number(values[`${prefix}_PORT`] || (separate ? 465 : 587));
    const secureValue = String(values[`${prefix}_SECURE`] || '').toLowerCase();
    const secure = secureValue ? secureValue === 'true' : port === 465;
    const validConnection = Number.isInteger(port) && port >= 1 && port <= 65535
        && ['', 'true', 'false'].includes(secureValue)
        && !/[\r\n\0]/.test(`${host}${user}${password}`);
    const configurationError = !valid
        ? 'EMAIL_CONFIG_FILE is unreadable or invalid. Use unique, single-line SMTP settings and explicit EVENT_EMAIL_TRANSPORT / MEMBER_EMAIL_TRANSPORT selectors.'
        : !validSelector ? 'Email transport must be shared or separate.'
            : !validConnection ? 'SMTP port, TLS setting, or credentials contain an invalid value.' : '';
    return {
        ...base, host, port, secure, user, password,
        defaultFrom: office.email, from: `${office.name} <${office.email}>`,
        fromName: office.name, supportAddress: office.email, useRegionalFrom: false,
        transport: separate ? 'separate' : 'shared',
        configurationError,
        isConfigured: !!(valid && validSelector && validConnection && host && user && password),
    };
};

// Only these public setup fields belong in admin diagnostics. SMTP passwords
// and login names are not sender identities and must not be copied with spread.
const accountStatus = (category) => {
    const account = accountFor(category);
    return {
        category,
        configured: !!account.isConfigured,
        host: account.host || null,
        port: account.port,
        secure: account.secure,
        from: account.defaultFrom,
        transport: account.transport,
        ...(account.configurationError ? { error: account.configurationError } : {}),
    };
};

module.exports = { accountFor, accountStatus, accountPrefix, categoryForEvent };
