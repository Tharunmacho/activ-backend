/**
 * Copy every file in backend/uploads/ into the database's `uploads` GridFS
 * bucket, so it survives the next deploy. See src/core/storage/uploadStore.js.
 *
 *   node scripts/sync-uploads-to-db.js            # dry run: lists what it would copy
 *   node scripts/sync-uploads-to-db.js --confirm  # copies
 *
 * Idempotent: a file already in the bucket is skipped. Run it on any machine
 * or container whose uploads folder still holds files the site references.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const { persistFile, UPLOADS_DIR, BUCKET } = require('../src/core/storage/uploadStore');

const confirm = process.argv.includes('--confirm');

const TYPES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.pdf': 'application/pdf',
};

(async () => {
    await mongoose.connect(config.db.uri, config.db.options);
    const store = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

    const names = fs.existsSync(UPLOADS_DIR)
        ? fs.readdirSync(UPLOADS_DIR).filter((n) => !n.startsWith('.')
            && fs.statSync(path.join(UPLOADS_DIR, n)).isFile())
        : [];

    let copied = 0;
    let skipped = 0;
    for (const name of names) {
        const exists = await store.find({ filename: name }).limit(1).toArray();
        if (exists.length) { skipped += 1; continue; }

        if (!confirm) {
            console.log(`would copy  ${name}`);
            copied += 1;
            continue;
        }
        const ok = await persistFile(path.join(UPLOADS_DIR, name), {
            contentType: TYPES[path.extname(name).toLowerCase()] || '',
        });
        console.log(`${ok ? 'copied' : 'FAILED'}      ${name}`);
        if (ok) copied += 1;
    }

    console.log(`\n${names.length} on disk, ${skipped} already stored, ${copied} ${confirm ? 'copied' : 'to copy'}.`);
    if (!confirm && copied) console.log('Dry run. Re-run with --confirm to copy.');
    await mongoose.disconnect();
})().catch((err) => {
    console.error(err && err.message);
    process.exit(1);
});
