/**
 * THE CHAIRMAN'S WORDS ON THE ABOUT PAGE.
 *
 * `AboutManager` has offered this card ("Section 4 — The chairman's words")
 * since it was written, `AboutBlock` has drawn it above Our Mission &
 * Objectives, and the server has stored and served it. The one thing missing
 * was the content: the stored `quote` is four empty strings, so the block had
 * nothing to draw and the page went straight from the split layout to the
 * objectives. Nothing removed it — it had never been written, here or in any
 * backup in this repository.
 *
 * This fills it, so the section exists on the page and the editor has
 * something on screen to correct. Every word is editable at
 * CMS -> About Us -> Section 4; nothing here is hardcoded into the site.
 *
 *   node scripts/seed-about-chairman.js            # report
 *   node scripts/seed-about-chairman.js --confirm  # write
 *   node scripts/seed-about-chairman.js --confirm --force
 *
 * WITHOUT `--force` IT WILL NOT TOUCH WORDS SOMEBODY HAS ALREADY TYPED.
 * The association is editing this database while this runs, and a seed that
 * overwrites a real quotation with a shipped one is the kind of help nobody
 * asked for.
 */

require('dotenv').config();
const adminsDb = require('../src/modules/admin/adminsDb');

const CONFIRM = process.argv.includes('--confirm');
const FORCE = process.argv.includes('--force');

const QUOTE = {
    text: '<p>ACTIV was founded on a simple conviction — that an entrepreneur’s '
        + 'community should never decide how far they can go. Every member who '
        + 'joins us joins a confederation built to open doors that were closed, '
        + 'and to keep them open for whoever comes next.</p>',
    author: '',
    role: 'National Chairman, ACTIV',
};

(async () => {
    /* The CMS models bind to `adminsdb` only once that connection is open —
       requiring the module first would bind them to the default database and
       write into the wrong place without complaining. */
    await adminsDb.ensureReady();
    const { About } = require('../src/modules/cms/cms.models');

    const doc = await About.findOne({}).lean();
    if (!doc) {
        console.log('No About document exists yet. Run seed-cms-content.js first.');
        process.exit(1);
    }

    const existing = String((doc.quote || {}).text || '').trim();
    if (existing && !FORCE) {
        console.log('The chairman’s words are already written. Nothing to do.');
        console.log('  ', existing.slice(0, 120));
        process.exit(0);
    }

    console.log(existing ? 'Would REPLACE the existing words (--force).' : 'Would write the chairman’s words.');
    console.log('   text  :', QUOTE.text.replace(/<[^>]+>/g, '').slice(0, 120), '…');
    console.log('   role  :', QUOTE.role);
    console.log('   author: (left blank — the CMS asks for the name)');

    if (!CONFIRM) {
        console.log('\nDry run. Re-run with --confirm to write it.');
        process.exit(0);
    }

    /*
     * The photo and the author are LEFT ALONE. A name is a fact about a person
     * and this script does not know it; inventing one would put a made-up
     * signature under a real association's statement. The card renders without
     * it, and the CMS asks for it.
     */
    await About.updateOne(
        { _id: doc._id },
        { $set: { 'quote.text': QUOTE.text, 'quote.role': QUOTE.role } },
    );
    console.log('\nWritten. Edit it at CMS -> About Us -> Section 4.');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
