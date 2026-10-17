const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
 *   - successful content writes under the API clear the whole cache in the
 *     same instant, so an editor's save shows on the next read — the CMS rule
 *     that "an admin saves a change and immediately reloads" still holds;
 *     device registrations and notification read receipts cannot change public
 *     pages and leave their cache intact;
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
const MAX_WAITERS = 100;
const WAIT_MS = 5000;
const store = new Map();
const inFlight = new Map();
let generation = 0;

/*
 * What the BROWSER may do with an answer. It was `max-age=15,
 * stale-while-revalidate=120`, which lets a browser show the page as it was
 * for over two minutes after a save — the reload an editor makes to check
 * their change is exactly the one that gets the stale copy. The server-side
 * cache above is where the speed comes from; the browser revalidates.
 */
const BROWSER_CACHE = 'no-cache';

const enabled = () => String(process.env.PUBLIC_CACHE || 'true').toLowerCase() !== 'false';

/*
 * ONE CLEAR FOR EVERY WORKER.
 *
 * pm2 runs this server in cluster mode (`instances: 'max'`), and `store` is per
 * process. A save cleared only the worker that took it; every other worker kept
 * answering with the page as it was for up to TTL_MS, so an editor who saved
 * and reloaded saw the change or did not depending on which worker answered —
 * "I changed it in the CMS and the website does not show it".
 *
 * So a clear also touches a stamp file every worker on this machine can see,
 * and a cached entry older than the stamp is a miss. A stat is microseconds;
 * the round trip it saves is 400 ms+. Checked on each read so even the first
 * request to another worker after a save sees the invalidation.
 */
const STAMP_FILE = path.join(os.tmpdir(), `activ-public-cache-${process.env.PORT || 5000}.stamp`);
let stampAt = 0;
const lastClear = () => {
    try { stampAt = fs.statSync(STAMP_FILE).mtimeMs; } catch { /* no clear yet */ }
    return stampAt;
};

/** Drop everything — a write happened — here and in every other worker. */
const clear = () => {
    generation += 1;
    store.clear();
    try {
        fs.writeFileSync(STAMP_FILE, String(Date.now()));
        lastClear();
    } catch { /* this worker is still cleared */ }
    // A request started before the save may still be reading the old document.
    // New readers must neither join it nor let it refill the cleared cache.
    const previous = [...inFlight.values()];
    inFlight.clear();
    for (const pending of previous) pending.finish();
};

const currentEntry = (key, stamp) => {
    const entry = store.get(key);
    return entry && entry.generation === generation && entry.stamp === stamp
        && Date.now() - entry.at < TTL_MS ? entry : null;
};

const sendHit = (res, entry) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Public-Cache', 'HIT');
    res.setHeader('Cache-Control', BROWSER_CACHE);
    res.vary('Authorization');
    return res.status(200).send(entry.body);
};

/** Read-through cache for one route group. Mount before the router. */
const publicCache = (req, res, next) => {
    if (!enabled() || req.method !== 'GET' || req.headers.authorization) return next();

    const key = req.originalUrl;
    const stamp = lastClear();
    // The warm-up asks for a fresh copy without removing the one being served.
    const hit = isWarmRequest(req) ? null : currentEntry(key, stamp);
    if (hit) return sendHit(res, hit);

    // Share one cold read per URL. A page opening in several tabs or a burst of
    // visitors after a CMS save should not queue identical MongoDB queries.
    const pending = inFlight.get(key);
    if (pending && pending.generation === generation && pending.stamp === stamp
        && pending.waiters.size < MAX_WAITERS) {
        const resume = () => {
            pending.waiters.delete(resume);
            res.removeListener('close', cancel);
            if (res.destroyed || res.writableEnded) return;
            const entry = currentEntry(key, lastClear());
            if (entry) return sendHit(res, entry);
            // Errors, non-JSON responses and slow/closed leaders fall through
            // to the route. Their response must never be shared or cached.
            return next();
        };
        const cancel = () => pending.waiters.delete(resume);
        pending.waiters.add(resume);
        res.once('close', cancel);
        return;
    }

    const startedGeneration = generation;
    let finish = () => {};
    if (inFlight.size < MAX_ENTRIES && (!pending || pending.generation !== generation || pending.stamp !== stamp)) {
        const entry = { generation, stamp, waiters: new Set(), finish: null };
        let timer;
        let settled = false;
        finish = entry.finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res.removeListener('close', finish);
            if (inFlight.get(key) === entry) inFlight.delete(key);
            const waiting = [...entry.waiters];
            entry.waiters.clear();
            for (const resume of waiting) resume();
        };
        inFlight.set(key, entry);
        // Do not make another caller inherit a stuck request's full timeout.
        timer = setTimeout(finish, WAIT_MS);
        if (timer.unref) timer.unref();
        res.once('close', finish);
    }

    // Capture the answer on its way out.
    const send = res.send.bind(res);
    res.send = (body) => {
        try {
            const type = String(res.getHeader('Content-Type') || '');
            if (res.statusCode === 200 && /json/.test(type)
                && startedGeneration === generation && stamp === lastClear()) {
                if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
                store.set(key, { at: Date.now(), generation, stamp,
                    body: typeof body === 'string' ? body : Buffer.from(body) });
                res.setHeader('X-Public-Cache', 'MISS');
                res.setHeader('Cache-Control', BROWSER_CACHE);
                res.vary('Authorization');
            }
        } catch { /* caching is an optimisation */ }
        finish();
        return send(body);
    };
    return next();
};

// Explicit exceptions only: these routes write device/delivery state, never
// CMS content, events, plans or regions. All other writes remain invalidating,
// including future routes, so adding a content editor cannot silently go stale.
const isDeliveryStateWrite = (req) => {
    const route = String(req.path || '').replace(/\/+$/, '').toLowerCase();
    if (req.method === 'POST' && route === '/public-notifications/installations') return true;
    if (['PUT', 'DELETE'].includes(req.method) && route === '/public-notifications/devices') return true;
    if (['POST', 'DELETE'].includes(req.method) && route === '/notifications/push/devices') return true;
    return req.method === 'PATCH' && (
        /^\/public-notifications\/[a-f0-9]{24}\/open$/.test(route)
        || /^\/notifications\/[a-f0-9]{24}\/(read|open)$/.test(route)
        || ['/notifications/read-all', '/notifications/update-preferences'].includes(route)
    );
};

/** App-level: a successful content write under the API empties the cache. */
const clearOnWrite = (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isDeliveryStateWrite(req)) {
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
