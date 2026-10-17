const { uploadNameOf } = require('../../core/storage/uploadUrls');
const { publicMediaOrigin } = require('../../core/storage/publicMedia');

/** WhatsApp image headers require JPEG/PNG, even when its downloader accepts WebP. */
const whatsappImageUrl = value => {
    const raw = String(value || '').trim();
    const name = uploadNameOf(raw);
    if (!name || !/\.(?:jpe?g|png|webp|avif|gif)$/i.test(name)) return raw;
    // Uploads are project-owned immutable files; reuse the existing local
    // variant route rather than fetching arbitrary remote media on the server.
    const base = publicMediaOrigin().replace(/\/+$/, '');
    return `${base}/uploads/${name}?w=1600&format=jpeg`;
};

module.exports = { whatsappImageUrl };
