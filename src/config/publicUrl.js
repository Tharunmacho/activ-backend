const axios = require('axios');
const config = require('./index');
const logger = require('./logger');

/**
 * =========================================================================
 * THE ADDRESS THE OUTSIDE WORLD REACHES THIS API ON — VALIDATED
 * =========================================================================
 *
 * Instamojo's payment webhook and every media URL handed to Meta / Gmail are
 * fetched by somebody else's server, so they must name an address that
 * answers. They were built from BACKEND_URL, which on the live deployment is
 * `https://api.activ.org.in` — a host that does not resolve. The result:
 * no Instamojo webhook ever arrived (a paid booking confirmed only if the payer
 * came back to /payment-success), and the address was wrong in every place
 * that trusted it.
 *
 * Resolution, first match wins:
 *
 *   1. PUBLIC_API_URL — set explicitly, e.g. https://activ.org.in/api/v1.
 *      Trusted as given (probed only to WARN if it does not answer).
 *   2. BACKEND_URL + /api/v1, when it is a public host that ANSWERS /health.
 *   3. FRONTEND_URL's origin + /api/v1, when THAT answers — the live site
 *      serves the API under /api/v1 on its own origin.
 *   4. BACKEND_URL + /api/v1 as configured — local development, where nothing
 *      outside can reach it anyway and nothing is probed.
 *
 * Until the boot-time probe finishes, the first plausible candidate is used.
 * The probe is ONE GET per candidate, 5 s timeout, at boot and every 6 hours.
 */

const strip = (u) => String(u || '').trim().replace(/\/+$/, '');
/** A host nobody outside this machine can reach, or the retired sslip.io deployment. */
const isPrivate = (u) => /\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|\[::1\])|\.local\b|\.sslip\.io/i.test(String(u || ''));
const originOf = (u) => {
    try { return new URL(String(u)).origin; } catch { return ''; }
};

const apiPath = () => `/api/${config.apiVersion || 'v1'}`;

let resolved = '';

/** Every candidate API base, in the order above, de-duplicated. */
const candidates = () => {
    const list = [];
    const explicit = strip(process.env.PUBLIC_API_URL);
    const backend = strip(config.backendUrl || process.env.BACKEND_URL);
    const frontend = originOf(config.frontendUrl || process.env.FRONTEND_URL);
    if (explicit) list.push(explicit);
    if (backend && !isPrivate(backend)) list.push(`${backend}${apiPath()}`);
    if (frontend && !isPrivate(frontend)) list.push(`${frontend}${apiPath()}`);
    if (backend) list.push(`${backend}${apiPath()}`);
    return [...new Set(list)];
};

/** The public API base, e.g. `https://activ.org.in/api/v1`. Synchronous. */
const publicApiBase = () => {
    const explicit = strip(process.env.PUBLIC_API_URL);
    if (explicit) return explicit;
    if (resolved) return resolved;
    return candidates()[0] || `http://localhost:${config.port || 5000}${apiPath()}`;
};

/** The origin that base lives on — what `/uploads/...` media hangs off. */
const publicOrigin = () => originOf(publicApiBase()) || '';

/** True when nothing outside this machine could reach the public base. */
const isPublic = () => !isPrivate(publicApiBase());

/** Where Instamojo posts payment results. */
const instamojoWebhookUrl = () => `${publicApiBase()}/webhook/instamojo`;

const answers = async(base) => {
    try {
        const res = await axios.get(`${base}/health`, { timeout: 5000, validateStatus: () => true });
        return res.status >= 200 && res.status < 300;
    } catch {
        return false;
    }
};

/**
 * Probe the candidates and remember the first that answers. Never rejects.
 * Local development (every candidate private) is not probed at all.
 */
const validate = async() => {
    try {
        const explicit = strip(process.env.PUBLIC_API_URL);
        const list = candidates().filter((c) => !isPrivate(c));
        if (!list.length) return publicApiBase();

        if (explicit) {
            if (!(await answers(explicit))) {
                logger.warn('PUBLIC_API_URL does not answer /health — payment webhooks and media links will fail', { url: explicit });
            }
            return explicit;
        }

        for (const base of list) {
            if (await answers(base)) {
                if (resolved !== base) {
                    const backend = strip(config.backendUrl);
                    if (backend && !base.startsWith(backend)) {
                        logger.warn('BACKEND_URL does not answer; using this public API address for webhooks and media instead', {
                            backendUrl: backend, publicApiBase: base
                        });
                    } else {
                        logger.info('Public API address confirmed', { publicApiBase: base });
                    }
                }
                resolved = base;
                return base;
            }
        }
        logger.error('No public API address answers /health — set PUBLIC_API_URL. Instamojo webhooks will not arrive.', {
            tried: list
        });
    } catch (error) {
        logger.warn('Public API address check failed', { error: error && error.message });
    }
    return publicApiBase();
};

let timer = null;
/** Validate now and every 6 hours. Idempotent; `server.js` calls it once. */
const startValidation = () => {
    if (timer) return;
    validate();
    timer = setInterval(validate, 6 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
};

/** For tests: forget the probed answer. */
const _reset = () => { resolved = ''; };

module.exports = {
    publicApiBase, publicOrigin, instamojoWebhookUrl, isPublic, validate, startValidation, candidates, isPrivate, _reset
};
