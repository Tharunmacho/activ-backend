/**
 * Is every uploaded file the site uses actually stored?
 *
 *   node scripts/verify-uploads.js
 *
 * READ-ONLY. Scans every collection for `/uploads/<file>` references (banners,
 * posters, gallery photos, speaker photos, logos, event documents …) and checks
 * each file against the three places an upload lives:
 *
 *   disk    backend/uploads — where multer writes it (lost on a redeploy)
 *   bucket  the S3 bucket   — the durable copy every upload is sent to
 *   gridfs  the database    — the fallback when the bucket refused it
 *
 * A file in NONE of the three is a broken image on the site. A file on disk
 * only is one redeploy away from being broken — `node scripts/sync-uploads.js`
 * (or `uploadStore.syncToBucket`) copies it up.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const objectStore = require('../src/core/storage/objectStore');
const { UPLOADS_DIR, BUCKET } = require('../src/core/storage/uploadStore');

const NAME = /\/uploads\/([\w.-]+)/g;

(async() => {
    await mongoose.connect(config.mongodb?.uri || process.env.MONGODB_URI);
    const db = mongoose.connection.db;

    const refs = new Map(); // name -> first collection seen in
    for (const { name: coll } of await db.listCollections().toArray()) {
        if (coll.startsWith('system.') || coll.endsWith('.chunks') || coll.endsWith('.files')) continue;
        const cursor = db.collection(coll).find({}, { batchSize: 200 });
        for await (const doc of cursor) {
            const text = JSON.stringify(doc);
            for (const m of text.matchAll(NAME)) if (!refs.has(m[1])) refs.set(m[1], coll);
        }
    }

    const grid = new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
    const bucketOn = objectStore.isEnabled();
    const rows = { ok: 0, bucket: 0, gridOnly: 0, diskOnly: 0, missing: [] };

    for (const [name, coll] of refs) {
        const inBucket = bucketOn ? (await objectStore.exists(name)) === true : false;
        const onDisk = fs.existsSync(path.join(UPLOADS_DIR, name));
        const inGrid = inBucket ? false : (await grid.find({ filename: name }).limit(1).toArray()).length > 0;
        if (inBucket) rows.bucket++;
        else if (inGrid) rows.gridOnly++;
        else if (onDisk) rows.diskOnly++;
        else rows.missing.push(`${name}  (referenced in ${coll})`);
    }

    console.log(`\nUploads referenced by the site: ${refs.size}`);
    console.log(`  in the S3 bucket          : ${rows.bucket}${bucketOn ? '' : '  (bucket NOT configured here)'}`);
    console.log(`  database (GridFS) only    : ${rows.gridOnly}`);
    console.log(`  this machine's disk only  : ${rows.diskOnly}`);
    console.log(`  NOT STORED ANYWHERE       : ${rows.missing.length}`);
    rows.missing.slice(0, 40).forEach((m) => console.log(`    - ${m}`));
    await mongoose.disconnect();
    process.exit(rows.missing.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
