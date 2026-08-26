const fs = require('fs');
const path = require('path');
const logger = require('../../config/logger');

/**
 * Keep base64 images out of the database.
 *
 * `createProduct` and `updateProduct` accept an `imageUrl` in the request body,
 * which is the right thing when it holds a path. It was also being handed a
 * `data:image/png;base64,...` string by the website's product forms, and stored
 * verbatim: one product ended up 2.19 MB.
 *
 * That is not merely untidy. Every query returning that document had to pull the
 * whole 2.19 MB across the wire from the remote cluster — measured at ~7,000ms
 * against 141ms for the same query with the field projected out, while the
 * server itself reported 1ms of execution time. `GET /business-profiles/discover`
 * returns every company together with its catalog, so the Discover screen paid
 * that cost on every single search.
 *
 * The clients have been corrected to send multipart, but the body field stays
 * open to older builds and to the mobile app, so the conversion happens here:
 * an inline image is decoded, written to /uploads exactly as multer would have,
 * and replaced by its path. Nothing is rejected — a client sending base64 still
 * succeeds, it just does not get to put a megabyte in a document.
 */

const UPLOADS_DIR = path.join(__dirname, '../../../uploads');

const EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
};

/** True when a value is a `data:` URL rather than a path or ordinary URL. */
const isInlineImage = (value) => /^data:[^;,]+;base64,/i.test(String(value || ''));

/**
 * Write an inline image to /uploads and return its relative path.
 *
 * Returns the value untouched when it is not inline, and '' when it is inline
 * but cannot be decoded — a corrupt data URL should not become a corrupt file,
 * and it should certainly not be stored as a megabyte of text.
 */
const persistInlineImage = (value, prefix = 'upload') => {
    const raw = String(value || '');
    if (!isInlineImage(raw)) return raw;

    const match = /^data:([^;,]+);base64,(.*)$/is.exec(raw);
    if (!match) return '';

    try {
        const mime = String(match[1]).toLowerCase();
        const buffer = Buffer.from(match[2], 'base64');
        if (!buffer.length) return '';

        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

        // Same naming shape multer uses, so the two paths are indistinguishable
        // downstream.
        const ext = EXTENSIONS[mime] || '.jpg';
        const name = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, name), buffer);

        logger.info(`Converted an inline base64 image to ${name} (${(buffer.length / 1024).toFixed(1)} KB)`);
        return `/uploads/${name}`;
    } catch (error) {
        logger.error('Failed to persist an inline image:', error);
        return '';
    }
};

module.exports = { isInlineImage, persistInlineImage };
