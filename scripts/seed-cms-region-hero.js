/**
 * Adds the hero and vision bands to pages that were created before those
 * fields existed — without touching anything else on them.
 *
 * =========================================================================
 * A TOP-UP, NOT A RE-SEED
 * =========================================================================
 *
 * `--force` on the main seed would give these pages their hero and throw away
 * every word an editor had written. This writes ONLY the keys that are still
 * empty, through the same service the CMS screen posts to — which treats an
 * absent key as untouched.
 *
 * Safe to run repeatedly: a page that already has a headline is skipped.
 *
 *   node scripts/seed-cms-region-hero.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const HERO_IMAGE = 'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?auto=format&fit=crop&q=80';

const FEATURES = [
    { icon: 'factory', label: 'Industrial Growth' },
    { icon: 'users', label: 'Skilled Workforce' },
    { icon: 'globe', label: 'Global Trade' },
    { icon: 'leaf', label: 'Sustainable Future' },
];

const PILLARS = [
    { icon: 'factory', label: 'Stronger Industry' },
    { icon: 'users', label: 'Inclusive Growth' },
    { icon: 'globe', label: 'Global Competitiveness' },
    { icon: 'leaf', label: 'Sustainable Future' },
];

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const service = require('../src/modules/cms/cms.regionPages.service');
    /*
 * THE FIVE ABOVE THE STATES ARE ZONES.
 *
 * "Region" is the word for the tier INSIDE a state — Tamil Nadu's own North,
 * West, Central and South, each covering a handful of its districts. The five
 * that sit between the country and the states are ZONES, and every surface
 * says so: the header menu, the footer, the CMS, the zone pages' own benches.
 *
 * The copy this script writes did not, which is why live zone pages read
 * "ACTIV South Region" under a heading saying "South Zone Leaders".
 *
 * A row this script has ALREADY written keeps its old wording — seeding only
 * fills what is absent. `node scripts/rename-region-to-zone.js` is what
 * corrects those.
 */
const { RegionPage, StatePage } = require('../src/modules/cms/cms.models');
    const { REGIONS } = require('../src/modules/cms/cms.regionMap');

    let touched = 0;
    let skipped = 0;

    /* ------------------------------------------------------------ regions */

    for (const region of REGIONS) {
        const doc = await RegionPage.findOne({ regionKey: region.key }).lean();
        if (!doc) continue;
        if (doc.hero && doc.hero.headline) { skipped += 1; continue; }

        await service.saveRegionPage(region.key, {
            hero: {
                eyebrow: 'Industry · Innovation · Growth',
                headline: `ACTIV ${doc.regionName || region.label} Zone`,
                tagline: `${region.states.length} states and union territories, one council`,
                blurb: doc.shortDescription || '',
                backgroundUrl: HERO_IMAGE,
                features: FEATURES,
            },
            vision: {
                title: `Our vision for the ${doc.regionName || region.label} Zone`,
                text: 'Template text — replace it with the council’s own statement.',
                pillars: PILLARS,
            },
        }, { email: 'seed:cms-regions' });
        touched += 1;
    }

    /* ------------------------------------------------------------- states */

    const states = await StatePage.find({}).lean();
    for (const doc of states) {
        if (doc.hero && doc.hero.headline) { skipped += 1; continue; }

        await service.saveStatePage(doc.slug, {
            hero: {
                eyebrow: 'Industry · Innovation · Growth',
                headline: doc.stateName,
                tagline: 'A hub of enterprise, heritage and growth',
                blurb: doc.shortDescription || '',
                backgroundUrl: HERO_IMAGE,
                features: FEATURES,
            },
            vision: {
                title: `Our vision for ${doc.stateName}`,
                text: 'Template text — replace it with the council’s own statement.',
                pillars: PILLARS,
            },
            consultingIntro: doc.consultingIntro
                || 'Expert guidance for a stronger and more competitive enterprise.',
            consultingCta: (doc.consultingCta && doc.consultingCta.label)
                ? doc.consultingCta
                : { label: 'Explore our services', href: '/contact' },
        }, { email: 'seed:cms-regions' });
        touched += 1;
    }

    console.log(`hero and vision added to ${touched} pages, ${skipped} already had one`);
    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
