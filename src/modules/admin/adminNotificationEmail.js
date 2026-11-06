const ApiError = require('../../core/utils/ApiError');

const normalize = value => String(value || '').trim().toLowerCase();
const valid = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const SOURCES = new Set(['account', 'custom', 'provisioning_fallback']);

// Nationwide imports created sign-in aliases before their mailboxes existed.
// Keep their office fallback until an administrator configures an actual inbox.
// Older imports predate the source flag; recognise only their exact generated
// addresses, never an arbitrary account that intentionally uses the office.
function sourceFor(admin = {}) {
    if (SOURCES.has(admin.notificationEmailSource)) return admin.notificationEmailSource;
    const destination = normalize(admin.notificationEmail);
    if (!destination || destination === normalize(admin.email)) return 'account';
    if (destination === 'member@activ.org.in' && admin.createdVia === 'super_admin_ui') {
        try {
            const { emailFor, legacyEmailFor } = require('./nationalAdminPlan');
            if ([emailFor(admin), legacyEmailFor(admin)].includes(normalize(admin.email))) {
                return 'provisioning_fallback';
            }
        } catch (_) { /* An unknown/legacy region cannot prove import ownership. */ }
    }
    return 'custom';
}

function forWrite(existing = {}, payload = {}) {
    if (Object.prototype.hasOwnProperty.call(payload, 'notificationEmail')) {
        const notificationEmail = normalize(payload.notificationEmail);
        if (notificationEmail && !valid(notificationEmail)) {
            throw ApiError.badRequest('A valid notification email is required');
        }
        return {
            notificationEmail,
            notificationEmailSource: notificationEmail ? 'custom' : 'account'
        };
    }
    const previousEmail = normalize(existing.email);
    const nextEmail = payload.email === undefined ? previousEmail : normalize(payload.email);
    const source = sourceFor(existing);
    const followsAccount = source === 'account';
    if (followsAccount || (nextEmail !== previousEmail && source === 'provisioning_fallback')) {
        return { notificationEmail: '', notificationEmailSource: 'account' };
    }
    return { notificationEmail: normalize(existing.notificationEmail), notificationEmailSource: source };
}

function destinationFor(admin = {}, { allowAccountEmail = true } = {}) {
    const explicit = normalize(admin.notificationEmail);
    if (explicit) return valid(explicit) ? explicit : '';
    const email = allowAccountEmail ? normalize(admin.email) : '';
    return valid(email) ? email : '';
}

module.exports = { sourceFor, forWrite, destinationFor };
