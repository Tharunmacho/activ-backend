#!/usr/bin/env node
/**
 * Give every event that has none its readable public address (slug).
 *
 *   node scripts/backfill-event-slugs.js            dry run: print what would be set
 *   node scripts/backfill-event-slugs.js --confirm  write them
 *
 * Additive and idempotent: only rows with no slug are touched, and a slug once
 * written is never changed (see src/modules/events/eventSlug.js). New events
 * get theirs on create, so this is needed once.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Event = require('../src/modules/events/event.model');
const { uniqueSlug } = require('../src/modules/events/eventSlug');

const confirm = process.argv.includes('--confirm');

(async() => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    // Only the slug index — never syncIndexes, which also DROPS undeclared ones.
    if (confirm) {
        await Event.collection.createIndex({ slug: 1 }, { unique: true, sparse: true })
            .catch((e) => console.warn('Slug index:', e.message));
    }

    const rows = await Event.find({ $or: [{ slug: { $exists: false } }, { slug: '' }, { slug: null }] })
        .select('_id title startAt slug').sort({ createdAt: 1 }).lean();
    console.log(`${rows.length} event(s) without a slug${confirm ? '' : ' (dry run - add --confirm to write)'}\n`);

    const taken = new Set();
    for (const row of rows) {
        let slug = await uniqueSlug(Event, row);
        // Two rows in this same run can compute the same free slug.
        for (let n = 2; taken.has(slug); n += 1) slug = `${slug.replace(/-\d+$/, '')}-${n}`;
        taken.add(slug);
        console.log(`  ${row._id}  ${slug}`);
        if (confirm) await Event.updateOne({ _id: row._id, $or: [{ slug: { $exists: false } }, { slug: '' }, { slug: null }] }, { $set: { slug } });
    }

    await mongoose.disconnect();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
