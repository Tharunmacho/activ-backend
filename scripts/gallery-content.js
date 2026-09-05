/**
 * Bulk edit the gallery from a file.
 *
 * The CMS at /cms/gallery is the right tool for one image. It is the wrong tool
 * for writing eight event accounts in one sitting: that is typing, and typing
 * belongs in a text editor with a spell-checker, not in eight expandable panels
 * in a browser tab. This exports what is there, and imports it back.
 *
 *   node scripts/gallery-content.js --export gallery.json
 *       # write every gallery item to a file you can edit
 *
 *   node scripts/gallery-content.js --import gallery.json
 *       # report exactly what would change, and change nothing
 *
 *   node scripts/gallery-content.js --import gallery.json --confirm
 *       # apply it
 *
 * MATCHING. An entry with an `id` updates that item — this is what an exported
 * file gives you, and it means renaming an event works. An entry with no `id`
 * is matched on its exact title, and creates the item when no such title
 * exists. So adding an event is: add an object with a title and an image.
 *
 * DELETING. `"delete": true` on an entry removes it permanently, along with any
 * uploaded file nothing else points at. It is reported on its own line, in
 * capitals, and needs `--confirm` like everything else.
 *
 * OMITTING A FIELD LEAVES IT ALONE. `updateGalleryItem` patches only what it is
 * given, so an entry carrying nothing but `id` and `description` rewrites the
 * write-up and touches nothing else. An empty string, by contrast, is an
 * instruction: it clears that field.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const args = process.argv.slice(2);
const CONFIRM = args.includes('--confirm');

const flagValue = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : (args[i + 1] || null);
};

const EXPORT_TO = flagValue('--export');
const IMPORT_FROM = flagValue('--import');

/** The fields an entry may carry, in the order they are written to the file. */
const FIELDS = [
    'title', 'category', 'eventDate', 'location',
    'caption', 'description', 'highlights', 'customFields',
    'image', 'photos',
    'showOnHome', 'pinned', 'featured', 'visible',
];

// ---------------------------------------------------------------- export

const toEntry = (item) => ({
    id: String(item._id),
    title: item.title || '',
    category: item.category || '',
    eventDate: item.eventDate || '',
    location: item.location || '',
    caption: item.caption || '',
    description: item.description || '',
    highlights: item.highlights || [],
    customFields: (item.customFields || []).map(f => ({ label: (f && f.label) || '', value: (f && f.value) || '' })),
    image: (item.media || {}).url || '',
    photos: (item.photos || []).map(p => (p || {}).url).filter(Boolean),
    showOnHome: item.showOnHome !== false,
    pinned: !!item.pinned,
    featured: !!item.featured,
    visible: item.visible !== false,
});

// ---------------------------------------------------------------- import

/**
 * One entry, as a patch for the service.
 *
 * Only keys actually present in the file are included — see the note on
 * omission above. `image` and `photos` are plain URLs in the file because that
 * is what a person can type; the media objects around them are rebuilt here.
 */
const toPatch = (entry, existing) => {
    const patch = {};
    const has = (key) => Object.prototype.hasOwnProperty.call(entry, key);

    ['title', 'category', 'eventDate', 'location', 'caption', 'description'].forEach((key) => {
        if (has(key)) patch[key] = String(entry[key] ?? '');
    });

    if (has('highlights')) {
        patch.highlights = Array.isArray(entry.highlights)
            ? entry.highlights
            : String(entry.highlights || '').split('\n');
    }

    if (has('customFields')) {
        patch.customFields = (Array.isArray(entry.customFields) ? entry.customFields : [])
            .map(f => ({ label: String((f && f.label) || ''), value: String((f && f.value) || '') }))
            .filter(f => f.label || f.value);
    }

    if (has('image')) {
        // The existing alt and framing are kept: they are set in the CMS with a
        // preview in front of the editor, and a bulk text edit is not the place
        // to silently reset how a photograph sits in its frame.
        const before = (existing && existing.media) || {};
        patch.media = {
            url: String(entry.image || ''),
            alt: before.alt || entry.title || '',
            fit: before.fit || 'cover',
            position: before.position || 'center',
        };
    }

    if (has('photos')) {
        patch.photos = (Array.isArray(entry.photos) ? entry.photos : [])
            .map(url => String(url || '').trim())
            .filter(Boolean)
            .map(url => ({ url, alt: '', fit: 'cover', position: 'center' }));
    }

    ['showOnHome', 'pinned', 'featured', 'visible'].forEach((key) => {
        if (has(key)) patch[key] = !!entry[key];
    });

    return patch;
};

/** What changed, field by field, for the report. */
const changedFields = (patch, existing) => {
    if (!existing) return Object.keys(patch);

    return Object.keys(patch).filter((key) => {
        if (key === 'media') return (existing.media || {}).url !== patch.media.url;
        if (key === 'photos') {
            const before = (existing.photos || []).map(p => (p || {}).url).join('|');
            return before !== patch.photos.map(p => p.url).join('|');
        }
        if (key === 'highlights') return (existing.highlights || []).join('|') !== patch.highlights.join('|');
        if (key === 'customFields') {
            const shape = (list) => (list || []).map(f => `${(f && f.label) || ''}=${(f && f.value) || ''}`).join('|');
            return shape(existing.customFields) !== shape(patch.customFields);
        }
        if (key === 'showOnHome' || key === 'visible') return (existing[key] !== false) !== patch[key];
        if (key === 'featured' || key === 'pinned') return !!existing[key] !== patch[key];
        return (existing[key] || '') !== patch[key];
    });
};

// ---------------------------------------------------------------- main

async function main() {
    if (!EXPORT_TO && !IMPORT_FROM) {
        console.log('\nUsage:');
        console.log('  node scripts/gallery-content.js --export gallery.json');
        console.log('  node scripts/gallery-content.js --import gallery.json [--confirm]\n');
        process.exit(1);
    }

    await mongoose.connect(config.db.uri);
    // Opened before the models are required, so they bind to `adminsdb`.
    await adminsDb.ensureReady();

    const { GalleryItem } = require('../src/modules/cms/cms.models');
    const cms = require('../src/modules/cms/cms.service');
    const actor = { email: 'bulk-edit@activ.org.in' };

    // ---- export -----------------------------------------------------------

    if (EXPORT_TO) {
        const items = await GalleryItem.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
        const out = path.resolve(EXPORT_TO);
        fs.writeFileSync(out, JSON.stringify(items.map(toEntry), null, 2) + '\n', 'utf8');
        console.log(`\nWrote ${items.length} gallery item(s) to ${out}`);
        console.log('Edit the text, then: node scripts/gallery-content.js --import ' + EXPORT_TO + ' --confirm\n');
        await mongoose.disconnect();
        process.exit(0);
    }

    // ---- import -----------------------------------------------------------

    const source = path.resolve(IMPORT_FROM);
    if (!fs.existsSync(source)) {
        console.error(`\nNo such file: ${source}\n`);
        process.exit(1);
    }

    let entries;
    try {
        entries = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch (err) {
        // The common failure by far is a trailing comma or a smart quote pasted
        // from a word processor, and the parser's own message names the line.
        console.error(`\n${source} is not valid JSON:\n  ${err.message}\n`);
        process.exit(1);
    }

    if (!Array.isArray(entries)) {
        console.error('\nThe file must contain a JSON array of entries.\n');
        process.exit(1);
    }

    console.log(`\n=== Gallery import: ${path.basename(source)} ===`);
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: DRY RUN (pass --confirm to write)');
    console.log('');

    let created = 0, updated = 0, deleted = 0, unchanged = 0, failed = 0;

    for (const [index, entry] of entries.entries()) {
        const label = entry.title || entry.id || `entry ${index + 1}`;

        let existing = null;
        if (entry.id) existing = await GalleryItem.findById(entry.id).lean().catch(() => null);
        else if (entry.title) existing = await GalleryItem.findOne({ title: entry.title }).lean().catch(() => null);

        // ---- delete
        if (entry.delete) {
            if (!existing) { console.log(`  skip    ${label} — nothing to delete`); continue; }
            console.log(`  ${CONFIRM ? 'DELETE ' : 'WOULD DELETE'} ${label}`);
            if (CONFIRM) await cms.deleteGalleryItem(String(existing._id));
            deleted++;
            continue;
        }

        const patch = toPatch(entry, existing);

        // ---- create
        if (!existing) {
            if (!patch.media || !patch.media.url) {
                console.log(`  FAIL    ${label} — a new item needs an "image" URL`);
                failed++;
                continue;
            }
            console.log(`  ${CONFIRM ? 'CREATE ' : 'would create'} ${label}`);
            if (CONFIRM) {
                await cms.addGalleryItem({
                    ...patch,
                    url: patch.media.url,
                    alt: patch.media.alt,
                    fit: patch.media.fit,
                    position: patch.media.position,
                }, actor);
            }
            created++;
            continue;
        }

        // ---- update
        const changed = changedFields(patch, existing);
        if (!changed.length) { unchanged++; continue; }

        console.log(`  ${CONFIRM ? 'UPDATE ' : 'would update'} ${label} — ${changed.join(', ')}`);
        if (CONFIRM) await cms.updateGalleryItem(String(existing._id), patch, actor);
        updated++;
    }

    console.log(`\n  ${created} created, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged`
        + (failed ? `, ${failed} failed` : ''));

    if (!CONFIRM) console.log('\nNothing was written. Re-run with --confirm.');
    else console.log('\nDone. The site renders this immediately.');

    await mongoose.disconnect();
    // `adminsDb` exposes no close: the process exits below, which drops it.
    process.exit(0);
}

main().catch((err) => {
    console.error('\nFailed:', err && err.message);
    process.exit(1);
});
