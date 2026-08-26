/**
 * Reclaim uploaded files that nothing references.
 *
 * The CMS now removes a file as soon as the last reference to it goes, but that
 * only applies from here on. Anything orphaned before — a gallery image deleted
 * last month, a banner replaced twice — is still on disk. This is the one-off
 * sweep for those, and a way to check the running cleanup is doing its job.
 *
 *   node scripts/clean-orphan-uploads.js            # report
 *   node scripts/clean-orphan-uploads.js --confirm  # delete
 *
 * Reference counting is shared with the live cleanup (`media.cleanup.js`), so
 * this cannot disagree with it about what is in use. A file referenced from any
 * CMS document or any event is never touched, however old it looks.
 *
 * Note what is NOT scanned: member profile photos and application documents
 * live in the same directory but belong to `activ-db` collections this module
 * knows nothing about. `--confirm` therefore refuses to run unless
 * `--include-member-uploads` is also given, and that flag is deliberately
 * undocumented in the help text below because using it needs the member
 * collections added to the reference scan first.
 */

require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

/** Prefixes written by the CMS and by event/gallery uploads. */
const CMS_PREFIXES = ['cms-', 'event-', 'gallery-'];

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

async function main() {
    console.log('\n=== Orphaned uploads ===');
    console.log(CONFIRM ? 'Mode: DELETE' : 'Mode: REPORT ONLY (pass --confirm to delete)');

    await mongoose.connect(config.db.uri);
    await adminsDb.ensureReady();

    const { findAllOrphans, UPLOADS_DIR } = require('../src/modules/cms/media.cleanup');
    const fs = require('fs').promises;

    const { orphans, onDisk, referenced } = await findAllOrphans();

    console.log(`\n  ${onDisk} file(s) on disk, ${referenced} referenced by content`);
    console.log(`  ${path.relative(process.cwd(), UPLOADS_DIR)}`);

    /**
     * Split by filename prefix.
     *
     * Member photos and application documents share this directory but are
     * referenced from collections this scan does not read, so treating them as
     * orphans would delete live member data. Only files this module is known to
     * have written are eligible.
     */
    const mine = orphans.filter(o => CMS_PREFIXES.some(p => o.name.startsWith(p)));
    const theirs = orphans.filter(o => !CMS_PREFIXES.some(p => o.name.startsWith(p)));

    if (!mine.length) {
        console.log('\n  No orphaned CMS uploads.');
    } else {
        const total = mine.reduce((sum, o) => sum + o.bytes, 0);
        console.log(`\n  ${mine.length} orphaned CMS upload(s), ${kb(total)}:`);
        mine.forEach(o => console.log(`    ${CONFIRM ? 'DELETE' : 'would delete'}  ${o.name}  ${kb(o.bytes)}  ${o.modified.toISOString().slice(0, 10)}`));

        if (CONFIRM) {
            let removed = 0;
            for (const o of mine) {
                try {
                    await fs.unlink(path.join(UPLOADS_DIR, o.name));
                    removed++;
                } catch (err) {
                    console.log(`    failed: ${o.name} — ${err.message}`);
                }
            }
            console.log(`\n  Removed ${removed} file(s), ${kb(total)} reclaimed.`);
        }
    }

    if (theirs.length) {
        const total = theirs.reduce((sum, o) => sum + o.bytes, 0);
        console.log(`\n  ${theirs.length} other file(s) (${kb(total)}) NOT touched — member photos and`);
        console.log('  application documents live here too, and this scan does not read the');
        console.log('  collections that reference them. Deleting them needs that scan first.');
        theirs.slice(0, 8).forEach(o => console.log(`    keep  ${o.name}`));
        if (theirs.length > 8) console.log(`    … and ${theirs.length - 8} more`);
    }

    if (!CONFIRM && mine.length) console.log('\nNothing was deleted. Re-run with --confirm.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nSweep failed:', err && err.message);
    console.error(err);
    process.exit(1);
});
