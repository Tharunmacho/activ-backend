#!/usr/bin/env node
/**
 * Give every gallery item that has none its readable public address (slug).
 *
 *   node scripts/backfill-gallery-slugs.js            dry run: print what would be set
 *   node scripts/backfill-gallery-slugs.js --confirm  write them
 *
 * The gallery lives on the CMS connection (`adminsDb`), not the default one.
 * Additive and idempotent: only rows with no slug are touched, and a slug once
 * written is never changed. New items get theirs on create.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const adminsDb = require('../src/modules/admin/adminsDb');
const { GalleryItem } = require('../src/modules/cms/cms.models');
const { galleryBaseSlug, uniqueSlugFrom } = require('../src/modules/events/eventSlug');

const confirm = process.argv.includes('--confirm');
const missing = { $or: [{ slug: { $exists: false } }, { slug: '' }, { slug: null }] };

(async() => {
    await adminsDb.ensureReady();
    // Only the slug index — never syncIndexes, which also DROPS undeclared ones.
    if (confirm) {
        await GalleryItem.collection.createIndex({ slug: 1 }, { unique: true, sparse: true })
            .catch((e) => console.warn('Slug index:', e.message));
    }

    const rows = await GalleryItem.find(missing).select('_id title eventDate slug').sort({ createdAt: 1 }).lean();
    console.log(`${rows.length} gallery item(s) without a slug${confirm ? '' : ' (dry run - add --confirm to write)'}\n`);

    const taken = new Set();
    for (const row of rows) {
        let slug = await uniqueSlugFrom(GalleryItem, row, galleryBaseSlug(row));
        for (let n = 2; taken.has(slug); n += 1) slug = `${slug.replace(/-\d+$/, '')}-${n}`;
        taken.add(slug);
        console.log(`  ${row._id}  ${slug}`);
        if (confirm) await GalleryItem.updateOne({ _id: row._id, ...missing }, { $set: { slug } });
    }
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
