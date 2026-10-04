const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const logger = require('../../config/logger');
const ApiError = require('../../core/utils/ApiError');
const cacheClient = require('../../core/cache/cacheClient');
const MemberAuth = require('./auth.model');
const adminRepository = require('../admin/admin.repository');

/**
 * ============================================================================
 * SIGN IN WITH GOOGLE, FACEBOOK OR LINKEDIN — members only
 * ============================================================================
 *
 * The ordinary OAuth "authorization code" redirect, run entirely by the
 * server, so the client secret never reaches a browser and the three providers
 * share one path:
 *
 *   GET  /auth/oauth/:provider/start      -> redirect to the provider
 *   GET  /auth/oauth/:provider/callback   <- the provider sends the person back
 *                                         -> redirect to the website with a
 *                                            60-second, single-use hand-off code
 *   POST /auth/oauth/exchange { code }    -> the normal sign-in response
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. A provider proves the person controls
 * an email address. That is exactly what the password reset proves too, so it
 * is allowed to open the MEMBER account registered with that address — and
 * nothing else:
 *
 *   - no account with that email -> sent to registration, prefilled; nothing
 *     is created behind their back (registration asks for the region, phone
 *     and a password the association needs).
 *   - an ADMIN account -> refused. Admins sign in with their password on the
 *     admin screen; a Facebook login must never become a way into an admin
 *     portal.
 *   - an address the provider has not verified -> refused.
 *
 * CSRF: the `state` is a signed token carrying a nonce that must match a
 * cookie set on /start, so a callback URL crafted by somebody else cannot
 * sign the victim's browser into the attacker's account.
 *
 * Each provider is on only when its keys are set; `/auth/oauth/providers`
 * tells the website which buttons to show.
 */

const env = (name) => String(process.env[name] || '').trim();
const facebookVersion = () => /^v\d+\.\d+$/.test(env('FACEBOOK_GRAPH_VERSION')) ? env('FACEBOOK_GRAPH_VERSION') : 'v26.0';
const accessToken = (response) => {
    const token = response && response.data && response.data.access_token;
    if (typeof token !== 'string' || !token.trim()) throw new Error('The provider did not return an access token.');
    return token;
};

const PROVIDERS = {
    google: {
        label: 'Google',
        clientId: () => env('GOOGLE_CLIENT_ID'),
        clientSecret: () => env('GOOGLE_CLIENT_SECRET'),
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        scope: 'openid email profile',
        extraParams: { prompt: 'select_account' },
        async profile(code, redirectUri) {
            const token = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
                code,
                client_id: this.clientId(),
                client_secret: this.clientSecret(),
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
            const info = await axios.get('https://openidconnect.googleapis.com/v1/userinfo', {
                headers: { Authorization: `Bearer ${accessToken(token)}` }, timeout: 15000
            });
            return { email: info.data.email, verified: info.data.email_verified === true, name: info.data.name };
        }
    },
    facebook: {
        label: 'Facebook',
        clientId: () => env('FACEBOOK_APP_ID'),
        clientSecret: () => env('FACEBOOK_APP_SECRET'),
        get authorizeUrl() { return `https://www.facebook.com/${facebookVersion()}/dialog/oauth`; },
        scope: 'email,public_profile',
        extraParams: {},
        async profile(code, redirectUri) {
            const token = await axios.get(`https://graph.facebook.com/${facebookVersion()}/oauth/access_token`, {
                params: {
                    code,
                    client_id: this.clientId(),
                    client_secret: this.clientSecret(),
                    redirect_uri: redirectUri
                },
                timeout: 15000
            });
            const bearer = accessToken(token);
            const proof = crypto.createHmac('sha256', this.clientSecret()).update(bearer).digest('hex');
            const info = await axios.get(`https://graph.facebook.com/${facebookVersion()}/me`, {
                headers: { Authorization: `Bearer ${bearer}` },
                params: { fields: 'id,name,email', appsecret_proof: proof }, timeout: 15000
            });
            // Without the granted email permission there is no account to match.
            return { email: info.data.email, verified: !!info.data.email, name: info.data.name };
        }
    },
    linkedin: {
        label: 'LinkedIn',
        clientId: () => env('LINKEDIN_CLIENT_ID'),
        clientSecret: () => env('LINKEDIN_CLIENT_SECRET'),
        authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
        scope: 'openid profile email',
        extraParams: {},
        async profile(code, redirectUri) {
            const token = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', new URLSearchParams({
                code,
                client_id: this.clientId(),
                client_secret: this.clientSecret(),
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
            const info = await axios.get('https://api.linkedin.com/v2/userinfo', {
                headers: { Authorization: `Bearer ${accessToken(token)}` }, timeout: 15000
            });
            // LinkedIn makes email_verified optional. An absent claim cannot
            // prove ownership of an existing ACTIV member's login address.
            return { email: info.data.email, verified: info.data.email_verified === true, name: info.data.name };
        }
    }
};

const COOKIE = 'activ_oauth';
const STATE_TTL_S = 10 * 60;
const HANDOFF_TTL_S = 60;

const providerFor = (key) => Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null;
const isConfigured = (p) => !!(providerFor(p) && providerFor(p).clientId() && providerFor(p).clientSecret());

// Only fixed error categories reach clients/logs. Provider messages can carry
// credentials, request URLs or other private data, so never forward them.
const providerFailure = (raw) => {
    const code = typeof raw === 'object' && raw ? raw.code : raw;
    if (['invalid_client', 'unauthorized_client', 101, '101'].includes(code)) return 'configuration';
    if (['redirect_uri_mismatch', 'invalid_redirect_uri', 'redirect_uri_invalid'].includes(code)) return 'callback';
    if (['invalid_scope', 'unauthorized_scope_error', 'insufficient_scope', 10, '10', 200, '200'].includes(code)) return 'permissions';
    if (['access_denied', 'user_cancelled_login', 'user_cancelled_authorize'].includes(code)) return 'cancelled';
    return 'failed';
};

const redirectBase = () => (env('OAUTH_REDIRECT_BASE') || `${config.backendUrl}/api/v1/auth/oauth`).replace(/\/+$/, '');
const redirectUriFor = (provider) => `${redirectBase()}/${provider}/callback`;
const frontendCallback = () => `${String(config.frontendUrl || '').replace(/\/+$/, '')}/auth/social`;

const readCookie = (req, name) => {
    const raw = String((req.headers && req.headers.cookie) || '');
    const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
    try { return hit ? decodeURIComponent(hit.slice(name.length + 1)) : ''; } catch { return ''; }
};

const isHttps = (req) => req.secure || String(req.headers['x-forwarded-proto'] || '').startsWith('https');

/*
 * ============================================================================
 * THE MOBILE APP AS A SECOND RETURN ADDRESS — additive, opt-in, allowlisted
 * ============================================================================
 *
 * The website is, and stays, the default: with no `client` the start URL, the
 * state token and every callback redirect are exactly what they always were.
 *
 * `GET /oauth/:provider/start?client=app` names the ACTIV mobile app instead.
 * The choice rides inside the SIGNED state token (`c`), so the callback reads
 * it from something the server itself issued — a crafted callback cannot pick
 * the destination, and the destinations are a fixed allowlist, never a URL a
 * request supplies. The app receives the same hand-off fields in a QUERY string
 * (a custom scheme reaches no server, so the fragment's reason does not apply,
 * and a query string survives every Android/iOS deep-link path intact).
 */
const CLIENT_TARGETS = {
    app: () => (env('OAUTH_APP_REDIRECT') || 'activ://auth/social')
};

/** An allowlisted client key, or '' for the website default. */
const clientFrom = (value) => {
    const key = String(value || '').toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(CLIENT_TARGETS, key) ? key : '';
};

/** The client named inside a state token this server signed; '' when none/invalid. */
const clientFromState = (state) => {
    if (!state) return '';
    try {
        const claims = jwt.verify(String(state), config.jwt.secret);
        return claims && claims.t === 'oauth-state' ? clientFrom(claims.c) : '';
    } catch (e) {
        return '';
    }
};

/** Where an allowlisted client is sent; the website when `client` is ''. */
const toClient = (client, fields) => (client
    ? `${CLIENT_TARGETS[client]()}?${new URLSearchParams(fields).toString()}`
    : toFrontend(fields));

/** Which providers the website should offer. */
const listProviders = () => Object.keys(PROVIDERS)
    .map((key) => ({ key, label: PROVIDERS[key].label, enabled: isConfigured(key) }));

/** Where to send the browser to start. Sets the CSRF cookie on `res`. */
const startUrl = (provider, req, res) => {
    const p = providerFor(provider);
    if (!p) throw ApiError.notFound('Unknown sign-in provider');
    if (!isConfigured(provider)) throw ApiError.badRequest(`${p.label} sign-in is not set up yet.`);

    const nonce = crypto.randomBytes(16).toString('hex');
    // `c` is added only for an allowlisted client, so the website's state token
    // carries exactly the claims it always did.
    const client = clientFrom(req && req.query && req.query.client);
    const claims = client
        ? { n: nonce, p: provider, t: 'oauth-state', c: client }
        : { n: nonce, p: provider, t: 'oauth-state' };
    const state = jwt.sign(claims, config.jwt.secret, { expiresIn: STATE_TTL_S });

    res.cookie(COOKIE, nonce, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isHttps(req),
        maxAge: STATE_TTL_S * 1000,
        path: '/'
    });

    const params = new URLSearchParams({
        client_id: p.clientId(),
        redirect_uri: redirectUriFor(provider),
        response_type: 'code',
        scope: p.scope,
        state,
        ...p.extraParams
    });
    return `${p.authorizeUrl}?${params.toString()}`;
};

/** Build the website URL the callback lands on. Everything rides in the FRAGMENT, which never reaches a server log. */
const toFrontend = (fields) => `${frontendCallback()}#${new URLSearchParams(fields).toString()}`;

/**
 * The provider has sent the person back. Returns the website URL to redirect to —
 * never throws, because an error page on the API host is a dead end for a person.
 */
const handleCallback = async(provider, req, res) => {
    const p = providerFor(provider);
    res.clearCookie(COOKIE, { path: '/' });
    // '' (the website) unless this server's own state token named the app.
    const client = clientFromState(req && req.query && req.query.state);
    const back = (fields) => toClient(client, fields);
    if (!p || !isConfigured(provider)) return back({ error: 'unavailable' });

    const { code, state, error } = req.query || {};
    if (error) return back({ error: providerFailure(error), provider });

    let claims = null;
    try {
        claims = jwt.verify(String(state || ''), config.jwt.secret);
    } catch (e) {
        claims = null;
    }
    const cookieNonce = readCookie(req, COOKIE);
    if (!claims || claims.t !== 'oauth-state' || claims.p !== provider || !cookieNonce || claims.n !== cookieNonce) {
        logger.warn('OAuth callback with a bad or missing state', { provider });
        return back({ error: 'expired', provider });
    }
    if (typeof code !== 'string' || !code) return back({ error: 'failed', provider });

    let who;
    try {
        who = await p.profile(String(code || ''), redirectUriFor(provider));
    } catch (err) {
        const reason = providerFailure(err.response?.data?.error);
        logger.warn('OAuth code exchange failed', { provider, status: err.response?.status, reason });
        return back({ error: reason, provider });
    }

    const email = String((who && who.email) || '').toLowerCase().trim();
    if (!email || !who.verified) return back({ error: 'no_email', provider });

    const member = await MemberAuth.findOne({ email }).select('_id isActive').lean().catch(() => null);
    if (!member) {
        const admin = await adminRepository.findRawByEmail(email).catch(() => null);
        if (admin) return back({ error: 'admin', provider });
        return back({ error: 'no_account', provider, email, name: String(who.name || '') });
    }

    const jti = crypto.randomBytes(12).toString('hex');
    const handoff = jwt.sign({ t: 'oauth-handoff', e: email, p: provider, jti }, config.jwt.secret, { expiresIn: HANDOFF_TTL_S });
    logger.info('Social sign-in verified', { provider, email });
    return back({ code: handoff, provider });
};

/** Trade the hand-off code for a normal member session. Single use. */
const exchange = async(code) => {
    let claims;
    try {
        claims = jwt.verify(String(code || ''), config.jwt.secret);
    } catch (e) {
        throw ApiError.unauthorized('That sign-in has expired. Please try again.');
    }
    if (!claims || claims.t !== 'oauth-handoff' || !claims.e || !claims.jti || !providerFor(claims.p)) {
        throw ApiError.unauthorized('That sign-in has expired. Please try again.');
    }

    const usedKey = `oauth:used:${claims.jti}`;
    if (!await cacheClient.claim(usedKey, 1, HANDOFF_TTL_S * 2)) {
        throw ApiError.unauthorized('That sign-in has already been used. Please try again.');
    }

    const authService = require('./auth.service');
    const member = await MemberAuth.findOne({ email: claims.e }).select('isActive').lean().catch(() => null);
    if (!member) throw ApiError.unauthorized('No ACTIV member account uses that email.');
    if (member.isActive === false) {
        throw ApiError.forbidden('Your account has been blocked by the organisation. '
            + 'Please contact the ACTIV administration if you believe this is a mistake.');
    }

    const session = await authService.memberSession(claims.e, 'member');
    if (!session) throw ApiError.unauthorized('No ACTIV member account uses that email.');
    return session;
};

module.exports = {
    listProviders, startUrl, handleCallback, exchange, isConfigured, PROVIDERS,
    clientFrom, clientFromState, toClient, providerFailure
};
