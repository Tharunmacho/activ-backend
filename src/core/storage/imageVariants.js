const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

/**
 * `GET /uploads/<name>?w=800` — the same picture, resized and compressed.
 *
 * WHY: every banner slide, poster and card downloaded the ORIGINAL upload —
 * 200–350 KB PNGs and JPEGs straight off an editor's camera or Canva export —
 * to be painted 390px wide on a phone. The website already asks for a width
 * (`CmsMediaFrame` / `sizedMediaUrl` add `?w=`), and nothing answered it.
 *
 * WHAT: a WebP (JPEG for a browser that does not accept WebP) no wider than the
 * width asked for, never enlarged, EXIF-rotated. Made once and kept on disk
 * beside the uploads (`.variants/`), so every later request is a file read.
 * Upload names are unique (`cms-<timestamp>-<random>`) and never reused for
 * other content, so a variant is cacheable for a year.
 *
 * The width is SNAPPED to a short ladder, so a caller asking for 901px cannot
 * make the server write a thousand near-identical files.
 *
 * NEVER BREAKS AN IMAGE. No `?w`, not an image, `sharp` missing on the host,
 * an unreadable file — every one of those falls through to the original, served
 * exactly as before.
 */

let sharp = null;
try {
    // eslint-disable-next-line global-require
    sharp = require('sharp');
    sharp.cache(false);
} catch (error) {
    logger.warn('sharp is not available; uploads are served at full size', { error: error && error.message });
}

const LADDER = [320, 480, 640, 800, 1024, 1280, 1600, 1920];
const RESIZABLE = /\.(jpe?g|png|webp)$/i;

const snap = (value) => {
    const w = parseInt(value, 10);
    if (!Number.isFinite(w) || w <= 0) return 0;
    return LADDER.find((step) => step >= w) || LADDER[LADDER.length - 1];
};

/**
 * A file name, or a nested member-photo path (`members/<folder>/<file>`), or ''.
 * Every segment plain characters and never a dot-name — the same rule
 * `uploadStore.safeRel` applies, so nothing here can leave the folder.
 */
const cleanName = (value) => {
    const parts = String(value || '').split('/').filter(Boolean);
    if (!parts.length || parts.length > 4) return '';
    for (const p of parts) if (p.startsWith('.') || !/^[\w.-]+$/.test(p)) return '';
    return parts.join('/');
};

const streamToBuffer = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
});

/**
 * The original's bytes, wherever it lives: the disk folder, the S3 bucket, then
 * GridFS — the same order `app.js` serves originals in.
 */
const readOriginal = async(uploadsDir, name, store) => {
    try {
        return await fs.promises.readFile(path.join(uploadsDir, name));
    } catch { /* not on disk — try the stores */ }

    try {
        if (store.objectStore && store.objectStore.isEnabled()) {
            const obj = await store.objectStore.getObject(name);
            if (obj && obj.body) return await streamToBuffer(obj.body);
        }
    } catch { /* not in the bucket */ }

    try {
        const bucket = store.bucket && store.bucket();
        if (bucket) {
            const [file] = await bucket.find({ filename: name }).sort({ uploadDate: -1 }).limit(1).toArray();
            if (file) return await streamToBuffer(bucket.openDownloadStream(file._id));
        }
    } catch { /* not in GridFS */ }

    return null;
};

/** Requests already rendering a variant, so a burst of visitors renders it once. */
const rendering = new Map();

const makeVariantMiddleware = ({ uploadsDir, objectStore, bucket }) => async(req, res, next) => {
    if (!sharp || (req.method !== 'GET' && req.method !== 'HEAD')) return next();

    const width = snap(req.query && req.query.w);
    const name = cleanName(decodeURIComponent(req.path || ''));
    if (!width || !name || !RESIZABLE.test(name)) return next();

    const webp = /image\/webp/.test(String(req.headers.accept || ''));
    const ext = webp ? 'webp' : 'jpg';
    const dir = path.join(uploadsDir, '.variants');
    const file = path.join(dir, `${name.split('/').join('__')}.${width}.${ext}`);

    const send = (buffer) => {
        res.setHeader('Content-Type', webp ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Vary', 'Accept');
        res.setHeader('Content-Length', String(buffer.length));
        return req.method === 'HEAD' ? res.end() : res.end(buffer);
    };

    try {
        const cachedCopy = await fs.promises.readFile(file).catch(() => null);
        if (cachedCopy) return send(cachedCopy);

        let job = rendering.get(file);
        if (!job) {
            job = (async() => {
                const original = await readOriginal(uploadsDir, name, { objectStore, bucket });
                if (!original) return null;
                let pipeline = sharp(original, { failOn: 'none' }).rotate()
                    .resize({ width, withoutEnlargement: true });
                pipeline = webp ? pipeline.webp({ quality: 78, effort: 4 }) : pipeline.jpeg({ quality: 80, mozjpeg: true });
                const out = await pipeline.toBuffer();
                // Keep it for next time. A failed write only costs a re-render.
                fs.promises.mkdir(dir, { recursive: true })
                    .then(() => fs.promises.writeFile(file, out))
                    .catch(() => null);
                return out;
            })().finally(() => rendering.delete(file));
            rendering.set(file, job);
        }

        const buffer = await job;
        if (!buffer) return next();
        return send(buffer);
    } catch (error) {
        logger.warn('Image variant not produced; serving the original', { name, width, error: error && error.message });
        return next();
    }
};

module.exports = { makeVariantMiddleware, snap, LADDER };
