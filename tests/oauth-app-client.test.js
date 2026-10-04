/**
 * The mobile app as an OAuth return address — `?client=app`.
 *
 * PURE UNIT, NO DB. Proves two things:
 *   1. the website path is untouched: no `client` means the same state claims
 *      and the same `${frontendUrl}/auth/social#…` redirects as before;
 *   2. the app path is allowlisted and rides in the SIGNED state, so neither a
 *      query string nor a forged state can choose where the browser is sent.
 *
 *   node tests/oauth-app-client.test.js
 */
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';

const jwt = require('jsonwebtoken');
const config = require('../src/config');
const oauth = require('../src/modules/auth/oauth.service');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

const WEBSITE = `${String(config.frontendUrl || '').replace(/\/+$/, '')}/auth/social`;
const fakeRes = () => ({ cookie() {}, clearCookie() {} });
const stateOf = (url) => new URL(url).searchParams.get('state');

(async() => {
    section('the allowlist');
    check('"app" is allowed', oauth.clientFrom('app') === 'app');
    check('case and spaces are forgiven', oauth.clientFrom(' APP ') === 'app');
    check('an unknown client is ignored', oauth.clientFrom('evil') === '');
    check('a URL is never a client', oauth.clientFrom('https://evil.example') === '');
    check('prototype keys are not clients', oauth.clientFrom('__proto__') === '' && oauth.clientFrom('constructor') === '');
    check('missing -> website', oauth.clientFrom(undefined) === '' && oauth.clientFrom('') === '');

    section('start: the website state is unchanged');
    {
        const url = oauth.startUrl('google', { query: {}, headers: {} }, fakeRes());
        const claims = jwt.verify(stateOf(url), config.jwt.secret);
        const keys = Object.keys(claims).filter((k) => k !== 'iat' && k !== 'exp').sort().join(',');
        check('no client -> claims are exactly n,p,t', keys === 'n,p,t', keys);
        const junk = oauth.startUrl('google', { query: { client: 'evil' }, headers: {} }, fakeRes());
        const junkClaims = jwt.verify(stateOf(junk), config.jwt.secret);
        check('unknown client -> no c claim', junkClaims.c === undefined);
    }

    section('start: the app state carries c=app');
    const appUrl = oauth.startUrl('google', { query: { client: 'app' }, headers: {} }, fakeRes());
    const appState = stateOf(appUrl);
    {
        const claims = jwt.verify(appState, config.jwt.secret);
        check('client=app -> c is "app"', claims.c === 'app');
        check('redirect_uri is the same server callback', new URL(appUrl).searchParams.get('redirect_uri').endsWith('/google/callback'));
    }

    section('callback: website default');
    {
        const webState = stateOf(oauth.startUrl('google', { query: {}, headers: {} }, fakeRes()));
        const cancelled = await oauth.handleCallback('google', { query: { error: 'access_denied', state: webState }, headers: {} }, fakeRes());
        check('cancelled -> website fragment', cancelled === `${WEBSITE}#error=cancelled&provider=google`, cancelled);
        const expired = await oauth.handleCallback('google', { query: { code: 'x', state: webState }, headers: {} }, fakeRes());
        check('missing cookie -> website expired', expired === `${WEBSITE}#error=expired&provider=google`, expired);
        const noState = await oauth.handleCallback('google', { query: { error: 'x' }, headers: {} }, fakeRes());
        check('no state -> website', noState === `${WEBSITE}#error=failed&provider=google`, noState);
        const unavailable = await oauth.handleCallback('nope', { query: {}, headers: {} }, fakeRes());
        check('unknown provider -> website unavailable', unavailable === `${WEBSITE}#error=unavailable`, unavailable);
        check('toClient("") is the website URL', oauth.toClient('', { code: 'abc', provider: 'google' }) === `${WEBSITE}#code=abc&provider=google`);
    }

    section('callback: the app');
    {
        const cancelled = await oauth.handleCallback('google', { query: { error: 'access_denied', state: appState }, headers: {} }, fakeRes());
        check('cancelled -> app deep link', cancelled === 'activ://auth/social?error=cancelled&provider=google', cancelled);
        const expired = await oauth.handleCallback('google', { query: { code: 'x', state: appState }, headers: {} }, fakeRes());
        check('missing cookie -> app expired', expired === 'activ://auth/social?error=expired&provider=google', expired);
        const unavailable = await oauth.handleCallback('nope', { query: { state: appState }, headers: {} }, fakeRes());
        check('unknown provider -> app unavailable', unavailable === 'activ://auth/social?error=unavailable', unavailable);
    }

    section('a forged state cannot pick the app');
    {
        const forged = jwt.sign({ n: 'x', p: 'google', t: 'oauth-state', c: 'app' }, 'not-the-secret');
        const out = await oauth.handleCallback('google', { query: { error: 'x', state: forged }, headers: {} }, fakeRes());
        check('forged -> website', out.startsWith(`${WEBSITE}#`), out);
        const handoff = jwt.sign({ t: 'oauth-handoff', c: 'app' }, config.jwt.secret);
        check('a non-state token names no client', oauth.clientFromState(handoff) === '');
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
