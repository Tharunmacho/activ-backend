const path = require('path');
const config = require('../../config');
const logger = require('../../config/logger');
const objectStore = require('./objectStore');

/**
 * ============================================================================
 * THE LAST PLACE TO LOOK: THE SERVER THAT USED TO HOLD THE UPLOADS
 * ============================================================================
 *
 * Before the API had a host of its own it ran beside the website, and that
 * server still answers `https://activ.org.in/uploads/<file>` for every file
 * that was uploaded to it. Those files are on ITS disk — never on this
 * container, and not in the bucket unless something copied them.
 *
 * So when a request reaches the end of the chain — disk, bucket, GridFS — with
 * nothing found, the file is asked for from each legacy origin in turn. A hit
 * is streamed to the client AND written to the bucket, so the question is
 * asked exactly once per file; the old server can then be switched off with
 * nothing lost. A miss is a miss: the 404 is still a 404.
 *
 * `LEGACY_UPLOADS_ORIGINS` is a comma-separated list. It defaults to the one
 * retired address this codebase knows about; set it to `none` once the old
 * server is gone and every file has been recovered.
 *
 * A fetch carries `X-ACTIV-Legacy-Fetch: 1`, and a request arriving with that
 * header is never forwarded — so an origin accidentally pointed back at this
 * API (a proxy, a DNS change) cannot make it ask itself in a loop.
 */

const LOOP_HEADER = 'x-activ-legacy-fetch';
const TIMEOUT_MS = 20000;
/** Videos are uploaded here too; the biggest seen so far is a 25 MB photograph. */
const MAX_BYTES = 500 * 1024 * 1024;

const origins = () => (config.objectStorage.legacyOrigins || []);

const isEnabled = () => origins().length > 0;

/** Not HTML or JSON: the old server's 404 is a JSON envelope with status 404. */
const looksLikeFile = (contentType) => {
    const t = String(contentType || '').toLowerCase();
    return !!t && !t.startsWith('text/html') && !t.startsWith('application/json');
};

/**
 * Fetch `/uploads/<name>` from the first legacy origin that has it.
 * Resolves `{ buffer, contentType, origin }` or null. Never throws.
 */
const fetchLegacy = async(name) => {
    if (!name || !isEnabled()) return null;
    let axios;
    try { axios = require('axios'); } catch { return null; }

    for (const origin of origins()) {
        const url = `${origin}/uploads/${name.split('/').map(encodeURIComponent).join('/')}`;
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: TIMEOUT_MS,
                maxContentLength: MAX_BYTES,
                maxBodyLength: MAX_BYTES,
                maxRedirects: 2,
                validateStatus: () => true,
                headers: { [LOOP_HEADER]: '1', Accept: '*/*' },
            });
            const type = res.headers && res.headers['content-type'];
            if (res.status === 200 && res.data && res.data.length && looksLikeFile(type)) {
                return { buffer: Buffer.from(res.data), contentType: String(type || '').split(';')[0].trim(), origin };
            }
        } catch (err) {
            logger.warn('Legacy upload origin did not answer', { origin, name, error: err && err.message });
        }
    }
    return null;
};

/**
 * Make sure the bucket holds `name`, fetching it from a legacy origin when it
 * does not. Resolves `'already'`, `'recovered'`, `'missing'` or `'failed'`.
 */
const recoverToBucket = async(name, { persistBuffer } = {}) => {
    if (!name) return 'missing';
    if ((await objectStore.exists(name)) === true) return 'already';
    const got = await fetchLegacy(name);
    if (!got) return 'missing';
    const stored = persistBuffer
        ? await persistBuffer(got.buffer, name, { contentType: got.contentType })
        : await objectStore.putBuffer(got.buffer, name, { contentType: got.contentType });
    return stored ? 'recovered' : 'failed';
};

/**
 * `GET /uploads/:name` when disk, bucket and GridFS all came up empty.
 *
 * The whole file is sent (a Range header is answered with the full body and a
 * 200, which every browser accepts); from the next request on, the copy now in
 * the bucket serves ranges normally. `deps.persistBuffer` / `deps.restoreDiskCopy`
 * come from `uploadStore`, which requires this module — passed in rather than
 * required back, to keep the two from importing each other.
 */
const makeServeFromLegacy = ({ safeRel, persistBuffer, restoreDiskCopy, cacheControl }) => async(req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!isEnabled()) return next();
    if (req.headers[LOOP_HEADER]) return next();

    let name = '';
    try { name = safeRel(decodeURIComponent(req.path || '')); } catch { name = ''; }
    if (!name) return next();

    const got = await fetchLegacy(name);
    if (!got) return next();

    logger.info('Recovered an upload from a legacy origin', { name, origin: got.origin, bytes: got.buffer.length });

    // Durable first, then the disk cache; neither blocks the response.
    persistBuffer(got.buffer, name, { contentType: got.contentType }).catch(() => null);
    if (restoreDiskCopy) {
        try {
            const { Readable } = require('stream');
            restoreDiskCopy(Readable.from(got.buffer), name);
        } catch { /* the cache is an optimisation */ }
    }

    res.setHeader('Accept-Ranges', 'bytes');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    if (got.contentType) res.setHeader('Content-Type', got.contentType);
    else res.type(path.extname(name) || 'application/octet-stream');
    res.setHeader('Content-Length', String(got.buffer.length));
    if (req.method === 'HEAD') return res.end();
    return res.end(got.buffer);
};

module.exports = { isEnabled, origins, fetchLegacy, recoverToBucket, makeServeFromLegacy, LOOP_HEADER };
