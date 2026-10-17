const Auth = require('./auth.model');
const Identity = require('./oauthIdentity.model');

const PROVIDERS = ['google', 'facebook', 'linkedin'];
const hasPassword = auth => auth?.passwordLoginEnabled !== false
    && typeof auth?.password === 'string' && auth.password.length > 0;

function describe(auth, identities = []) {
    const linkedProviders = PROVIDERS.filter(provider => (Array.isArray(identities) ? identities : [])
        .some(identity => identity?.provider === provider));
    const enabled = hasPassword(auth);
    // Old OAuth registrations stored random hashes indistinguishable from real
    // passwords. Never remove one or waive its checks based on a provider link.
    const passwordStatus = !enabled ? 'not_set'
        : auth.passwordLoginEnabled == null && linkedProviders.length ? 'legacy_unknown' : 'set';
    return { hasPassword: enabled, linkedProviders, passwordStatus };
}

async function forMemberEmail(email) {
    const auth = await Auth.findOne({ email: String(email || '').trim().toLowerCase() })
        .select('_id passwordLoginEnabled +password').lean();
    const identities = auth ? await Identity.find({ authId: auth._id }).select('provider').lean() : [];
    return describe(auth, identities);
}

module.exports = { hasPassword, describe, forMemberEmail };
