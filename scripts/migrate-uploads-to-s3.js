/**
 * Copy every existing upload into the S3 bucket (Garage).
 *
 * Sources: the local `uploads/` folder and the GridFS `uploads` bucket in
 * MongoDB (where uploads went before the S3 bucket existed). Idempotent —
 * anything the bucket already holds is skipped, so it is safe to re-run.
 *
 *   node scripts/migrate-uploads-to-s3.js                    # dry run: what would be copied
 *   node scripts/migrate-uploads-to-s3.js --confirm          # copy
 *   node scripts/migrate-uploads-to-s3.js --confirm --remove-gridfs
 *                                                            # copy, then delete GridFS copies
 *                                                            # the bucket is confirmed to hold
 *
 * The server also runs the copy (without --remove-gridfs) at every boot once
 * the bucket is writable, so this script is for doing it on demand and for
 * reclaiming the GridFS space.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const objectStore = require('../src/core/storage/objectStore');
const { syncToBucket } = require('../src/core/storage/uploadStore');

const CONFIRM = process.argv.includes('--confirm');
const REMOVE_GRIDFS = process.argv.includes('--remove-gridfs');

(async() => {
    if (!objectStore.isEnabled()) {
        console.error('AWS_BUCKET_NAME / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not all set.');
        process.exit(1);
    }

    const probe = await objectStore.probe();
    if (!probe.ok) {
        console.error(`The bucket "${config.objectStorage.bucket}" at ${config.objectStorage.endpoint} is not writable: ${probe.reason}`);
        console.error('On Garage, grant the key access with:');
        console.error(`  garage bucket allow --read --write --owner ${config.objectStorage.bucket} --key ${config.objectStorage.accessKeyId}`);
        process.exit(1);
    }

    await mongoose.connect(config.db.uri);

    const result = await syncToBucket({
        dryRun: !CONFIRM,
        removeFromGridFS: CONFIRM && REMOVE_GRIDFS,
    });

    console.log(CONFIRM ? 'Done.' : 'Dry run — nothing copied. Re-run with --confirm.');
    console.log(result);

    await mongoose.disconnect();
    process.exit(result.failed ? 1 : 0);
})().catch(async(err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
