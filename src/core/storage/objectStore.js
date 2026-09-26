const fs = require('fs');
const config = require('../../config');
const logger = require('../../config/logger');

/**
 * ============================================================================
 * THE UPLOAD BUCKET — S3-compatible object storage (Garage)
 * ============================================================================
 *
 * The durable home of every uploaded file. `uploadStore` writes here first and
 * falls back to GridFS only when this is unconfigured or refuses the write, so
 * a misconfigured bucket degrades to the old behaviour instead of losing files.
 *
 * Objects are keyed `<prefix>/<filename>` — the same filename the row stores
 * as `/uploads/<filename>`, so no stored URL changes shape and the server
 * keeps serving `/uploads/…` itself (the bucket need not be public).
 *
 * Garage needs `forcePathStyle`: it serves `endpoint/bucket/key`, not
 * `bucket.endpoint/key`.
 */

let client = null;
let sdk = null;

const cfg = () => config.objectStorage || {};

const isEnabled = () => !!cfg().isConfigured;

const keyFor = (name) => `${cfg().prefix || 'uploads'}/${name}`;

const s3 = () => {
    if (!isEnabled()) return null;
    if (client) return client;
    try {
        sdk = sdk || require('@aws-sdk/client-s3');
        const c = cfg();
        client = new sdk.S3Client({
            region: c.region || 'garage',
            endpoint: c.endpoint || undefined,
            forcePathStyle: true,
            credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
            maxAttempts: 3,
        });
        return client;
    } catch (err) {
        logger.warn('S3 client could not be created — uploads fall back to GridFS', { error: err && err.message });
        return null;
    }
};

const statusOf = (err) => (err && err.$metadata && err.$metadata.httpStatusCode) || 0;

const isNotFound = (err) => {
    const name = (err && (err.name || err.Code)) || '';
    return statusOf(err) === 404 || name === 'NoSuchKey' || name === 'NotFound';
};

/** Upload one file from disk. Resolves true on success; never throws. */
const putFile = async(filePath, name, { contentType = '' } = {}) => {
    const c = s3();
    if (!c || !name) return false;
    try {
        const body = await fs.promises.readFile(filePath);
        await c.send(new sdk.PutObjectCommand({
            Bucket: cfg().bucket,
            Key: keyFor(name),
            Body: body,
            ContentLength: body.length,
            ContentType: contentType || undefined,
        }));
        return true;
    } catch (err) {
        logger.warn('Could not store an upload in the S3 bucket', {
            name, status: statusOf(err), error: err && err.message,
        });
        return false;
    }
};

/** Upload a buffer (used when copying from GridFS). Resolves true on success. */
const putBuffer = async(buffer, name, { contentType = '' } = {}) => {
    const c = s3();
    if (!c || !name) return false;
    try {
        await c.send(new sdk.PutObjectCommand({
            Bucket: cfg().bucket,
            Key: keyFor(name),
            Body: buffer,
            ContentLength: buffer.length,
            ContentType: contentType || undefined,
        }));
        return true;
    } catch (err) {
        logger.warn('Could not store an upload in the S3 bucket', {
            name, status: statusOf(err), error: err && err.message,
        });
        return false;
    }
};

/**
 * True when the object exists, false when it does not, null when the bucket
 * could not answer (unconfigured, unreachable, forbidden).
 */
const exists = async(name) => {
    const c = s3();
    if (!c || !name) return null;
    try {
        await c.send(new sdk.HeadObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name) }));
        return true;
    } catch (err) {
        return isNotFound(err) ? false : null;
    }
};

/**
 * Fetch an object, optionally a byte range (`bytes=…`). Resolves
 * `{ body, contentType, contentLength, contentRange, totalSize }`, or null
 * when missing / unavailable. Never throws.
 */
const getObject = async(name, range) => {
    const c = s3();
    if (!c || !name) return null;
    try {
        const out = await c.send(new sdk.GetObjectCommand({
            Bucket: cfg().bucket,
            Key: keyFor(name),
            Range: range || undefined,
        }));
        const contentRange = out.ContentRange || '';
        const total = /\/(\d+)$/.exec(contentRange);
        return {
            body: out.Body,
            contentType: out.ContentType || '',
            contentLength: Number(out.ContentLength || 0),
            contentRange,
            totalSize: total ? Number(total[1]) : Number(out.ContentLength || 0),
        };
    } catch (err) {
        if (!isNotFound(err) && statusOf(err) !== 416) {
            logger.warn('Could not read an upload from the S3 bucket', {
                name, status: statusOf(err), error: err && err.message,
            });
        }
        if (statusOf(err) === 416) return { unsatisfiable: true };
        return null;
    }
};

/** Delete an object. Never throws. */
const removeObject = async(name) => {
    const c = s3();
    if (!c || !name) return;
    try {
        await c.send(new sdk.DeleteObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name) }));
    } catch (err) {
        if (!isNotFound(err)) {
            logger.warn('Could not remove an upload from the S3 bucket', {
                name, status: statusOf(err), error: err && err.message,
            });
        }
    }
};

/**
 * Write, read back and delete a probe object. Used at boot so a key with no
 * permission on the bucket is reported once, loudly, instead of as a warning
 * per upload.
 */
const probe = async() => {
    const c = s3();
    if (!c) return { ok: false, reason: 'not configured' };
    const name = `.probe-${Date.now()}`;
    try {
        await c.send(new sdk.PutObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name), Body: 'ok', ContentLength: 2 }));
        await c.send(new sdk.HeadObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name) }));
        await c.send(new sdk.DeleteObjectCommand({ Bucket: cfg().bucket, Key: keyFor(name) }));
        return { ok: true };
    } catch (err) {
        return { ok: false, status: statusOf(err), reason: (err && err.message) || 'unknown error' };
    }
};

module.exports = {
    isEnabled,
    keyFor,
    putFile,
    putBuffer,
    exists,
    getObject,
    removeObject,
    probe,
};
