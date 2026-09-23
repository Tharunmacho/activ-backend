/**
 * Seeds the Regions & States pages with a working template.
 *
 * =========================================================================
 * WHY DUMMY CONTENT IS PART OF THE FEATURE, NOT A SHORTCUT
 * =========================================================================
 *
 * An empty CMS section is a section nobody can evaluate. The association cannot
 * tell whether the layout works from five blank pages, and an editor opening the
 * Regions screen for the first time has nothing to copy the shape of. So every
 * region gets a page and one state per region gets a fully worked example: a
 * description, a carousel slot, two leaders, and a few rows in each feed.
 *
 * ---------------------------------------------------------------- the rules
 *
 * 1. IT NEVER OVERWRITES. `--force` aside, a page that already exists is left
 *    exactly as it is. An editor's afternoon of work must not be undone by
 *    somebody re-running a seed.
 *
 * 2. EVERY PAGE IS A DRAFT. Placeholder copy must not appear on the public site
 *    because a script ran. The editor publishes when the words are theirs.
 *
 * 3. THE TEXT SAYS IT IS A TEMPLATE. Every seeded sentence names itself as
 *    sample copy. Nothing reads as a fact about the association that somebody
 *    might leave in place by accident — this repository has already had to
 *    delete eighteen test rows that looked real.
 *
 * 4. IT TOUCHES TWO COLLECTIONS AND NO OTHERS: `web_region_pages` and
 *    `web_state_pages`. Not events, not members, not the admin region tree.
 *
 * Usage:
 *     node scripts/seed-cms-regions.js            # create what is missing
 *     node scripts/seed-cms-regions.js --force    # replace the seeded pages too
 *     node scripts/seed-cms-regions.js --clear    # remove ONLY seeded pages
 */
require('dotenv').config();
const mongoose = require('mongoose');

const FORCE = process.argv.includes('--force');
const CLEAR = process.argv.includes('--clear');
/*
 * Publishes the template pages so the section can be SEEN end to end.
 *
 * Off by default, because template copy reaching the public site because a
 * script ran is exactly the accident rule 3 exists to prevent. On for a demo,
 * where an unpublished page and a broken page look identical from the outside.
 */
const PUBLISH = process.argv.includes('--publish');

/** Stamped on every seeded page, so `--clear` can tell ours from theirs. */
const SEED_MARK = 'seed:cms-regions';

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { RegionPage, StatePage } = require('../src/modules/cms/cms.models');
    const { REGIONS, statesOf } = require('../src/modules/cms/cms.regionMap');

    if (CLEAR) {
        const a = await RegionPage.deleteMany({ 'extraFields.value': SEED_MARK });
        const b = await StatePage.deleteMany({ 'extraFields.value': SEED_MARK });
        console.log(`cleared ${a.deletedCount} region and ${b.deletedCount} state template pages`);
        await mongoose.disconnect();
        return;
    }

    /* ------------------------------------------------------- the templates */

    const stamp = [{ label: 'Created by', value: SEED_MARK }];

    /** A leadership pair, so the two-abreast panel can be judged. */
    const leaders = (where) => ([
        {
            name: 'Sample Name — replace me',
            designation: `Chairman, ACTIV ${where}`,
            organisation: 'Managing Director, Example Industries Pvt Ltd',
            bio: 'Sample biography. Replace this with two or three sentences '
                + 'about the office-bearer and the work they lead.',
            photoUrl: '',
            displayOrder: 1,
        },
        {
            name: 'Sample Name — replace me',
            designation: `Vice Chairman, ACTIV ${where}`,
            organisation: 'Director, Example Exports Ltd',
            bio: '',
            photoUrl: '',
            displayOrder: 2,
        },
    ]);

    /** A feed with three rows, so the clamp, the date line and Read All show. */
    const feed = (noun, count = 3) => Array.from({ length: count }, (_, i) => ({
        title: `Sample ${noun} ${i + 1} — replace me`,
        summary: `This is template text for a ${noun.toLowerCase()}. Replace it in `
            + 'the CMS with a sentence or two; the card clamps it to three lines '
            + 'and the full text appears on the item’s own page.',
        body: '',
        date: '',
        location: '',
        href: '',
        displayOrder: i + 1,
    }));

    /**
     * The achievements band.
     *
     * `title` is the figure and `summary` is what it counts, because that is how
     * the band reads on the page: a big number with a line under it. Sample
     * numbers are deliberately round and obviously invented.
     */
    const achievements = (where) => ([
        { title: '250+', summary: `Member companies across ${where} — sample figure, replace me`, displayOrder: 1 },
        { title: '40', summary: 'Events held in the last year — sample figure, replace me', displayOrder: 2 },
        { title: '18', summary: 'Policy submissions made — sample figure, replace me', displayOrder: 3 },
        { title: '5,000+', summary: 'People trained through skill programmes — sample figure, replace me', displayOrder: 4 },
    ]);

    /** One empty slide, so the carousel panel is visible and obviously fillable. */
    const carousel = () => ([{
        media: { url: '', type: 'image', alt: '', fit: 'cover', position: 'center' },
        caption: 'Sample caption — replace this with a line naming who is in the '
            + 'photograph and when it was taken.',
        displayOrder: 1,
    }]);

    const office = (where) => ({
        personName: 'Sample Name — replace me',
        designation: 'Senior Director',
        addressLines: ['Ground Floor, Example Building', 'Example Road'],
        city: where,
        state: where,
        country: 'India',
        pincode: '',
        email: '',
        phone: '',
        mapUrl: '',
    });

    /* --------------------------------------------------------- the regions */

    let created = 0;
    let skipped = 0;

    for (const region of REGIONS) {
        const existing = await RegionPage.findOne({ regionKey: region.key }).lean();
        if (existing && !FORCE) { skipped += 1; continue; }

        const states = statesOf(region.key).map((s) => s.name);
        await RegionPage.findOneAndUpdate(
            { regionKey: region.key },
            {
                $set: {
                    regionKey: region.key,
                    regionName: region.label,
                    shortDescription:
                        `ACTIV ${region.label} Zone covers ${states.slice(0, -1).join(', ')} `
                        + `and ${states[states.length - 1]}. This is template text — replace it `
                        + 'in the CMS with the association’s own description of the region, its '
                        + 'industries and its priorities.',
                    fullDescription:
                        'This is the longer description that opens when a reader presses Read '
                        + 'More. Replace it in the CMS. Paragraph breaks are kept exactly as '
                        + 'they are typed.',
                    heroCarousel: carousel(),
                    leaders: leaders(`${region.label} Zone`),
                    achievements: achievements(`the ${region.label} Zone`),
                    sectorUpdates: feed('sector update', 4),
                    newsUpdates: feed('news update', 3),
                    mediaReleases: feed('media release', 3),
                    speakInMedia: feed('media mention', 2),
                    relatedLinks: [],
                    contact: office(region.label),
                    seo: {
                        metaTitle: `ACTIV ${region.label} Zone`,
                        metaDescription: '',
                        ogImageUrl: '',
                    },
                    /* A DRAFT. Template copy must never reach the public site
                       because a script ran. */
                    status: PUBLISH ? 'published' : 'draft',
                    extraFields: stamp,
                },
            },
            { upsert: true, setDefaultsOnInsert: true },
        );
        created += 1;
    }

    /* ---------------------------------------------------------- the states */

    /*
     * One worked example per region rather than all thirty-six.
     *
     * Thirty-six template pages is thirty-six pages somebody has to delete or
     * fill in, and the CMS creates a state page on first save anyway. One per
     * region is enough to show the shape and to test the menu's two levels.
     */
    const SAMPLE_STATES = ['Tamil Nadu', 'Delhi', 'West Bengal', 'Maharashtra', 'Assam'];

    let statesCreated = 0;
    let statesSkipped = 0;

    for (const name of SAMPLE_STATES) {
        const { findState } = require('../src/modules/cms/cms.regionMap');
        const state = findState(name);
        if (!state) { console.warn(`skipped unknown state ${name}`); continue; }

        const existing = await StatePage.findOne({ slug: state.slug }).lean();
        if (existing && !FORCE) { statesSkipped += 1; continue; }

        await StatePage.findOneAndUpdate(
            { slug: state.slug },
            {
                $set: {
                    stateName: state.name,
                    slug: state.slug,
                    regionKey: state.regionKey,
                    shortDescription:
                        `${state.name} is part of the ACTIV ${state.regionLabel} Zone. This is `
                        + 'template text — replace it in the CMS with the association’s own '
                        + 'description of the state, its industry base and its priorities.',
                    fullDescription:
                        'Longer description, shown when a reader presses Read More. Replace '
                        + 'this in the CMS.',
                    heroCarousel: carousel(),
                    leaders: leaders(`${state.name} State Council`),
                    achievements: achievements(state.name),
                    events: feed('event', 4),
                    projects: feed('project', 3),
                    policyAdvocacy: feed('policy advocacy note', 3),
                    consultingServices: feed('consulting service', 2),
                    publications: feed('publication', 2),
                    mediaReleases: feed('media release', 2),
                    mediaCoverages: feed('media coverage', 2),
                    relatedLinks: [],
                    contact: office(state.name),
                    feedbackEnabled: true,
                    seo: {
                        metaTitle: `ACTIV ${state.name}`,
                        metaDescription: '',
                        ogImageUrl: '',
                    },
                    status: PUBLISH ? 'published' : 'draft',
                    extraFields: stamp,
                },
            },
            { upsert: true, setDefaultsOnInsert: true },
        );
        statesCreated += 1;
    }

    console.log(`region pages: ${created} written, ${skipped} left alone`);
    console.log(`state pages:  ${statesCreated} written, ${statesSkipped} left alone`);
    console.log(PUBLISH
        ? 'Seeded pages are PUBLISHED — they carry template copy, so replace the '
            + 'wording in the CMS or unpublish them.'
        : 'All seeded pages are DRAFTS. Publish them from the CMS once the '
            + 'wording is the association’s own.');

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
