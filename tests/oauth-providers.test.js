// Complete provider contracts with HTTP/model adapters; no external accounts or
// live member records are used by this test.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
Object.assign(process.env, {
    GOOGLE_CLIENT_ID: 'test-google-id', GOOGLE_CLIENT_SECRET: 'test-google-secret',
    FACEBOOK_APP_ID: 'test-facebook-id', FACEBOOK_APP_SECRET: 'test-facebook-secret',
    LINKEDIN_CLIENT_ID: 'test-linkedin-id', LINKEDIN_CLIENT_SECRET: 'test-linkedin-secret',
    FACEBOOK_GRAPH_VERSION: 'v26.0',
    OAUTH_REDIRECT_BASE: 'http://localhost:5057/api/v1/auth/oauth',
    OAUTH_APP_REDIRECT: 'activ://auth/social', FRONTEND_URL: 'http://localhost:8080',
    JWT_SECRET: 'isolated-provider-test-secret',
});
const axios = require('axios');
const oauth = require('../src/modules/auth/oauth.service');
const MemberAuth = require('../src/modules/auth/auth.model');
const auth = require('../src/modules/auth/auth.service');
const admins = require('../src/modules/admin/admin.repository');
let membershipStatus = 'active';
let member = { _id: 'isolated-member', isActive: true };
let admin = null;
let verified = true;
let email = 'MEMBER@example.com';
let tokenFailure = null;
let calls = [];
MemberAuth.findOne = () => ({ select: () => ({ lean: async () => member }) });
admins.findRawByEmail = async () => admin;
auth.memberSession = async loginEmail => ({ token: 'test-session', role: 'member', user: { email: loginEmail }, memberDetails: { membershipStatus } });
axios.post = async (url, body, options) => {
    calls.push({ url, body, options });
    if (tokenFailure) throw tokenFailure;
    return { data: { access_token: 'isolated-access-token' } };
};
axios.get = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/oauth/access_token')) {
        if (tokenFailure) throw tokenFailure;
        return { data: { access_token: 'isolated-access-token' } };
    }
    return { data: { email, email_verified: verified, name: 'Test Member' } };
};
const responseFields = target => new URLSearchParams(target.startsWith('activ:') ? new URL(target).search.slice(1) : new URL(target).hash.slice(1));
const begin = (provider, client = '') => {
    let nonce = '';
    const res = { cookie: (name, value, options) => {
        assert.equal(name, 'activ_oauth'); assert.equal(options.httpOnly, true); assert.equal(options.sameSite, 'lax');
        nonce = value;
    }, clearCookie() {} };
    const start = new URL(oauth.startUrl(provider, { query: { client }, headers: {} }, res));
    const callback = `http://localhost:5057/api/v1/auth/oauth/${provider}/callback`;
    assert.equal(start.searchParams.get('redirect_uri'), callback);
    assert.equal(start.searchParams.get('response_type'), 'code');
    assert(!start.toString().includes('test-' + provider + '-secret'));
    return { start, callback, res, req: { query: { code: 'provider-code', state: start.searchParams.get('state') }, headers: { cookie: `activ_oauth=${nonce}` } } };
};
const login = async (provider, client = '') => {
    const { req, res } = begin(provider, client);
    return oauth.handleCallback(provider, req, res);
};
(async () => {
    assert(oauth.listProviders().every(p => p.enabled));
    assert.equal(oauth.isConfigured('constructor'), false);
    assert.throws(() => begin('__proto__'), /Unknown sign-in/);
    for (const provider of ['google', 'facebook', 'linkedin']) {
        for (const client of ['', 'app']) {
            calls = [];
            const target = await login(provider, client);
            assert(target.startsWith(client ? 'activ://auth/social?' : 'http://localhost:8080/auth/social#'));
            const fields = responseFields(target);
            assert.equal(fields.get('provider'), provider);
            const session = await oauth.exchange(fields.get('code'));
            assert.equal(session.user.email, 'member@example.com');
            assert.equal(session.memberDetails.membershipStatus, 'active');
            assert.equal(calls.length, 2);
            if (provider === 'facebook') {
                assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/oauth/access_token');
                assert.equal(calls[0].options.params.redirect_uri, `http://localhost:5057/api/v1/auth/oauth/${provider}/callback`);
                assert.equal(calls[1].options.headers.Authorization, 'Bearer isolated-access-token');
                assert.equal(calls[1].options.params.appsecret_proof, crypto.createHmac('sha256', 'test-facebook-secret').update('isolated-access-token').digest('hex'));
                assert(!calls[1].options.params.access_token);
            } else {
                const posted = new URLSearchParams(calls[0].body);
                assert.equal(posted.get('grant_type'), 'authorization_code');
                assert.equal(posted.get('redirect_uri'), `http://localhost:5057/api/v1/auth/oauth/${provider}/callback`);
                assert.equal(posted.get('client_secret'), `test-${provider}-secret`);
                assert.equal(calls[1].options.headers.Authorization, 'Bearer isolated-access-token');
            }
        }
    }
    process.env.FACEBOOK_GRAPH_VERSION = 'v25.0';
    assert.equal(begin('facebook').start.pathname, '/v25.0/dialog/oauth');
    process.env.FACEBOOK_GRAPH_VERSION = 'v26.0';
    for (const provider of ['google', 'facebook', 'linkedin']) {
        membershipStatus = 'pending';
        assert.equal((await oauth.exchange(responseFields(await login(provider)).get('code'))).memberDetails.membershipStatus, 'pending');
        member = null;
        let fields = responseFields(await login(provider, 'app'));
        assert.equal(fields.get('error'), 'no_account');
        assert.equal(fields.get('email'), 'member@example.com');
        admin = { role: 'super_admin' };
        assert.equal(responseFields(await login(provider)).get('error'), 'admin');
        admin = null;
        member = { _id: 'isolated-member', isActive: false };
        await assert.rejects(oauth.exchange(responseFields(await login(provider)).get('code')), /blocked/);
        member.isActive = true;
        email = '';
        assert.equal(responseFields(await login(provider)).get('error'), 'no_email');
        email = 'MEMBER@example.com';
        const flow = begin(provider);
        flow.req.headers.cookie = 'activ_oauth=wrong-browser';
        calls = [];
        assert.equal(responseFields(await oauth.handleCallback(provider, flow.req, flow.res)).get('error'), 'expired');
        assert.equal(calls.length, 0);
    }
    for (verified of [undefined, false]) {
        assert.equal(responseFields(await login('linkedin')).get('error'), 'no_email');
        assert.equal(responseFields(await login('google')).get('error'), 'no_email');
    }
    verified = true;
    for (const [provider, raw, reason] of [
        ['google', 'invalid_client', 'configuration'],
        ['linkedin', 'unauthorized_scope_error', 'permissions'],
        ['facebook', { code: 101, message: 'PRIVATE_PROVIDER_DETAIL' }, 'configuration'],
        ['facebook', { code: 10, message: 'PRIVATE_PROVIDER_DETAIL' }, 'permissions'],
    ]) {
        tokenFailure = { response: { status: 400, data: { error: raw } } };
        const target = await login(provider, 'app');
        assert.equal(responseFields(target).get('error'), reason);
        assert(!target.includes('PRIVATE_PROVIDER_DETAIL'));
    }
    tokenFailure = null;
    const denied = begin('linkedin', 'app');
    denied.req.query.error = 'unauthorized_scope_error';
    assert.equal(responseFields(await oauth.handleCallback('linkedin', denied.req, denied.res)).get('error'), 'permissions');
    delete process.env.FACEBOOK_APP_SECRET;
    assert.equal(oauth.listProviders().find(p => p.key === 'facebook').enabled, false);
    assert.throws(() => begin('facebook'), /not set up/);
    console.log('OAuth provider contracts passed: all three providers on web/app; HTTP exchange, matching callbacks, active/pending sessions, registration, consent/errors, blocked accounts and missing permissions.');
    process.exit(0);
})().catch(error => { console.error(error.stack); process.exit(1); });
