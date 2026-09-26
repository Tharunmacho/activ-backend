const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const express = require('express');
const logger = require('../../config/logger');
const objectStore = require('./objectStore');

/**
 * ============================================================================
 * UPLOADS LIVE IN THE DATABASE, NOT ONLY ON THE CONTAINER'S DISK
 * ============================================================================
 *
 * Every multer in this codebase writes to `backend/uploads/`. On the
 * deployed server that folder is inside the container, and a container is
 * rebuilt from the image on every deploy — so every deploy deleted every
 * banner, poster and photo anybody had uploaded. The rows still pointed at
 * `/uploads/cms-….png` and the server answered 404, which the site drew as
 * an empty grey frame. Re-uploading "fixed" it until the next deploy, which
 * is why it read as an image that would not save.
 *
 * So each uploaded file is ALSO written to a GridFS bucket in the same
 * MongoDB the rows live in, under the same filename. Serving stays as it
 * was — the disk copy first, because it is fastest — and falls back to the
 * database when the disk copy is gone. Nothing that stores or builds an
 * `/uploads/…` URL has to change, and no URL already stored changes shape.
 *
 * The disk is now a cache. The database is the record.
 *
 * ----------------------------------------------------------------------------
 * AND THE S3 BUCKET IS THE RECORD, WHEN ONE IS CONFIGURED
 * ----------------------------------------------------------------------------
 *
 * With `AWS_*` set (see `objectStore.js`) each upload goes to the bucket
 * instead of GridFS, keeping file bytes out of MongoDB. GridFS stays as the
 * fallback: a write the bucket refuses (no key, no permission, unreachable)
 * lands in GridFS exactly as before, so nothing is lost while the bucket is
 * misconfigured. Serving reads disk -> bucket -> GridFS, so files written
 * before the bucket existed keep working, and `syncToBucket` (run at boot and
 * by `scripts/migrate-uploads-to-s3.js`) copies them across.
 */

const BUCKET = 'uploads';
const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');

/** A bare filename, or '' for anything that tries to leave the folder. */
const safeName = (value) => {
    const name = path.basename(String(value || ''));
    return name && name !== '.' && name !== '..' ? name : '';
};

const bucket = () => {
    const db = mongoose.connection && mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) return null;
    return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
};

/** Every stored copy of `name` (normally one). */
const findFiles = async(store, name) => store.find({ filename: name }).toArray();

/**
 * Copy one file from disk into the bucket, replacing any earlier copy.
 * Resolves true on success; never throws.
 */
const persistFile = async(filePath, { contentType = '' } = {}) => {
    const name = safeName(filePath);
    if (name && objectStore.isEnabled()) {
        if (await objectStore.putFile(filePath, name, { contentType })) return true;
        logger.warn('S3 bucket refused an upload — keeping it in GridFS instead', { name });
    }
    return persistToGridFS(filePath, name, { contentType });
};

/** The pre-bucket path: copy one file from disk into GridFS. Never throws. */
const persistToGridFS = async(filePath, name, { contentType = '' } = {}) => {
    const store = bucket();
    if (!name || !store) return false;

    try {
        const earlier = await findFiles(store, name);

        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath)
                .on('error', reject)
                .pipe(store.openUploadStream(name, { metadata: { contentType } }))
                .on('error', reject)
                .on('finish', resolve);
        });

        // Only after the new copy is safely written.
        await Promise.all(earlier.map((f) => store.delete(f._id).catch(() => null)));
        return true;
    } catch (err) {
        logger.warn('Could not persist an upload to the database', { name, error: err && err.message });
        return false;
    }
};

/** Remove every stored copy of `name` — bucket and GridFS. Never throws. */
const removeFile = async(value) => {
    const name = safeName(value);
    if (name) await objectStore.removeObject(name);
    const store = bucket();
    if (!name || !store) return;
    try {
        const files = await findFiles(store, name);
        await Promise.all(files.map((f) => store.delete(f._id).catch(() => null)));
    } catch (err) {
        logger.warn('Could not remove an upload from the database', { name, error: err && err.message });
    }
};

/** The files multer attached to this request, whatever shape it used. */
const filesOf = (req) => {
    const out = [];
    if (req.file) out.push(req.file);
    if (Array.isArray(req.files)) out.push(...req.files);
    else if (req.files && typeof req.files === 'object') {
        Object.values(req.files).forEach((list) => { if (Array.isArray(list)) out.push(...list); });
    }
    return out.filter((f) => f && f.path);
};

/**
 * App-level middleware: once a request that carried uploads has succeeded,
 * copy those files into the database.
 *
 * App-level on purpose. There are four separate multers (CMS, business,
 * products, the shared one), and a hook in each is a hook somebody forgets
 * on the fifth. Every upload in the app passes through here. A failed
 * request's files are left alone — the row that would reference them was
 * never written.
 */
const persistUploadsMiddleware = (req, res, next) => {
    res.on('finish', () => {
        if (res.statusCode >= 400) return;
        const files = filesOf(req);
        files.forEach((f) => {
            persistFile(f.path, { contentType: f.mimetype || '' });
        });
    });
    next();
};

/** Write a readable stream to UPLOADS_DIR/name atomically. Best effort. */
const restoreDiskCopy = (readable, name) => {
    try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        const tmp = path.join(UPLOADS_DIR, `.${name}.${Date.now()}.tmp`);
        readable
            .on('error', () => fs.unlink(tmp, () => {}))
            .pipe(fs.createWriteStream(tmp))
            .on('finish', () => fs.rename(tmp, path.join(UPLOADS_DIR, name), () => {}))
            .on('error', () => fs.unlink(tmp, () => {}));
    } catch { /* the cache is an optimisation */ }
};

/**
 * `GET /uploads/:name` when the disk copy is missing: stream it from the
 * S3 bucket. A Range header is passed straight through to the bucket, so a
 * video banner can still seek.
 */
const serveFromBucket = async(req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!objectStore.isEnabled()) return next();

    const name = safeName(decodeURIComponent(req.path || ''));
    if (!name) return next();

    const range = /^bytes=\d*-\d*$/.test(String(req.headers.range || '')) ? String(req.headers.range) : '';
    const obj = await objectStore.getObject(name, range);
    if (!obj) return next();
    if (obj.unsatisfiable) return res.status(416).end();

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (obj.contentType) res.setHeader('Content-Type', obj.contentType);
    else res.type(path.extname(name) || 'application/octet-stream');
    if (range && obj.contentRange) {
        res.status(206);
        res.setHeader('Content-Range', obj.contentRange);
    }
    res.setHeader('Content-Length', String(obj.contentLength));

    if (req.method === 'HEAD' || !obj.body) {
        if (obj.body && typeof obj.body.destroy === 'function') obj.body.destroy();
        return res.end();
    }

    obj.body
        .on('error', () => { if (!res.headersSent) next(); else res.end(); })
        .pipe(res);

    // Restore the disk cache from a full read only — a partial one is not the file.
    if (!range) {
        objectStore.getObject(name).then((full) => {
            if (full && full.body) restoreDiskCopy(full.body, name);
        }).catch(() => {});
    }
    return undefined;
};

/**
 * `GET /uploads/:name` when neither disk nor bucket has it: stream it from the
 * database, and put it back on disk so the next request is served from there.
 *
 * Range requests are honoured, because a video banner that cannot seek does
 * not play at all in Safari.
 */
const serveFromDatabase = async(req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const name = safeName(decodeURIComponent(req.path || ''));
    const store = bucket();
    if (!name || !store) return next();

    let file;
    try {
        [file] = await store.find({ filename: name }).sort({ uploadDate: -1 }).limit(1).toArray();
    } catch {
        return next();
    }
    if (!file) return next();

    const size = Number(file.length || 0);
    const type = (file.metadata && file.metadata.contentType) || '';

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (type) res.setHeader('Content-Type', type);
    else res.type(path.extname(name) || 'application/octet-stream');

    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0;
    let end = size - 1;

    if (range && size) {
        start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
        end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
            res.setHeader('Content-Range', `bytes */${size}`);
            return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }

    res.setHeader('Content-Length', String(size ? end - start + 1 : 0));
    if (req.method === 'HEAD' || !size) return res.end();

    store.openDownloadStream(file._id, { start, end: end + 1 })
        .on('error', () => { if (!res.headersSent) next(); else res.end(); })
        .pipe(res);

    // Restore the disk cache from a full read only — a partial one is not the file.
    if (!range) restoreDiskCopy(store.openDownloadStream(file._id), name);
    return undefined;
};

/** Read a whole GridFS file into memory. */
const readGridFile = (store, id) => new Promise((resolve, reject) => {
    const chunks = [];
    store.openDownloadStream(id)
        .on('data', (c) => chunks.push(c))
        .on('error', reject)
        .on('end', () => resolve(Buffer.concat(chunks)));
});

/**
 * Copy into the bucket every upload it does not hold yet — from the disk
 * folder and from GridFS. Idempotent: an object already in the bucket is
 * skipped. Stops before starting if the bucket cannot be written at all (no
 * permission), rather than logging one failure per file.
 *
 * `removeFromGridFS` deletes a GridFS copy once the bucket is confirmed to hold it.
 */
const syncToBucket = async({ fromDisk = true, fromGridFS = true, removeFromGridFS = false, dryRun = false } = {}) => {
    const result = { checked: 0, copied: 0, alreadyThere: 0, failed: 0, removedFromGridFS: 0, aborted: '' };
    if (!objectStore.isEnabled()) { result.aborted = 'bucket not configured'; return result; }

    const probe = await objectStore.probe();
    if (!probe.ok) { result.aborted = `bucket unusable: ${probe.reason}`; return result; }

    const seen = new Set();

    /** Resolves true when the bucket holds `name` afterwards. */
    const handle = async(name, copy) => {
        if (seen.has(name)) return (await objectStore.exists(name)) === true;
        seen.add(name);
        result.checked += 1;
        if ((await objectStore.exists(name)) === true) { result.alreadyThere += 1; return true; }
        if (dryRun) { result.copied += 1; return false; }
        if (await copy()) { result.copied += 1; return true; }
        result.failed += 1;
        return false;
    };

    if (fromDisk) {
        let names = [];
        try { names = await fs.promises.readdir(UPLOADS_DIR); } catch { names = []; }
        for (const name of names) {
            if (!safeName(name) || name.startsWith('.')) continue;
            const full = path.join(UPLOADS_DIR, name);
            try { if (!(await fs.promises.stat(full)).isFile()) continue; } catch { continue; }
            await handle(name, () => objectStore.putFile(full, name, {
                contentType: express.static.mime.lookup(name) || '',
            }));
        }
    }

    const store = fromGridFS ? bucket() : null;
    if (store) {
        const files = await store.find({}).sort({ uploadDate: -1 }).toArray();
        for (const f of files) {
            const name = safeName(f.filename);
            if (!name || name.startsWith('.')) continue;
            const held = await handle(name, async() => {
                try {
                    const buf = await readGridFile(store, f._id);
                    return objectStore.putBuffer(buf, name, {
                        contentType: (f.metadata && f.metadata.contentType) || '',
                    });
                } catch { return false; }
            });
            if (held && removeFromGridFS && !dryRun) {
                await store.delete(f._id).then(() => { result.removedFromGridFS += 1; }).catch(() => null);
            }
        }
    }
    return result;
};

module.exports = {
    BUCKET,
    UPLOADS_DIR,
    persistFile,
    removeFile,
    persistUploadsMiddleware,
    serveFromBucket,
    serveFromDatabase,
    syncToBucket,
};
