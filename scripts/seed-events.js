/**
 * Seed sample events so the events grid has something to render.
 *
 * These go into the platform's own `Event` collection — the same records the
 * member app reads, not a CMS-only copy. Publishing one puts it on the public
 * site and in front of signed-in members at once, which is the whole reason the
 * CMS reuses this model rather than keeping its own list.
 *
 *   node scripts/seed-events.js            # report what would be created
 *   node scripts/seed-events.js --confirm  # create them
 *   node scripts/seed-events.js --remove   # delete only what this script made
 *
 * Idempotent: events are matched on title, so a second run updates rather than
 * duplicating. `--remove` exists because sample data should be easy to take
 * back out once real events are entered.
 *
 * Dates are relative to the day it runs, not fixed. Seeded content with a
 * hardcoded date is upcoming for a month and then quietly becomes a page full
 * of history.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');

const CONFIRM = process.argv.includes('--confirm');
const REMOVE = process.argv.includes('--remove');

/** Marks a record as sample data, so `--remove` can find exactly these. */
const CREATED_BY = 'sample-seed@activ.org.in';

const days = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    // A sensible hour rather than whenever the script happened to run.
    d.setHours(10, 0, 0, 0);
    return d;
};

/**
 * `state`, `district` and `block` are left empty on purpose.
 *
 * Empty means "everywhere" — the event reaches every member regardless of
 * region. Naming a region here would hide these from most of the app while
 * still showing them on the public site, which is exactly the sort of
 * inconsistency the shared collection is meant to prevent.
 */
const EVENTS = [
    {
        title: 'SC/ST Entrepreneurs Integration Conference',
        description: 'A full-day conference bringing together entrepreneurs, investors and policymakers to strengthen the SC/ST business network across Tamil Nadu.',
        offsetDays: 12,
        durationHours: 8,
        venue: 'Chennai Trade Centre, Nandambakkam',
        bannerUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80',
    },
    {
        title: 'Business Integration Conclave',
        description: 'Vendor development, supply-chain introductions and one-to-one meetings between member businesses and corporate buyers.',
        offsetDays: 34,
        durationHours: 6,
        venue: 'Hosur SIPCOT Phase I, Hosur',
        bannerUrl: 'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80',
    },
    {
        title: 'Start-up Pitch Festival',
        description: 'Early-stage founders pitch to a panel of investors and mentors. Shortlisted teams receive follow-on handholding support.',
        offsetDays: 61,
        durationHours: 5,
        venue: 'IIT Madras Research Park, Chennai',
        bannerUrl: 'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80',
    },
    {
        title: 'Women Entrepreneurs Networking Meet',
        description: 'A networking session for women-led member businesses, with sessions on credit access and government procurement.',
        offsetDays: 88,
        durationHours: 4,
        venue: 'Taj Coromandel, Chennai',
        bannerUrl: 'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80',
    },
    {
        // Deliberately in the past: it proves the ordering puts forthcoming
        // events first and does not lead the page with history.
        title: 'Annual General Meeting 2026',
        description: 'The annual review of ACTIV activities, accounts and the year ahead.',
        offsetDays: -40,
        durationHours: 3,
        venue: 'ACTIV Head Office, Guindy, Chennai',
        bannerUrl: 'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&q=80',
    },
];

async function main() {
    console.log('\n=== Sample events ===');
    console.log(REMOVE ? 'Mode: REMOVE' : CONFIRM ? 'Mode: WRITE' : 'Mode: DRY RUN (pass --confirm to write)');

    await mongoose.connect(config.db.uri);
    const Event = require('../src/modules/events/event.model');

    // ---- remove --------------------------------------------------------------
    if (REMOVE) {
        const doomed = await Event.find({ createdBy: CREATED_BY }).lean();
        console.log(`\n  ${doomed.length} sample event(s) found`);
        doomed.forEach(e => console.log(`    - ${e.title}`));

        if (doomed.length) {
            const { deletedCount } = await Event.deleteMany({ createdBy: CREATED_BY });
            console.log(`\nRemoved ${deletedCount}. Real events were not touched.`);
        }

        await mongoose.disconnect();
        process.exit(0);
    }

    // ---- create or update ----------------------------------------------------
    console.log('');
    let created = 0;
    let updated = 0;

    for (const spec of EVENTS) {
        const startAt = days(spec.offsetDays);
        const endAt = new Date(startAt.getTime() + spec.durationHours * 3600 * 1000);
        const when = startAt.toISOString().slice(0, 10);
        const tense = spec.offsetDays >= 0 ? 'upcoming' : 'past    ';

        const existing = await Event.findOne({ title: spec.title }).lean();

        console.log(`  ${CONFIRM ? (existing ? 'UPDATE' : 'CREATE') : 'would ' + (existing ? 'update' : 'create')}`
            + `  [${tense}] ${when}  ${spec.title}`);

        if (!CONFIRM) continue;

        const doc = {
            title: spec.title,
            description: spec.description,
            startAt,
            endAt,
            venue: spec.venue,
            // Empty geography — see the note above.
            state: '',
            district: '',
            block: '',
            bannerUrl: spec.bannerUrl,
            // Published, or the grid would still be empty and the seed pointless.
            status: 'published',
            createdBy: CREATED_BY,
        };

        if (existing) {
            await Event.updateOne({ _id: existing._id }, { $set: doc });
            updated++;
        } else {
            await Event.create(doc);
            created++;
        }
    }

    if (CONFIRM) {
        const total = await Event.countDocuments({ status: 'published' });
        console.log(`\nDone. ${created} created, ${updated} updated.`);
        console.log(`${total} published event(s) now live on the site and in the app.`);
        console.log('Remove them later with:  node scripts/seed-events.js --remove');
    } else {
        console.log('\nNothing was written. Re-run with --confirm.');
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nSeed failed:', err && err.message);
    console.error(err);
    process.exit(1);
});
