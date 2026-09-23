/**
 * Take the two banner buttons off the onboarding landing page.
 *
 * The seed shipped "Donate Now" (pointing at `#`) and "Learn More", so every
 * database seeded before this change is carrying them whatever the seed file
 * now says. `seed-cms-content.js` only fills fields that are absent, which is
 * the right rule for a seed and the reason it cannot undo this one.
 *
 * This clears the four fields — nothing else on the banner is touched, and the
 * headline, sub-headline, slides and highlight card are left exactly as they
 * are. `CarouselSection` hides a button whose label is blank, so clearing the
 * label is all that removing them means. Both stay editable in
 * CMS -> Home -> Banner -> Buttons; typing a label brings the button back.
 *
 *   node scripts/clear-hero-cta-labels.js            # report only
 *   node scripts/clear-hero-cta-labels.js --confirm  # apply
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    const apply = process.argv.includes('--confirm');
    /*
     * `adminsdb`, not `activ-db`.
     *
     * `cms.models.js` registers itself on the `adminsDb` connection, so every
     * `web_*` collection lives there. Connecting to the URI as written finds an
     * empty database and reports "nothing to do" while the site keeps serving
     * the buttons — so the same rewrite `adminsDb.js` performs is done here.
     */
    const { uri } = require('../src/modules/admin/adminsDb');
    if (!uri) { console.error('No database URI in the environment.'); process.exit(1); }

    await mongoose.connect(uri);
    const col = mongoose.connection.collection('web_home');

    const docs = await col.find({}).toArray();
    if (!docs.length) { console.log('web_home is empty — nothing to do.'); await mongoose.disconnect(); return; }

    for (const doc of docs) {
        const c = doc.carousel || {};
        console.log(`\n${doc._id}`);
        console.log(`  primary  : ${JSON.stringify(c.ctaLabel || '')} -> ""  (${JSON.stringify(c.ctaHref || '')} -> "")`);
        console.log(`  secondary: ${JSON.stringify(c.secondaryCtaLabel || '')} -> ""  (${JSON.stringify(c.secondaryCtaHref || '')} -> "")`);
    }

    if (!apply) { console.log('\nDry run. Re-run with --confirm to apply.'); await mongoose.disconnect(); return; }

    const res = await col.updateMany({}, {
        $set: {
            'carousel.ctaLabel': '',
            'carousel.ctaHref': '',
            'carousel.secondaryCtaLabel': '',
            'carousel.secondaryCtaHref': '',
        },
    });
    console.log(`\nUpdated ${res.modifiedCount} document(s).`);
    await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
