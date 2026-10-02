const path = require('path');
const crypto = require('crypto');
const { uploadNameOf } = require('../../core/storage/uploadUrls');
const { baseSlug } = require('./eventSlug');

// Keep the event slug as the actual filename. A content hash in the folder
// makes replacements immutable without changing any previously shared image.
const bannerName = (event, source, bytes) => {
    const ext = path.extname(source).toLowerCase();
    const slug = event.slug || baseSlug(event);
    if (!/^[a-z0-9-]+$/.test(slug) || !/^\.(png|jpe?g|webp|gif)$/.test(ext)) return '';
    const version = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20);
    return `events/${version}/${slug}${ext}`;
};

const nameEventBanner = async(event) => {
    const original = event.bannerUrl;
    const name = uploadNameOf(original);
    if (!name) return original;
    const store = require('../../core/storage/uploadStore');
    const safe = store.safeRel(name);
    if (!safe || safe !== name) return original;
    const { readOriginal } = require('../../core/storage/imageVariants');
    const bytes = await readOriginal(store.UPLOADS_DIR, safe, store);
    if (!bytes) return original;
    const destination = bannerName(event, safe, bytes);
    if (!destination || destination === safe) return original;
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(destination)];
    if (!await store.persistBuffer(bytes, destination, { contentType: type })) {
        // Preserve the working source URL if durable storage cannot accept it.
        require('../../config/logger').warn('Event banner naming skipped: storage unavailable', { slug: event.slug });
        return original;
    }
    return `/uploads/${destination}`;
};

module.exports = { bannerName, nameEventBanner };
