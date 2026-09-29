const http = require('http');
const crypto = require('crypto');
const logger = require('../../config/logger');

/**
 * A short-lived memory cache for the PUBLIC site's anonymous reads.
 *
 * WHY: every visitor's banner, header and event list was a fresh trip to the
 * Atlas cluster, and each round trip there costs 400–500 ms — measured in
 * production at ~1 s per read and 2–8 s for the events list. The same answer
 * was being computed for every visitor. Now it is computed about once a minute.
 *
 * SAFE BECAUSE:
 *   - only GETs WITHOUT an Authorization header are cached. A signed-in editor
 *     sees drafts on some of these routes (`optionalAuth`), and never gets a
 *     cached answer; nor does a member;
 *   - any successful write anywhere under the API clears the whole cache in the
 *     same instant, so an editor's save shows on the next read — the CMS rule
 *     that "an admin saves a change and immediately reloads" still holds;
 *   - only 200 JSON answers are kept.
 *
 * WARM: `warm()` re-reads the public pages' endpoints every 45 s, so a visitor
 * arriving after a quiet spell never pays for the cold read either.
 *
 * THE WARM-UP MUST BE GENTLE, and it once was not. It fired all its requests
 * AT ONCE, each forced past the cache, every 45 s — nineteen simultaneous
 * database reads that filled the connection pool, so a real page load arriving
 * in the same second queued behind them for 2–11 s. And because it called the
 * server over loopback, every warm-up request was counted by the per-IP rate
 * limiter as the SAME client: 19 × 20 per 15 min, until 127.0.0.1 — and in
 * development the developer's own browser — was answered 429.
 *
 * So now: one request at a time (a round is skipped if the last is still
 * running), and each carries WARM_TOKEN — random per process, never sent to a
 * client — which is the only thing that (a) bypasses the cache and (b) is
 * exempt from the rate limiter. A client sending the header name with any
 * other value gets neither.
 */
const WARM_TOKEN = crypto.randomBytes(24).toString('hex');
const WARM_HEADER = 'x-public-cache-refresh';

/** True only for this process's own warm-up requests. */
const isWarmRequest = (req) => {
    const given = String((req && req.headers && req.headers[WARM_HEADER]) || '');
    if (given.length !== WARM_TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(WARM_TOKEN));
};

const TTL_MS = Math.max(5, parseInt(process.env.PUBLIC_CACHE_SECONDS, 10) || 60) * 1000;
const MAX_ENTRIES = 500;
const store = new Map();

const enabled = () => String(process.env.PUBLIC_CACHE || 'true').toLowerCase() !== 'false';

/** Drop everything — a write happened. */
const clear = () => store.clear();

/** Read-through cache for one route group. Mount before the router. */
const publicCache = (req, res, next) => {
    if (!enabled() || req.method !== 'GET' || req.headers.authorization) return next();

    const key = req.originalUrl;
    // The warm-up asks for a fresh copy without removing the one being served.
    const hit = isWarmRequest(req) ? null : store.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Public-Cache', 'HIT');
        res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=120');
        res.setHeader('Vary', 'Authorization');
        return res.status(200).send(hit.body);
    }

    // Capture the answer on its way out.
    const send = res.send.bind(res);
    res.send = (body) => {
        try {
            const type = String(res.getHeader('Content-Type') || '');
            if (res.statusCode === 200 && /json/.test(type)) {
                if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
                store.set(key, { at: Date.now(), body: typeof body === 'string' ? body : Buffer.from(body) });
                res.setHeader('X-Public-Cache', 'MISS');
                res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=120');
                res.setHeader('Vary', 'Authorization');
            }
        } catch { /* caching is an optimisation */ }
        return send(body);
    };
    return next();
};

/** App-level: a successful write anywhere under the API empties the cache. */
const clearOnWrite = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        res.on('finish', () => { if (res.statusCode < 400) clear(); });
    }
    next();
};

/** The landing page's reads — kept warm so no visitor pays for a cold one. */
const HOT = [
    '/cms/site', '/cms/home', '/cms/events?scope=public', '/cms/gallery?home=true',
    '/cms/events-settings', '/cms/legal/links', '/cms/regions/map',
    // The other public pages' first reads — each was a 200–700 ms cold miss.
    '/cms/gallery', '/cms/gallery-settings', '/cms/about', '/cms/membership', '/cms/contact-info',
    '/cms/news', '/cms/news/schemes', '/cms/schemes', '/membership/plans',
    '/regions/states', '/regions/tree', '/regions/tree?include=all'
];

let warmTimer = null;
let warming = false;

/** One warm-up GET; resolves when it has answered (or failed), never rejects. */
const warmOne = (port, fullPath) => new Promise((resolve) => {
    const req = http.get({
        host: '127.0.0.1', port, path: fullPath, timeout: 20000,
        headers: { [WARM_HEADER]: WARM_TOKEN }
    }, (r) => { r.resume(); r.on('end', resolve); r.on('error', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
});

const warm = (port, apiPrefix) => {
    if (warmTimer || !enabled()) return;
    const tick = async () => {
        if (warming) return;          // the previous round is still going: skip, never pile up
        warming = true;
        try {
            for (const path of HOT) {
                // Sequential, with a breath between: at most ONE warm-up read
                // is ever in flight, so it cannot crowd out a real visitor.
                await warmOne(port, `${apiPrefix}${path}`);
                await new Promise((r) => setTimeout(r, 150));
            }
        } finally {
            warming = false;
        }
    };
    warmTimer = setInterval(tick, 45 * 1000);
    if (warmTimer.unref) warmTimer.unref();
    const first = setTimeout(tick, 5000);
    if (first.unref) first.unref();
    logger.info('Public read cache warming', { every: '45s', endpoints: HOT.length });
};

module.exports = { publicCache, clearOnWrite, clear, warm, isWarmRequest, TTL_MS };
