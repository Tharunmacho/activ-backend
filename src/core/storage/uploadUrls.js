/**
 * ============================================================================
 * UPLOAD URLS ARE STORED RELATIVE — `/uploads/<file>` — AND NOTHING ELSE
 * ============================================================================
 *
 * Rows were saved with whatever address the uploading client happened to be
 * using: `http://localhost:5000/uploads/…` from a developer's machine,
 * `https://activ.org.in/uploads/…` from the site while the backend still ran
 * beside it. Each of those is right for exactly one network and wrong for
 * every other — and the second one broke in production the day the API moved
 * to its own host, because the site's address kept answering for OLD files
 * and 404'd for anything uploaded since. A picture uploaded yesterday blank,
 * one uploaded last month fine: that is what "images not loading" looked like.
 *
 * A relative path has no host to go stale. Every client re-anchors it to the
 * API it is actually talking to (`resolveMediaUrl` on web and mobile), so the
 * same row works from a phone on the release build, a browser on the live
 * site and a developer's laptop against the shared database.
 *
 * These helpers are pure. `cms.service` runs `relativizeUploadUrl` on every
 * media field it writes; `scripts/normalise-upload-urls.js` runs
 * `rewriteUploadUrls` over every document already stored.
 */

const UPLOAD_PATH = /^https?:\/\/[^/?#]+(\/uploads\/[^?#]+)([?#].*)?$/i;

/** `/uploads/<file>` for an upload URL on ANY host; any other value unchanged. */
const relativizeUploadUrl = (value) => {
    const url = String(value ?? '').trim();
    const match = UPLOAD_PATH.exec(url);
    // The query/fragment is dropped: an upload is one immutable file, and a
    // `?w=` a client appended at render time is not part of its identity.
    return match ? match[1] : url;
};

/** The stored file name of a `/uploads/…` value (relative or absolute), or ''. */
const uploadNameOf = (value) => {
    const rel = relativizeUploadUrl(value);
    if (!rel.startsWith('/uploads/')) return '';
    return rel.slice('/uploads/'.length).split(/[?#]/)[0];
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.prototype.toString.call(v) === '[object Object]';

/**
 * Walk one document (a plain object as the driver returns it) and find every
 * string that is an absolute upload URL.
 *
 * Returns `{ sets, names }`: `sets` is a `$set`-ready map of dotted paths to
 * their relative replacement (array indices as path segments, which Mongo
 * accepts), and `names` is every upload file the document references,
 * relative ones included — the second half of the migration checks each of
 * those is in the bucket.
 *
 * `_id`, Dates, ObjectIds and Buffers are not plain objects and are not
 * descended into; a `$set` on a path inside one would be meaningless anyway.
 */
const rewriteUploadUrls = (doc) => {
    const sets = {};
    const names = new Set();

    /*
     * `addressable` is false below a key that `$set` cannot name (one with a
     * dot or a leading dollar). The file is still COUNTED — the bucket must
     * hold it either way — but no rewrite is recorded, because the only path
     * that could be written would be the wrong one.
     */
    const visit = (value, path, addressable = true) => {
        if (typeof value === 'string') {
            const name = uploadNameOf(value);
            if (name) names.add(name);
            const rel = relativizeUploadUrl(value);
            if (addressable && path && rel !== value && rel.startsWith('/uploads/')) sets[path] = rel;
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, i) => visit(item, `${path}.${i}`, addressable));
            return;
        }
        if (isPlainObject(value)) {
            for (const [key, item] of Object.entries(value)) {
                if (key === '_id') continue;
                const ok = addressable && !key.includes('.') && !key.startsWith('$');
                visit(item, path ? `${path}.${key}` : key, ok);
            }
        }
    };

    visit(doc, '');
    return { sets, names };
};

module.exports = { relativizeUploadUrl, uploadNameOf, rewriteUploadUrls };
