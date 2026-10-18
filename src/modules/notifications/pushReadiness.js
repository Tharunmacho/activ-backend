// Authentication readiness is separate from environment-variable presence and
// from Firebase accepting a device message. No message is sent by this check.
const AUTH_FAILURES = new Set(['app/invalid-credential', 'messaging/authentication-error', 'messaging/insufficient-permission']);
const safeCode = error => /^[a-z0-9_/-]{1,80}$/i.test(String(error?.code || ''))
    ? String(error.code) : 'push/invalid-configuration';
const loadCredential = env => {
    const { cert, applicationDefault } = require('firebase-admin/app');
    return env.FIREBASE_SERVICE_ACCOUNT_JSON ? cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault();
};
function createReadiness({ env = process.env, now = Date.now, credentialFactory = loadCredential, timeoutMs = 8000 } = {}) {
    let credentialValue, authentication, cachedUntil = 0, checking;
    let provider = { ready: null, errorCode: '', checkedAt: null };
    const configurationPresent = () => env.PUSH_ENABLED === 'true'
        && !!(env.FIREBASE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS);
    const credential = () => credentialValue || (credentialValue = credentialFactory(env));
    const snapshot = () => {
        const present = configurationPresent();
        const credentialReady = present && authentication?.ready === true;
        const configured = credentialReady && provider.ready !== false;
        const workerEnabled = env.NOTIFICATION_WORKER_ENABLED !== 'false';
        const errorCode = !present ? 'push/not-configured' : provider.ready === false ? provider.errorCode : authentication?.errorCode || '';
        const reason = !present ? 'Push delivery is not enabled on the server. Your device registration is saved.'
            : !credentialReady || provider.ready === false
                ? 'Push delivery is temporarily unavailable on the server. Your device registration is saved; contact ACTIV support if this continues.'
                : !workerEnabled ? 'The notification worker is disabled. Enable it before testing.' : '';
        return { configured, ready: configured && workerEnabled, configurationPresent: present, credentialReady,
            // null means only OAuth was checked; it never implies FCM delivery.
            providerReady: provider.ready, workerEnabled, reason, errorCode,
            checkedAt: authentication?.checkedAt || null, providerCheckedAt: provider.checkedAt };
    };
    async function check() {
        if (!configurationPresent()) return snapshot();
        if (authentication && cachedUntil > now()) return snapshot();
        if (checking) { await checking; return snapshot(); }
        checking = (async () => {
            let timeout;
            try {
                const token = await Promise.race([
                    Promise.resolve().then(() => credential().getAccessToken()),
                    new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error('Credential check timed out'),
                        { code: 'push/credential-check-timeout' })), timeoutMs); }),
                ]);
                if (!token?.access_token || !(Number(token.expires_in) > 0)) throw Object.assign(new Error('Missing usable OAuth token'), { code: 'push/invalid-access-token' });
                authentication = { ready: true, errorCode: '', checkedAt: new Date(now()).toISOString() };
                cachedUntil = now() + Math.min(300000, Math.max(0, Number(token.expires_in) * 1000 - 30000));
            } catch (error) {
                authentication = { ready: false, errorCode: safeCode(error), checkedAt: new Date(now()).toISOString() };
                cachedUntil = now() + 60000;
            } finally { clearTimeout(timeout); }
        })();
        try { await checking; } finally { checking = null; }
        return snapshot();
    }
    function recordProviderFailure(error) {
        const code = safeCode(error);
        // Invalid device/APNs credentials are not a server-wide OAuth failure.
        if (AUTH_FAILURES.has(code)) provider = { ready: false, errorCode: code, checkedAt: new Date(now()).toISOString() };
    }
    function recordProviderSuccess() { provider = { ready: true, errorCode: '', checkedAt: new Date(now()).toISOString() }; }
    return { check, credential, configurationPresent, recordProviderFailure, recordProviderSuccess };
}
module.exports = { ...createReadiness(), createReadiness };
