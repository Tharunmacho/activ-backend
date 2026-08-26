/**
 * Show exactly what is on disk for the CMS, in both databases.
 *
 * Written to answer one question without guessing: which collection holds each
 * CMS document, and which top-level fields does it actually carry? A field the
 * code no longer reads is invisible from the API, so the only honest way to
 * check for leftovers is to read the raw documents.
 *
 *   node scripts/inspect-cms-db.js
 *
 * Read-only. It never writes.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

/** Fields the current code reads, per collection. Anything else is a leftover. */
const KNOWN = {
    site_settings: ['_id', 'key', 'brand', 'header', 'footer', 'editedBy', 'createdAt', 'updatedAt', '__v'],
    home: ['_id', 'key', 'carousel', 'about', 'editedBy', 'createdAt', 'updatedAt', '__v'],
    about: ['_id', 'key', 'badgeIcon', 'badgeText', 'heading', 'headingHighlight', 'body',
        'bullets', 'bulletPoints', 'media', 'logoOverlay', 'statsBar',
        'editedBy', 'createdAt', 'updatedAt', '__v'],
    events_settings: ['_id', 'key', 'badgeText', 'heading', 'subtitle', 'viewAllLabel', 'viewAllHref',
        'emptyText', 'homeLimit', 'editedBy', 'createdAt', 'updatedAt', '__v'],
    gallery_settings: ['_id', 'key', 'badgeIcon', 'badgeText', 'heading', 'headingHighlight', 'description',
        'noteLines', 'categories', 'viewMoreLabel', 'pageSize',
        'editedBy', 'createdAt', 'updatedAt', '__v'],
    gallery: ['_id', 'media', 'title', 'caption', 'category', 'eventDate', 'location', 'featured',
        'sortOrder', 'visible', 'editedBy', 'createdAt', 'updatedAt', '__v'],
    contact_settings: ['_id', 'key', 'badgeIcon', 'badgeText', 'heading', 'headingHighlight', 'description',
        'heroMedia', 'formCard', 'infoCard', 'addressLines', 'phone', 'alternatePhone',
        'email', 'workingHours', 'mapEmbedUrl', 'social', 'banner',
        'editedBy', 'createdAt', 'updatedAt', '__v'],
    contact_messages: ['_id', 'name', 'email', 'phone', 'subject', 'message', 'status', 'meta',
        'createdAt', 'updatedAt', '__v'],
};

const CMS_NAMES = Object.keys(KNOWN);

async function report(label, db) {
    console.log(`\n${'='.repeat(70)}\n${label}  (${db.databaseName})\n${'='.repeat(70)}`);

    const names = (await db.listCollections().toArray()).map(c => c.name).sort();
    const cmsHere = names.filter(n => CMS_NAMES.includes(n) || n === 'hero');

    if (!cmsHere.length) {
        console.log('  no CMS collections in this database');
        console.log('  (collections present: ' + (names.join(', ') || 'none') + ')');
        return;
    }

    for (const name of cmsHere) {
        const collection = db.collection(name);
        const count = await collection.countDocuments();
        console.log(`\n  ${name} — ${count} document(s)`);

        if (!count) continue;

        // One document is enough to see the field set for a singleton; for the
        // multi-document collections the union across all of them is what
        // matters, since a leftover may sit on only one row.
        const docs = await collection.find({}).limit(200).toArray();
        const seen = new Set();
        docs.forEach(d => Object.keys(d).forEach(k => seen.add(k)));

        const known = KNOWN[name] || [];
        const extra = [...seen].filter(k => !known.includes(k)).sort();

        console.log('    fields: ' + [...seen].sort().join(', '));

        if (extra.length) {
            console.log('    LEFTOVER (no code reads these): ' + extra.join(', '));
            for (const field of extra) {
                const withField = docs.filter(d => d[field] !== undefined);
                const sample = withField[0][field];
                const shape = Array.isArray(sample)
                    ? `array of ${sample.length}`
                    : sample && typeof sample === 'object' ? 'object' : JSON.stringify(sample);
                console.log(`      ${field}: on ${withField.length}/${docs.length} doc(s), ${shape}`);
            }
        } else {
            console.log('    no leftovers');
        }
    }
}

async function main() {
    await mongoose.connect(config.db.uri);
    const ready = await adminsDb.ensureReady();

    await report('MAIN DATABASE', mongoose.connection.db);

    if (ready) {
        await report('ADMINS DATABASE', adminsDb.getConnection().db);
    } else {
        console.log('\nadminsdb is unreachable — could not inspect it.');
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nInspection failed:', err && err.message);
    process.exit(1);
});
