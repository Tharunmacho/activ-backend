/**
 * Report the superseded CMS collections left in the MAIN database.
 *
 * The CMS was first built into `activ-db`, then moved to `adminsdb` so that
 * marketing copy and member data would not share a lifecycle. The move created
 * the new collections but never removed the old ones, so `activ-db` still holds
 * a complete second copy of the site content that nothing reads.
 *
 * This is exactly the failure mode worth being loud about: a future reader
 * finds two `about` documents and no way to tell which one the site renders.
 *
 *   node scripts/inspect-legacy-cms.js
 *
 * Read-only. Deleting is `clean-cms-orphans.js`, which backs up first.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

/**
 * Collections believed to belong to the superseded CMS, and what replaced each.
 *
 * Listed explicitly rather than matched on a `cms_` prefix: `events` and
 * `notifications` are live platform collections, and a prefix rule that grew to
 * include one of those would propose deleting real data.
 */
const LEGACY = {
    cms_hero: 'adminsdb.home (carousel)',
    cms_about: 'adminsdb.about',
    cms_gallery: 'adminsdb.gallery',
    cms_contact_settings: 'adminsdb.contact_settings',
    cms_contact_messages: 'adminsdb.contact_messages',
    cmsUsers: 'the platform admin accounts in adminsdb',
    siteContent: 'adminsdb.site_settings / home',
    galleryImages: 'adminsdb.gallery',
    newsArticles: 'nothing — no page renders news articles',
};

/** Collections that look CMS-ish but are live. Named so nobody proposes them. */
const KEEP = {
    events: 'LIVE — the platform Event model, read by the app and /cms/events',
    notifications: 'LIVE — member notifications',
};

const preview = (doc) => {
    if (!doc) return '';
    const interesting = ['title', 'heading', 'name', 'email', 'key', 'slug', 'caption'];
    const found = interesting.filter(k => doc[k]).map(k => `${k}="${String(doc[k]).slice(0, 40)}"`);
    return found.length ? found.join(', ') : Object.keys(doc).slice(0, 6).join(', ');
};

async function main() {
    await mongoose.connect(config.db.uri);
    const db = mongoose.connection.db;
    const present = (await db.listCollections().toArray()).map(c => c.name);

    console.log(`\n${'='.repeat(74)}`);
    console.log(`SUPERSEDED CMS DATA IN ${db.databaseName}`);
    console.log('='.repeat(74));

    let total = 0;
    let withData = 0;

    for (const [name, replacement] of Object.entries(LEGACY)) {
        if (!present.includes(name)) continue;

        const count = await db.collection(name).countDocuments().catch(() => 0);
        total += count;
        if (count) withData++;

        console.log(`\n  ${name} — ${count} document(s)`);
        console.log(`    superseded by: ${replacement}`);

        if (count) {
            const sample = await db.collection(name).find({}).limit(2).toArray();
            sample.forEach((doc, i) => console.log(`    [${i + 1}] ${preview(doc)}`));
            const updated = sample[0] && (sample[0].updatedAt || sample[0].createdAt);
            if (updated) console.log(`    last touched: ${new Date(updated).toISOString().slice(0, 10)}`);
        }
    }

    console.log(`\n${'-'.repeat(74)}`);
    console.log(`  ${withData} superseded collection(s) still hold data — ${total} document(s) in total`);

    console.log('\n  NOT superseded — leave these alone:');
    for (const [name, why] of Object.entries(KEEP)) {
        if (!present.includes(name)) continue;
        const count = await db.collection(name).countDocuments().catch(() => 0);
        console.log(`    ${name} — ${count} document(s) · ${why}`);
    }

    console.log('='.repeat(74) + '\n');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nInspection failed:', err && err.message);
    process.exit(1);
});
