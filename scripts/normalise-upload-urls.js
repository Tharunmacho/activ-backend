/**
 * Make every stored upload reference relative, and make sure every file those
 * references name is in the S3 bucket.
 *
 *   node scripts/normalise-upload-urls.js              # dry run: report only
 *   node scripts/normalise-upload-urls.js --confirm    # rewrite rows + copy files
 *   node scripts/normalise-upload-urls.js --urls-only  # skip the bucket half
 *   node scripts/normalise-upload-urls.js --files-only # skip the rewrite half
 *
 * PART 1 — THE ROWS. Every document in every application database is walked
 * (`core/storage/uploadUrls.rewriteUploadUrls`), and every string that is an
 * absolute upload URL — `https://activ.org.in/uploads/x.png`,
 * `http://localhost:5000/uploads/x.png`, whatever host it was saved with — is
 * rewritten to `/uploads/x.png`. Nothing else about the row changes. Why this
 * matters is written at the top of `uploadUrls.js`: an absolute address is
 * right for one network and wrong for every other, and the site's old address
 * stopped serving new files the day the API moved.
 *
 * PART 2 — THE FILES. Every distinct `/uploads/<name>` the rows reference is
 * checked against the bucket. One that is not there is looked for on this
 * machine's `uploads/` folder, then in GridFS, then on each legacy origin
 * (`LEGACY_UPLOADS_ORIGINS`, the retired server that still holds the files
 * uploaded to it), and copied in from wherever it is found. A file found
 * nowhere is listed by name and makes the exit code 1 — a reference the
 * bucket cannot satisfy is exactly what this script exists to surface.
 *
 * Idempotent and safe to re-run. The dry run writes nothing anywhere.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const express = require('express');
const config = require('../src/config');
const dataLayout = require('../src/config/dataLayout');
const objectStore = require('../src/core/storage/objectStore');
const uploadStore = require('../src/core/storage/uploadStore');
const legacy = require('../src/core/storage/legacyUploads');
const { rewriteUploadUrls } = require('../src/core/storage/uploadUrls');

const CONFIRM = process.argv.includes('--confirm');
const URLS_ONLY = process.argv.includes('--urls-only');
const FILES_ONLY = process.argv.includes('--files-only');

/** GridFS holds bytes, not references; the audit/log tables never hold media. */
const SKIP_COLLECTIONS = new Set(['uploads.files', 'uploads.chunks', 'admin_audit_logs', 'notification_logs']);

const log = (...a) => console.log(...a);

const rewriteRows = async({ apply = CONFIRM } = {}) => {
    const names = new Set();
    const summary = [];
    let totalRows = 0;
    let totalFields = 0;

    for (const area of Object.keys(dataLayout.DATABASES)) {
        if (area === dataLayout.UPLOADS.area) continue;
        const db = dataLayout.nativeDb(area);
        const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
            .map((c) => c.name)
            .filter((n) => !n.startsWith('system.') && !SKIP_COLLECTIONS.has(n))
            .sort();

        for (const collName of collections) {
            const coll = db.collection(collName);
            let rows = 0;
            let fields = 0;
            const cursor = coll.find({}, { batchSize: 200 });
            for await (const doc of cursor) {
                const { sets, names: found } = rewriteUploadUrls(doc);
                found.forEach((n) => names.add(n));
                const paths = Object.keys(sets);
                if (!paths.length) continue;
                rows += 1;
                fields += paths.length;
                if (apply) {
                    try {
                        await coll.updateOne({ _id: doc._id }, { $set: sets });
                    } catch (err) {
                        log(`  ! ${dataLayout.dbName(area)}.${collName} ${String(doc._id)}: ${err.message}`);
                    }
                } else if (rows <= 3) {
                    paths.forEach((p) => log(`    ${dataLayout.dbName(area)}.${collName} ${String(doc._id)} ${p}: ${sets[p]}`));
                }
            }
            if (rows) {
                summary.push({ database: dataLayout.dbName(area), collection: collName, rows, fields });
                totalRows += rows;
                totalFields += fields;
            }
        }
    }

    return { names, summary, totalRows, totalFields };
};

/** Copy one upload into the bucket from disk, GridFS or a legacy origin. */
const recoverFile = async(name) => {
    if ((await objectStore.exists(name)) === true) return 'already';
    if (!CONFIRM) {
        // Dry run: say where it WOULD come from, without copying.
        const onDisk = fs.existsSync(path.join(uploadStore.UPLOADS_DIR, name));
        if (onDisk) return 'would copy from disk';
        const store = uploadStore.bucket();
        if (store && (await store.find({ filename: name }).limit(1).toArray()).length) return 'would copy from GridFS';
        const got = await legacy.fetchLegacy(name);
        return got ? `would copy from ${got.origin}` : 'missing';
    }

    const full = path.join(uploadStore.UPLOADS_DIR, name);
    if (fs.existsSync(full)) {
        const ok = await objectStore.putFile(full, name, { contentType: express.static.mime.lookup(name) || '' });
        if (ok) return 'copied from disk';
    }
    const store = uploadStore.bucket();
    if (store) {
        const [file] = await store.find({ filename: name }).sort({ uploadDate: -1 }).limit(1).toArray();
        if (file) {
            const chunks = [];
            const buf = await new Promise((resolve, reject) => {
                store.openDownloadStream(file._id)
                    .on('data', (c) => chunks.push(c)).on('error', reject)
                    .on('end', () => resolve(Buffer.concat(chunks)));
            }).catch(() => null);
            if (buf && await objectStore.putBuffer(buf, name, { contentType: (file.metadata && file.metadata.contentType) || '' })) {
                return 'copied from GridFS';
            }
        }
    }
    const result = await legacy.recoverToBucket(name);
    if (result === 'recovered') return 'copied from legacy origin';
    return result === 'already' ? 'already' : 'missing';
};

(async() => {
    await mongoose.connect(config.db.uri);
    log(CONFIRM ? 'APPLYING changes.' : 'DRY RUN — nothing is written. Re-run with --confirm to apply.');

    let names = new Set();
    if (!FILES_ONLY) {
        log('\nPart 1 — upload URLs stored with a host:');
        const r = await rewriteRows();
        names = r.names;
        if (!r.summary.length) log('  none — every stored upload reference is already relative.');
        r.summary.forEach((s) => log(`  ${s.database}.${s.collection}: ${s.rows} row(s), ${s.fields} field(s)${CONFIRM ? ' rewritten' : ''}`));
        log(`  total: ${r.totalRows} row(s), ${r.totalFields} field(s); ${names.size} distinct upload file(s) referenced`);
    } else {
        // Files only: the reference list is still needed, read without rewriting.
        names = (await rewriteRows({ apply: false })).names;
    }

    let missing = [];
    if (!URLS_ONLY) {
        log('\nPart 2 — referenced files in the bucket:');
        if (!objectStore.isEnabled()) {
            log('  bucket not configured (AWS_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) — skipped.');
        } else {
            const probe = await objectStore.probe();
            if (!probe.ok) {
                log(`  bucket "${config.objectStorage.bucket}" is not usable: ${probe.reason} — skipped.`);
            } else {
                log(`  legacy origins: ${legacy.origins().join(', ') || 'none'}`);
                const tally = {};
                for (const name of [...names].sort()) {
                    const outcome = await recoverFile(name);
                    tally[outcome] = (tally[outcome] || 0) + 1;
                    if (outcome === 'missing') missing.push(name);
                    else if (outcome !== 'already') log(`  ${outcome}: ${name}`);
                }
                Object.entries(tally).forEach(([k, v]) => log(`  ${k}: ${v}`));
                if (missing.length) {
                    log(`\n  ${missing.length} referenced file(s) found NOWHERE (disk, GridFS, bucket, legacy origins):`);
                    missing.forEach((n) => log(`    /uploads/${n}`));
                }
            }
        }
    }

    await mongoose.disconnect();
    process.exit(missing.length ? 1 : 0);
})().catch(async(err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
