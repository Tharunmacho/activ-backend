const crypto = require('crypto');
const { uploadNameOf, relativizeUploadUrl } = require('../../core/storage/uploadUrls');
const sourceOf = event => event.imageUrl || event.media?.url || '';
const versionOf = event => crypto.createHash('sha256').update(relativizeUploadUrl(sourceOf(event))).digest('hex').slice(0, 20);
const previewImageUrl = (event, origin) => sourceOf(event)
    ? `${origin}/api/v1/share/events/${encodeURIComponent(event.slug || event.id)}/preview/${versionOf(event)}.jpg` : '';
const cache = new Map();
const previewBytes = async event => {
    const source = sourceOf(event);
    const key = versionOf(event);
    if (cache.has(key)) return cache.get(key);
    const name = uploadNameOf(source);
    let bytes;
    if (name) {
        const store = require('../../core/storage/uploadStore');
        if (store.safeRel(name) !== name) throw new Error('Invalid event banner path');
        bytes = await require('../../core/storage/imageVariants').readOriginal(store.UPLOADS_DIR, name, store);
    } else {
        const response = await fetch(source, { signal: AbortSignal.timeout(8000) });
        if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) throw new Error('Event banner unavailable');
        bytes = Buffer.from(await response.arrayBuffer());
    }
    if (!bytes) throw new Error('Event banner unavailable');
    const jpeg = await require('sharp')(bytes).rotate()
        .resize(1200, 630, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
    if (cache.size >= 40) cache.delete(cache.keys().next().value);
    cache.set(key, jpeg);
    return jpeg;
};
module.exports = { previewImageUrl, previewBytes, versionOf };
