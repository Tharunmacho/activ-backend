const fs = require('fs').promises;
const path = require('path');
const logger = require('../../config/logger');

/**
 * Remove uploaded files that nothing points at any more.
 *
 * Deleting a gallery image used to remove the database row and leave the file
 * on disk forever. The obvious fix — unlink whatever URL the deleted row held —
 * is wrong, because one uploaded file can be referenced from several places at
 * once. An admin who uploads a logo, sets it as the site mark AND as the
 * overlay on the About photograph, then clears the overlay, would have the file
 * deleted out from under the header.
 *
 * So nothing is deleted on the strength of one document. A candidate URL is
 * checked against every reference in the CMS and in the events collection, and
 * removed only when the count reaches zero.
 *
 * Three further rules:
 *
 * 1. Only files under `/uploads` are ever touched. A remote URL is somebody
 *    else's file, and `/logo_ACTIVian-removebg-preview.png` belongs to the
 *    website's own static build.
 *
 * 2. The resolved path must sit inside the uploads directory. A stored value of
 *    `/uploads/../../src/server.js` would otherwise escape it, and content is
 *    editable by an admin — a compromised account should not be able to delete
 *    arbitrary files.
 *
 * 3. A failure here is logged, never thrown. An orphaned file wastes a few
 *    kilobytes; a delete that reports failure because cleanup could not run
 *    leaves the admin unsure whether the record went.
 */

const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');

/** The basename of a stored `/uploads/x.png`, or null for anything else. */
const uploadFilename = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const marker = raw.indexOf('/uploads/');
    if (marker === -1) return null;

    // Strip any query string; `?v=2` is not part of the filename.
    const name = raw.slice(marker + '/uploads/'.length).split('?')[0].split('#')[0];
    return name || null;
};

/** Walk any value and collect every `/uploads/` filename it mentions. */
const collect = (value, into) => {
    if (!value) return into;

    if (typeof value === 'string') {
        const name = uploadFilename(value);
        if (name) into.add(name);
        return into;
    }

    if (Array.isArray(value)) {
        value.forEach(v => collect(v, into));
        return into;
    }

    if (typeof value === 'object') {
        Object.values(value).forEach(v => collect(v, into));
        return into;
    }

    return into;
};

/**
 * Every upload filename referenced anywhere.
 *
 * Walks whole documents rather than named fields on purpose: media lives at a
 * dozen paths across seven schemas, and a list of them would fall out of date
 * the first time a field is added — silently, by deleting a file still in use.
 */
const referencedFilenames = async() => {
    const {
        SiteSettings, Home, About, GallerySettings, GalleryItem, ContactSettings,
    } = require('./cms.models');
    const Event = require('../events/event.model');

    const found = new Set();

    const sources = await Promise.all([
        SiteSettings.find({}).lean().catch(() => []),
        Home.find({}).lean().catch(() => []),
        About.find({}).lean().catch(() => []),
        GallerySettings.find({}).lean().catch(() => []),
        GalleryItem.find({}).lean().catch(() => []),
        ContactSettings.find({}).lean().catch(() => []),
        Event.find({}).select('bannerUrl').lean().catch(() => []),
    ]);

    sources.forEach(docs => collect(docs, found));
    return found;
};

/**
 * Delete the given media, but only what nothing else still points at.
 *
 * `candidates` is whatever the caller just removed or replaced — URLs, media
 * objects, arrays of either. Call it AFTER the write has landed, so the
 * reference scan sees the new state and does not count the row being deleted.
 *
 * Returns the filenames actually removed, which is what the callers log.
 */
const removeOrphans = async(candidates) => {
    try {
        const wanted = collect(candidates, new Set());
        if (!wanted.size) return [];

        const referenced = await referencedFilenames();
        const orphans = [...wanted].filter(name => !referenced.has(name));
        if (!orphans.length) return [];

        const removed = [];

        for (const name of orphans) {
            const target = path.resolve(UPLOADS_DIR, name);

            // Refuse anything that resolves outside the uploads directory.
            if (target !== path.join(UPLOADS_DIR, path.basename(target))) {
                logger.warn('Refused to delete a file outside uploads', { name });
                continue;
            }

            try {
                await fs.unlink(target);
                removed.push(name);
            } catch (err) {
                // ENOENT is the normal case for a URL that was never a local
                // upload, or a file already cleaned up. Not worth a warning.
                if (err.code !== 'ENOENT') {
                    logger.warn('Could not delete an orphaned upload', { name, error: err.message });
                }
            }
        }

        if (removed.length) logger.info('Removed orphaned uploads', { count: removed.length, files: removed });
        return removed;
    } catch (err) {
        // Never let cleanup fail the operation that triggered it.
        logger.warn('Upload cleanup failed', { error: err && err.message });
        return [];
    }
};

/**
 * Every upload on disk that nothing references.
 *
 * Used by the sweep script to catch files orphaned before this existed, and by
 * anyone wanting to know what would be reclaimed without deleting it.
 */
const findAllOrphans = async() => {
    const referenced = await referencedFilenames();

    let onDisk = [];
    try {
        onDisk = await fs.readdir(UPLOADS_DIR);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return { orphans: [], onDisk: 0, referenced: referenced.size };
    }

    const orphans = [];
    for (const name of onDisk) {
        if (referenced.has(name)) continue;
        try {
            const stat = await fs.stat(path.join(UPLOADS_DIR, name));
            if (stat.isFile()) orphans.push({ name, bytes: stat.size, modified: stat.mtime });
        } catch { /* vanished between readdir and stat */ }
    }

    return { orphans, onDisk: onDisk.length, referenced: referenced.size };
};

module.exports = { removeOrphans, findAllOrphans, referencedFilenames, UPLOADS_DIR };
