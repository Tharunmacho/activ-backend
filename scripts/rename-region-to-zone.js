/**
 * =============================================================================
 * "SOUTH REGION" -> "SOUTH ZONE", IN THE COPY ALREADY ON THE RECORDS
 * =============================================================================
 *
 * The five tiers between the country and the states are ZONES. "Region" is the
 * word for the tier INSIDE a state — Tamil Nadu's own North, West, Central and
 * South, each covering a handful of its districts — and for nothing else.
 *
 * The code says so now: the header menu, the footer, the CMS, the zone pages'
 * own headings. The CONTENT does not, because it was written by the seed
 * scripts before the distinction existed, so a live zone page reads
 *
 *     ACTIV South Region                     <- the hero
 *     South Zone Leaders                     <- the heading under it
 *     Chairman, ACTIV South Region           <- every card on the bench
 *
 * Seeding cannot fix that: those scripts only fill what is absent, and these
 * fields are present. This does, and only this.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT WILL NOT TOUCH, and each exclusion is the point of the script
 * -----------------------------------------------------------------------------
 *
 *   - `stateRegions` ON A STATE PAGE. That IS a region — the tier below the
 *     state — and renaming it to "zone" would be the same error in the other
 *     direction. Only the ZONE pages' own copy and the state pages' references
 *     to the zone ABOVE them are rewritten.
 *   - Any word that is not one of the five zone names followed by "Region".
 *     "Regional office", "in the region", "Regional Transport Office" and a
 *     member's address are left exactly as typed. The pattern is anchored to
 *     the five labels.
 *   - `regionKey`, slugs, URLs and any other identifier. Only human-readable
 *     copy is rewritten; a slug is an address, and rewriting one breaks every
 *     link anybody has saved.
 *
 * -----------------------------------------------------------------------------
 * HOW TO RUN IT
 * -----------------------------------------------------------------------------
 *
 *     node scripts/rename-region-to-zone.js              # DRY RUN — prints every change
 *     node scripts/rename-region-to-zone.js --confirm    # writes them
 *
 * The dry run is the default and takes no flag, because the destructive form
 * of this script should be the one that needs a reason typed out.
 *
 * A JSON backup of every document it would touch is written to
 * `backups/region-to-zone-<timestamp>.json` BEFORE anything is written, on the
 * confirm path. Restoring is `mongoimport` of that file, or re-saving the
 * documents by hand — they are whole documents, not diffs.
 *
 * It is IDEMPOTENT. "South Zone" does not match the pattern, so a second run
 * reports nothing to do.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { ensureReady } = require('../src/modules/admin/adminsDb');
const { REGIONS } = require('../src/modules/cms/cms.regionMap');

const CONFIRM = process.argv.includes('--confirm');

/**
 * `South Region` -> `South Zone`, and nothing else.
 *
 * Built from the five labels rather than from the bare word, so "Regional
 * office" and "the region's members" survive untouched. Case-insensitive on
 * the label because copy says "SOUTH REGION" in an eyebrow and "South Region"
 * in a sentence; the replacement keeps whatever case the "Region" itself was
 * written in, so an upper-case heading stays upper-case.
 */
const LABELS = REGIONS.map((r) => r.label);
const ESCAPED = LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const PLACE = new RegExp(`\\b(${ESCAPED})(\\s+)(Region|REGION|region)\\b`, 'g');

/**
 * "Regional Chairman" -> "Zone Chairman", and the other tier-named offices.
 *
 * Only ever applied to a ZONE page's own bench and to a state page's reference
 * to the zone above it — never to `stateRegions`, where "Regional Chairman" is
 * the correct title for the correct tier.
 */
const OFFICE = /\bRegional(\s+)(Chairman|Chairperson|Secretary|Treasurer|Convenor|Co-ordinator|Coordinator|Director)\b/g;

const zoneCase = (word) => {
    if (word === 'REGION') return 'ZONE';
    if (word === 'region') return 'zone';
    return 'Zone';
};

const fixPlace = (value) => String(value).replace(PLACE, (_m, label, gap, word) => `${label}${gap}${zoneCase(word)}`);
const fixOffice = (value) => String(value).replace(OFFICE, (_m, gap, office) => `Zone${gap}${office}`);

/** Every string on a document, rewritten in place. Arrays and objects walked. */
const walk = (node, fix, hits, trail = '') => {
    if (typeof node === 'string') {
        const next = fix(node);
        if (next !== node) hits.push({ at: trail, from: node, to: next });
        return next;
    }
    if (Array.isArray(node)) return node.map((row, i) => walk(row, fix, hits, `${trail}[${i}]`));
    if (node && typeof node === 'object' && !(node instanceof Date) && !(node._bsontype)) {
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            /* Identifiers are addresses, not copy. Never rewritten. */
            const isId = /^(_id|id|slug|regionKey|key|url|href|photoUrl|imageUrl|applyUrl|documentUrl|email)$/i.test(key);
            out[key] = isId ? value : walk(value, fix, hits, trail ? `${trail}.${key}` : key);
        }
        return out;
    }
    return node;
};

(async () => {
    await ensureReady();
    const { RegionPage, StatePage } = require('../src/modules/cms/cms.models');

    const touched = [];
    const backup = [];

    /* ---------------------------------------------------- the zone pages -- */
    const zonePages = await RegionPage.find({}).lean();
    for (const doc of zonePages) {
        const hits = [];
        /* A zone page holds no state's own regions, so both rules apply to
           the whole document. `stateRegions` HERE is the zone's states. */
        const next = walk(walk(doc, fixPlace, hits), fixOffice, hits);
        if (!hits.length) continue;
        backup.push({ collection: 'region_pages', doc });
        touched.push({ model: RegionPage, id: doc._id, label: `zone page ${doc.regionKey}`, next, hits });
    }

    /* --------------------------------------------------- the state pages -- */
    const statePages = await StatePage.find({}).lean();
    for (const doc of statePages) {
        const hits = [];
        /*
         * ================================================================
         * TWO FIELDS ON A STATE PAGE ARE THE STATE'S OWN REGIONS
         * ================================================================
         *
         * `stateRegions` is the boards — Tamil Nadu's North, West, Central
         * and South. `regionContactGroups` is the SAME tier in Get in Touch,
         * one contact group per one of those regions. Both are held back
         * from both rules.
         *
         * `regionContactGroups` is the one the dry run caught, and it is the
         * trap this whole script is built around: a state's internal regions
         * carry the SAME five labels as the zones — North, South, East, West
         * — so "North Region" on Tamil Nadu's contact card looks identical
         * to "North Region" on the national page and means the opposite
         * thing. Nothing in the string says which; only the field it is in
         * does. On a ZONE or the NATIONAL page the same field is the tier
         * BELOW (states, zones) and is rewritten normally, which is why the
         * exclusion lives here and not in `walk`.
         *
         * Everything else on the page — the hero tagline, the description,
         * the state bench, the districts, the SEO — refers to the zone the
         * state belongs to, and is rewritten.
         */
        const { stateRegions, regionContactGroups, ...rest } = doc;
        const next = {
            ...walk(walk(rest, fixPlace, hits), fixOffice, hits),
            stateRegions,
            regionContactGroups,
        };
        if (!hits.length) continue;
        backup.push({ collection: 'state_pages', doc });
        touched.push({ model: StatePage, id: doc._id, label: `state page ${doc.slug}`, next, hits });
    }

    /* ------------------------------------------------------------ report -- */
    let changes = 0;
    for (const row of touched) {
        console.log(`\n${row.label}`);
        for (const hit of row.hits) {
            changes += 1;
            console.log(`   ${hit.at}`);
            console.log(`     - ${hit.from.replace(/\s+/g, ' ').slice(0, 120)}`);
            console.log(`     + ${hit.to.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`${touched.length} document(s), ${changes} string(s) would change`);
    console.log('='.repeat(70));

    if (!touched.length) { console.log('Nothing to do.'); await mongoose.disconnect(); process.exit(0); }

    if (!CONFIRM) {
        console.log('\nDRY RUN — nothing was written. Re-run with --confirm to apply.');
        await mongoose.disconnect();
        process.exit(0);
    }

    /* The backup goes to disk BEFORE the first write, not after the last. */
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `region-to-zone-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\nBackup written: ${file}`);

    for (const row of touched) {
        const { _id, ...fields } = row.next;
        await row.model.updateOne({ _id: row.id }, { $set: fields });
        console.log(`  updated ${row.label}`);
    }

    console.log(`\nDone. ${touched.length} document(s) updated.`);
    await mongoose.disconnect();
    process.exit(0);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
