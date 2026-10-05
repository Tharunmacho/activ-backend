const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const readableFilename = file => {
    const original = path.basename(String(file.originalname || '').replace(/\\/g, '/'));
    const extension = EXTENSIONS[file.mimetype] || path.extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const stem = path.basename(original, path.extname(original)).normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/, '') || 'image';
    return `${stem}${extension}`;
};

// The version folder prevents collisions and stale cached replacements, while
// the actual filename stays readable. Existing upload URLs are never renamed.
const mediaFilename = (root, category = 'media') => (req, file, cb) => {
    const folder = `${category}/${randomUUID()}`;
    fs.mkdir(path.join(root, folder), { recursive: true }, error => {
        if (error) return cb(error);
        cb(null, `${folder}/${readableFilename(file)}`);
    });
};

module.exports = { readableFilename, mediaFilename };
