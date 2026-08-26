/**
 * Remove the superseded CMS data left in the MAIN database.
 *
 * The CMS was first built into `activ-db`, then moved to `adminsdb` so that
 * marketing copy and member data would not share a lifecycle. The move created
 * the new collections and never removed the old ones, so `activ-db` still holds
 * a second, disconnected copy of the site content.
 *
 * Nothing reads any of it — verified by grep across `backend/src`,
 * `website/src` and `frontend/src`. It is removed anyway, because two copies of
 * an `about` document with no way to tell which one the site renders is a trap
 * for whoever reads this database next.
 *
 *   node scripts/clean-cms-orphans.js            # report what would go
 *   node scripts/clean-cms-orphans.js --confirm  # back up, then remove
 *
 * Every document removed is written to `backups/cms-orphans-<timestamp>.json`
 * first, so this is reversible. Content is the one thing that cannot be
 * rebuilt from the code.
 *
 * The allow-list below is explicit rather than a `cms_` prefix match. `events`
 * and `notifications` are live platform collections, and a prefix rule that
 * grew to catch one of those would propose deleting real data.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

/** Superseded collections in `activ-db`, and what replaced each. */
const LEGACY = {
    cms_hero: 'adminsdb.home (carousel)',
    cms_about: 'adminsdb.about',
    cms_gallery: 'adminsdb.gallery',
    cms_contact_settings: 'adminsdb.contact_settings',
    cms_contact_messages: 'adminsdb.contact_messages',
    cmsUsers: 'the admin accounts in adminsdb',
    siteContent: 'adminsdb.site_settings and adminsdb.home',
    galleryImages: 'adminsdb.gallery',
    newsArticles: 'nothing — no page renders news articles',
};

/**
 * Fields dropped from a schema, by collection, in `adminsdb`.
 *
 * Mongoose stops reading a removed path but never deletes it, so a field can
 * outlive the code that wrote it. Currently empty — `home.stats` and
 * `home.features` were checked and are not present — but the check is kept so
 * the next schema change has somewhere to declare its leftovers.
 */
const ORPHAN_FIELDS = {
    home: ['stats', 'features'],
};

const preview = (doc) => {
    const interesting = ['title', 'heading', 'name', 'email', 'key', 'slug', 'caption'];
    const found = interesting.filter(k => doc[k]).map(k => `${k}="${String(doc[k]).slice(0, 40)}"`);
    return found.length ? found.join(', ') : Object.keys(doc).slice(0, 6).join(', ');
};

const summarise = (value) => {
    if (Array.isArray(value)) return `array of ${value.length}`;
    if (value && typeof value === 'object') return `object with ${Object.keys(value).length} key(s)`;
    return JSON.stringify(value);
};

async function main() {
    console.log('\n=== CMS orphan cleanup ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: REPORT ONLY (pass --confirm to remove)');

    await mongoose.connect(config.db.uri);
    const main = mongoose.connection.db;

    const backup = {
        takenAt: new Date().toISOString(),
        note: 'Superseded CMS data removed from activ-db after the move to adminsdb.',
        collections: {},
        fields: {},
    };

    // ---- superseded collections in the main database -----------------------
    console.log(`\nSuperseded collections in ${main.databaseName}`);
    const present = (await main.listCollections().toArray()).map(c => c.name);
    let removedCollections = 0;
    let removedDocs = 0;

    for (const [name, replacement] of Object.entries(LEGACY)) {
        if (!present.includes(name)) continue;

        const docs = await main.collection(name).find({}).toArray();
        backup.collections[name] = docs;
        removedCollections++;
        removedDocs += docs.length;

        console.log(`\n  ${CONFIRM ? 'DROP' : 'would drop'}  ${name} — ${docs.length} document(s)`);
        console.log(`    superseded by: ${replacement}`);
        docs.slice(0, 3).forEach((doc, i) => console.log(`    [${i + 1}] ${preview(doc)}`));

        if (CONFIRM) await main.collection(name).drop();
    }

    if (!removedCollections) console.log('  none');

    // ---- fields dropped from a schema, in adminsdb --------------------------
    console.log('\nOrphan fields in adminsdb');
    const ready = await adminsDb.ensureReady();
    let removedFields = 0;

    if (!ready) {
        console.log('  adminsdb unreachable — skipped (nothing there was changed)');
    } else {
        const admins = adminsDb.getConnection().db;
        const adminNames = (await admins.listCollections().toArray()).map(c => c.name);

        for (const [name, fields] of Object.entries(ORPHAN_FIELDS)) {
            if (!adminNames.includes(name)) continue;

            for (const doc of await admins.collection(name).find({}).toArray()) {
                const found = fields.filter(f => doc[f] !== undefined);
                if (!found.length) continue;

                removedFields += found.length;
                backup.fields[`${name}:${doc._id}`] = found.reduce((acc, f) => {
                    acc[f] = doc[f];
                    return acc;
                }, {});

                found.forEach(f =>
                    console.log(`  ${CONFIRM ? 'REMOVE' : 'would remove'}  ${name}.${f} (${summarise(doc[f])})`));

                if (CONFIRM) {
                    await admins.collection(name).updateOne(
                        { _id: doc._id },
                        { $unset: found.reduce((acc, f) => { acc[f] = ''; return acc; }, {}) },
                    );
                }
            }
        }
        if (!removedFields) console.log('  none');
    }

    // ---- what was deliberately left alone ----------------------------------
    console.log('\nLeft alone (live platform data):');
    for (const name of ['events', 'notifications']) {
        if (!present.includes(name)) continue;
        const count = await main.collection(name).countDocuments().catch(() => 0);
        console.log(`  ${name} — ${count} document(s)`);
    }

    // ---- the backup --------------------------------------------------------
    if (CONFIRM && (removedCollections || removedFields)) {
        const dir = path.join(__dirname, '../backups');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const file = path.join(dir, `cms-orphans-${backup.takenAt.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(backup, null, 2));
        console.log(`\nBacked up ${removedDocs} document(s) to ${path.relative(process.cwd(), file)}`);
    }

    console.log(CONFIRM
        ? `\nDone. Removed ${removedCollections} collection(s) and ${removedFields} orphan field(s).`
        : '\nNothing was changed. Re-run with --confirm.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nCleanup failed:', err && err.message);
    console.error(err);
    process.exit(1);
});
