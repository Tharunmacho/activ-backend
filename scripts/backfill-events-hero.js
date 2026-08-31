/**
 * Fill in the Events page's new hero fields on a site that is already live.
 *
 * `seed-cms-content.js` writes a whole section at once and skips any section
 * that already holds content, which is the right behaviour for a seed — an
 * admin who has rewritten the Events copy should not have the shipped strings
 * put back over it. But it also means the fields added alongside the redesigned
 * Events page (the hero lede and photograph, the figures, the filter chips, the
 * call-to-action strip) never reach a database seeded before they existed: the
 * document has a `heading`, so the seed leaves the whole thing alone.
 *
 * This fills ONLY the fields that are still empty, one at a time. Anything an
 * editor has already written — including a heading they have rephrased — is
 * left exactly as it is. Running it twice changes nothing the second time.
 *
 *   node scripts/backfill-events-hero.js            # report what would change
 *   node scripts/backfill-events-hero.js --confirm  # write it
 *
 * The one field it will rewrite is `heading`, and only when it still holds the
 * exact seeded string "Our Events & Conclaves". The hero renders the heading in
 * two halves so the tail can carry the accent colour, and a document from
 * before the split has the whole phrase in the first half — which would render
 * entirely in white with nothing highlighted. Matching on the exact old value
 * means a heading anyone has actually edited is never touched.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

const LEGACY_HEADING = 'Our Events & Conclaves';

/** The values a site seeded before the redesign is missing. */
const DEFAULTS = {
    headingHighlight: 'Events & Conclaves',
    lede: 'Discover impactful events, conclaves and programs designed to connect, '
        + 'empower and grow the SC/ST entrepreneurial community.',
    heroMedia: {
        url: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80',
        type: 'image',
        alt: 'An ACTIV conclave in session',
        fit: 'cover',
        position: 'center',
    },
    heroBadge: {
        enabled: true,
        icon: 'calendar-days',
        title: "Don't Miss Out!",
        subtitle: 'Be part of our next big event.',
    },
    stats: [
        { icon: 'calendar-days', value: '15+', label: 'Events Every Year' },
        { icon: 'users', value: '3K+', label: 'Participants' },
        { icon: 'map-pin', value: '20+', label: 'Cities Covered' },
        { icon: 'handshake', value: '100+', label: 'Partners' },
    ],
    searchPlaceholder: 'Search events...',
    categories: [
        { label: 'Conferences', icon: 'users' },
        { label: 'Workshops', icon: 'book-open' },
        { label: 'Networking', icon: 'grid' },
        { label: 'Exhibitions', icon: 'tent' },
        { label: 'Training', icon: 'mic' },
        { label: 'Webinars', icon: 'monitor-play' },
    ],
    emptyFilterText: 'No events match {query}. Try another filter.',
    banner: {
        enabled: true,
        icon: 'calendar-days',
        title: 'Have an Event to Share?',
        subtitle: 'Partner with us to create impactful experiences for the community.',
        ctaLabel: 'Partner With Us',
        ctaHref: '/contact',
    },
};

/** Empty for this purpose: absent, blank, an empty list, or a media with no url. */
const isBlank = (value) => {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') {
        // A media sub-document is empty when it points at nothing; a badge or
        // banner when it has no words in it.
        if ('url' in value) return !String(value.url || '').trim();
        return !['title', 'subtitle', 'ctaLabel'].some((k) => String(value[k] || '').trim());
    }
    return false;
};

async function main() {
    console.log('\n=== Events hero backfill ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: DRY RUN (pass --confirm to write)');

    // The CMS models live on `adminsdb`; opening that connection before they are
    // required is what binds them to it rather than to the default database.
    await mongoose.connect(config.db.uri);
    await adminsDb.ensureReady();

    const { SINGLETON_KEY, EventsSettings } = require('../src/modules/cms/cms.models');

    const doc = await EventsSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
    if (!doc) {
        console.log('\nNo events-settings document exists yet. Run seed-cms-content.js first.');
        await mongoose.disconnect();
        process.exit(0);
    }

    const update = {};

    if (String(doc.heading || '').trim() === LEGACY_HEADING) {
        update.heading = 'Our';
        console.log(`  heading             "${LEGACY_HEADING}" -> "Our" + highlight`);
    }

    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!isBlank(doc[key])) {
            console.log(`  SKIP ${key.padEnd(20)}already authored`);
            continue;
        }
        update[key] = value;
        const preview = Array.isArray(value)
            ? `${value.length} item(s)`
            : (typeof value === 'object' ? Object.values(value).find((v) => typeof v === 'string' && v) : value);
        console.log(`  SET  ${key.padEnd(20)}${String(preview).slice(0, 60)}`);
    }

    if (!Object.keys(update).length) {
        console.log('\nNothing to fill in — every field already has a value.');
        await mongoose.disconnect();
        process.exit(0);
    }

    if (CONFIRM) {
        await EventsSettings.updateOne({ key: SINGLETON_KEY }, { $set: update });
        console.log(`\nWrote ${Object.keys(update).length} field(s).`);
    } else {
        console.log(`\nNothing was written. Re-run with --confirm to set ${Object.keys(update).length} field(s).`);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nBackfill failed:', err && err.message);
    console.error(err);
    process.exit(1);
});
