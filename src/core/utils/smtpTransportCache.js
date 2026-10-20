const nodemailer = require('nodemailer');

/**
 * Cache only transports matching the current SMTP settings. Existing sends
 * keep their original transport until they settle: rotation never aborts or
 * retries a send whose acceptance by the mail server may be uncertain.
 */
const createSmtpTransportCache = () => {
    const entries = new Map();
    return (category, account) => {
        if (!account.isConfigured) {
            entries.delete(category);
            return null;
        }
        const key = JSON.stringify([account.host, account.port, account.secure, account.user, account.password]);
        const previous = entries.get(category);
        if (previous?.key === key) return previous.transport;

        // Drop a stale reference before creating its replacement. In particular,
        // a creation failure must not fall back to the old account.
        entries.delete(category);
        const transport = nodemailer.createTransport({
            host: account.host, port: account.port, secure: account.secure,
            auth: { user: account.user, pass: account.password },
            connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        });
        entries.set(category, { key, transport });
        return transport;
    };
};

module.exports = { createSmtpTransportCache };
