/**
 * Say which site each existing event belongs to.
 *
 * `channel` separates the onboarding site's programme (`public`, authored in the
 * CMS) from the association's own (`members`, authored in the super admin's
 * Events screen and shown on member dashboards). Every event written before that
 * field existed carries neither, and the two are indistinguishable from the
 * outside — so the public listing had to guess, and guessing meant it either
 * hid the site's real programme or leaked a members-only one onto it.
 *
 * This ends the guessing. Once every row is marked, the public listing can
 * require `channel: 'public'` outright and anything unmarked — a row written by
 * an older build, a script, or a path nobody has thought about yet — stays OFF
 * the marketing site rather than landing on it. Fail closed, in the direction
 * that cannot embarrass anyone.
 *
 *   node scripts/backfill-event-channel.js            # report what would change
 *   node scripts/backfill-event-channel.js --confirm  # write it
 *
 * THE RULE, in the order it is asked:
 *
 *   1. A row that already names a channel is left exactly as it is.
 *   2. `audience: 'paid'` is members-only by definition — it was the mechanism
 *      that used to keep an event off the public site, so anything carrying it
 *      was posted as the association's own.
 *   3. A row aimed at a state, district or block is the association's: the
 *      public pages have no viewer to compare a region against, and targeting
 *      only ever meant "these members, where they are".
 *   4. Everything else is the site's current programme, and marking it `public`
 *      is what keeps the page it is already on looking the same tomorrow.
 *
 * Rule 4 is the one to know about. An untargeted, everyone-audience event posted
 * from the SUPER ADMIN screen before this shipped is indistinguishable from a
 * CMS one and will be marked `public`. There is no field that separates them —
 * open such an event in the super admin Events screen and save it, and it is
 * marked `members` correctly from then on.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');

const targeted = (event = {}) =>
    ['state', 'district', 'block'].some(field => String(event[field] || '').trim());

const channelFor = (event = {}) => {
    if (String(event.audience || '').toLowerCase() === 'paid') return 'members';
    if (targeted(event)) return 'members';
    return 'public';
};

async function main() {
    console.log('\n=== Event channel backfill ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: DRY RUN (pass --confirm to write)');

    await mongoose.connect(config.db.uri);
    // Opened before the models are required; the CMS models bind to `adminsdb`.
    await adminsDb.ensureReady();

    const Event = require('../src/modules/events/event.model');

    const unmarked = await Event.find({
        $or: [{ channel: { $exists: false } }, { channel: null }, { channel: '' }]
    }).select('title audience state district block').lean();

    if (!unmarked.length) {
        console.log('\nEvery event already names a channel. Nothing to do.\n');
        await mongoose.disconnect();
        process.exit(0);
    }

    console.log(`\n${unmarked.length} event(s) carry no channel:\n`);

    const buckets = { public: [], members: [] };
    unmarked.forEach((event) => {
        buckets[channelFor(event)].push(event);
    });

    const show = (channel, why) => {
        const rows = buckets[channel];
        if (!rows.length) return;
        console.log(`  -> ${channel} (${why})`);
        rows.forEach(e => console.log(`       ${String(e.title || '(untitled)').slice(0, 50)}`));
    };

    show('members', 'members-only, or aimed at a region');
    show('public', 'the site\'s current programme');

    if (CONFIRM) {
        for (const [channel, rows] of Object.entries(buckets)) {
            if (!rows.length) continue;
            const result = await Event.updateMany(
                { _id: { $in: rows.map(r => r._id) } },
                { $set: { channel } }
            );
            console.log(`\n  WROTE channel='${channel}' on ${result.modifiedCount} event(s)`);
        }
        console.log('\nDone. The public site now shows only events marked `public`.');
        console.log('Anything posted from the super admin screen before today and still');
        console.log('appearing publicly: open it there and press Save.\n');
    } else {
        console.log('\nNothing was written. Re-run with --confirm.\n');
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nFailed:', err && err.message);
    process.exit(1);
});
