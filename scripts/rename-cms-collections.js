/**
 * Give every CMS collection a `web_` prefix.
 *
 * `adminsdb` holds two unrelated things: the four admin-account collections and
 * the public site's content. A client listing collections sorts them
 * alphabetically, so unprefixed names interleave — `about`, `blockadmins`,
 * `contact_settings`, `districtadmins`, `gallery`, `home`, `stateadmins` — and
 * telling staff records from site content means reading the list twice.
 *
 * `web_` sorts after every admin collection (b, d, st, su all precede w), which
 * groups the two sets:
 *
 *     blockadmins            web_events_settings
 *     districtadmins         web_gallery
 *     stateadmins            web_gallery_settings
 *     superadmins            web_home
 *     web_about              web_site_settings
 *     web_contact_messages
 *     web_contact_settings
 *
 *   node scripts/rename-cms-collections.js            # report
 *   node scripts/rename-cms-collections.js --confirm  # rename
 *
 * `renameCollection` moves a collection in place — the documents, their _ids
 * and their indexes are untouched, so this is not a copy and there is nothing
 * to lose. It is still gated behind `--confirm`, because the API reads the new
 * names and will see empty collections until this has run.
 *
 * Safe to re-run: a source that no longer exists is skipped.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

/** Old name -> new name. Must match `collection:` in `cms.models.js`. */
const RENAMES = {
    site_settings: 'web_site_settings',
    home: 'web_home',
    about: 'web_about',
    events_settings: 'web_events_settings',
    gallery_settings: 'web_gallery_settings',
    gallery: 'web_gallery',
    contact_settings: 'web_contact_settings',
    contact_messages: 'web_contact_messages',
};

async function main() {
    console.log('\n=== Rename CMS collections ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: REPORT ONLY (pass --confirm to rename)');

    await mongoose.connect(config.db.uri);
    if (!await adminsDb.ensureReady()) {
        console.error('\nadminsdb is unreachable — nothing was changed.');
        process.exit(1);
    }

    const db = adminsDb.getConnection().db;
    const present = (await db.listCollections().toArray()).map(c => c.name);

    let renamed = 0;
    let skipped = 0;

    for (const [from, to] of Object.entries(RENAMES)) {
        if (present.includes(to) && !present.includes(from)) {
            console.log(`  done already  ${to}`);
            skipped++;
            continue;
        }

        if (!present.includes(from)) {
            console.log(`  not present   ${from} — nothing to rename`);
            skipped++;
            continue;
        }

        if (present.includes(to) && present.includes(from)) {
            const targetCount = await db.collection(to).countDocuments();

            // The usual cause: the API restarted against the new model names
            // before this ran, and Mongoose created the target on first query.
            // An empty collection holds nothing to lose, so it is dropped and
            // the rename proceeds.
            if (targetCount === 0) {
                console.log(`  ${CONFIRM ? 'DROP' : 'would drop'}  ${to} — auto-created and empty`);
                if (CONFIRM) await db.collection(to).drop();
            } else {
                // Both hold data. Merging is a judgement call, not a script's.
                const fromCount = await db.collection(from).countDocuments();
                console.log(`  CONFLICT      ${from} (${fromCount}) AND ${to} (${targetCount}) both hold data`);
                console.log('                left alone — resolve by hand');
                skipped++;
                continue;
            }
        }

        const count = await db.collection(from).countDocuments();
        console.log(`  ${CONFIRM ? 'RENAME' : 'would rename'}  ${from} -> ${to}  (${count} document(s))`);

        if (CONFIRM) await db.collection(from).rename(to);
        renamed++;
    }

    if (CONFIRM) {
        const after = (await db.listCollections().toArray()).map(c => c.name).sort();
        console.log('\nadminsdb now lists:');
        after.forEach(n => console.log(`  ${n}`));
    }

    console.log(CONFIRM
        ? `\nDone. ${renamed} renamed, ${skipped} skipped.`
        : `\nNothing was changed. ${renamed} would be renamed. Re-run with --confirm.`);

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nRename failed:', err && err.message);
    console.error(err);
    process.exit(1);
});
