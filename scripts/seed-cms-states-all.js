/**
 * Creates a page for EVERY state and union territory in the region map.
 *
 * =========================================================================
 * THIRTY-SIX PAGES, ONE TEMPLATE
 * =========================================================================
 *
 * `seed-cms-regions.js` writes the five regions and one worked example per
 * region. This writes the rest, so the Regions menu is complete on day one and
 * an editor's job is to replace words rather than to create pages.
 *
 * The same three rules apply, and the third is the one that matters most here:
 *
 *   1. IT NEVER OVERWRITES. A state that already has a page is left alone,
 *      `--force` aside. Running this twice is safe.
 *   2. EVERY PAGE IT CREATES IS A DRAFT unless `--publish` is given. Template
 *      copy must not reach the public site because a script ran.
 *   3. EVERY SENTENCE NAMES ITSELF AS A TEMPLATE. Thirty-six pages of
 *      plausible-sounding invented facts is thirty-six pages somebody
 *      eventually publishes by accident. Every line says "replace me", and the
 *      figures are round enough to be obviously placeholders.
 *
 * It writes `web_state_pages` and nothing else.
 *
 *   node scripts/seed-cms-states-all.js
 *   node scripts/seed-cms-states-all.js --publish
 *   node scripts/seed-cms-states-all.js --force --publish
 *   node scripts/seed-cms-states-all.js --clear     # removes ONLY seeded pages
 */
require('dotenv').config();
const mongoose = require('mongoose');

const FORCE = process.argv.includes('--force');
const CLEAR = process.argv.includes('--clear');
const PUBLISH = process.argv.includes('--publish');

const SEED_MARK = 'seed:cms-regions';

/*
 * Stock photographs, rotated so neighbouring states do not share a hero.
 *
 * Remote URLs rather than files in `uploads/`: a seed that copies nine images
 * into the upload directory leaves nine orphans behind when the pages are
 * replaced, and the media cleanup has no way to tell them from an editor's own.
 */
const HEROES = [
    'https://images.unsplash.com/photo-1524492412937-b28074a5d7da?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1587474260584-136574528ed5?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1466442929976-97f336a657be?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1477587458883-47145ed94245?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1548013146-72479768bada?auto=format&fit=crop&q=80',
];

const SLIDES = [
    'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80',
];

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { StatePage } = require('../src/modules/cms/cms.models');
    const { allStates } = require('../src/modules/cms/cms.regionMap');

    if (CLEAR) {
        const result = await StatePage.deleteMany({ 'extraFields.value': SEED_MARK });
        console.log(`cleared ${result.deletedCount} template state pages`);
        await mongoose.disconnect();
        return;
    }

    const states = allStates();
    let created = 0;
    let skipped = 0;

    for (let i = 0; i < states.length; i += 1) {
        const state = states[i];

        const existing = await StatePage.findOne({ slug: state.slug }).lean();
        if (existing && !FORCE) { skipped += 1; continue; }

        const hero = HEROES[i % HEROES.length];
        const item = (title, summary, order, extra = {}) => ({
            title, summary, displayOrder: order, ...extra,
        });

        await StatePage.findOneAndUpdate(
            { slug: state.slug },
            {
                $set: {
                    stateName: state.name,
                    slug: state.slug,
                    regionKey: state.regionKey,

                    hero: {
                        eyebrow: 'Industry · Innovation · Growth',
                        headline: state.name,
                        tagline: `A hub of enterprise in the ${state.regionLabel} region`,
                        blurb:
                            `Template text for ${state.name}. Replace it in the CMS with the `
                            + 'association’s own description of the state, its industry base and '
                            + 'the council’s priorities for the year.',
                        backgroundUrl: hero,
                        features: [
                            { icon: 'factory', label: 'Industrial Growth' },
                            { icon: 'users', label: 'Skilled Workforce' },
                            { icon: 'globe', label: 'Global Trade' },
                            { icon: 'leaf', label: 'Sustainable Future' },
                        ],
                    },

                    vision: {
                        title: `Our vision for ${state.name}`,
                        text:
                            'Template text — replace it with the council’s own statement of what '
                            + 'it is working towards.',
                        pillars: [
                            { icon: 'factory', label: 'Stronger Industry' },
                            { icon: 'users', label: 'Inclusive Growth' },
                            { icon: 'globe', label: 'Global Competitiveness' },
                            { icon: 'leaf', label: 'Sustainable Future' },
                        ],
                    },

                    shortDescription:
                        `${state.name} is part of the ACTIV ${state.regionLabel} Zone. This is `
                        + 'template text — replace it in the CMS.',
                    fullDescription:
                        'Longer description, shown when a reader presses Read More. Replace this '
                        + 'in the CMS.',

                    heroCarousel: [
                        {
                            media: {
                                url: SLIDES[i % SLIDES.length],
                                type: 'image',
                                alt: `${state.name} council meeting`,
                                fit: 'cover',
                                position: 'center',
                            },
                            caption: 'Sample caption — replace this with a line naming who is in '
                                + 'the photograph and when it was taken.',
                            displayOrder: 1,
                        },
                    ],

                    leaders: [
                        {
                            name: 'Sample Name — replace me',
                            role: 'Chairman',
                            designation: `Chairman, ACTIV ${state.name} State Council`,
                            organisation: 'Managing Director, Example Industries Pvt Ltd',
                            bio: 'Sample biography. Replace this with two or three sentences '
                                + 'about the office-bearer and the work they lead.',
                            displayOrder: 1,
                        },
                        {
                            name: 'Sample Name — replace me',
                            role: 'Vice Chairman',
                            designation: `Vice Chairman, ACTIV ${state.name} State Council`,
                            organisation: 'Director, Example Exports Ltd',
                            bio: '',
                            displayOrder: 2,
                        },
                    ],

                    achievements: [
                        item('2,000+', 'Registered members — sample figure, replace me', 1, { icon: 'users' }),
                        item('150+', 'Events conducted — sample figure, replace me', 2, { icon: 'calendar' }),
                        item('85+', 'Active committees — sample figure, replace me', 3, { icon: 'handshake' }),
                        item('50+', 'Partner organisations — sample figure, replace me', 4, { icon: 'building' }),
                    ],

                    events: [
                        item('Sample event 1 — replace me', 'Template text for an event. Replace it in the CMS.', 1, { location: state.name, imageUrl: SLIDES[0] }),
                        item('Sample event 2 — replace me', 'Template text for an event. Replace it in the CMS.', 2, { location: state.name, imageUrl: SLIDES[1] }),
                        item('Sample event 3 — replace me', 'Template text for an event. Replace it in the CMS.', 3, { location: state.name, imageUrl: SLIDES[2] }),
                        item('Sample event 4 — replace me', 'Template text for an event. Replace it in the CMS.', 4, { location: state.name, imageUrl: SLIDES[3] }),
                    ],

                    projects: [
                        item('Sample project 1 — replace me', 'Template text for a project.', 1, { imageUrl: SLIDES[1] }),
                        item('Sample project 2 — replace me', 'Template text for a project.', 2, { imageUrl: SLIDES[2] }),
                        item('Sample project 3 — replace me', 'Template text for a project.', 3, { imageUrl: SLIDES[3] }),
                        item('Sample project 4 — replace me', 'Template text for a project.', 4, { imageUrl: SLIDES[0] }),
                    ],

                    policyAdvocacy: [
                        item('Sample policy note 1 — replace me', 'Template text for a policy submission.', 1),
                        item('Sample policy note 2 — replace me', 'Template text for a policy submission.', 2),
                        item('Sample policy note 3 — replace me', 'Template text for a policy submission.', 3),
                    ],

                    consultingServices: [
                        item('Policy Advisory & Advocacy', 'Template text — replace me', 1, { icon: 'scale' }),
                        item('Business Consulting', 'Template text — replace me', 2, { icon: 'briefcase' }),
                        item('Sustainability & ESG', 'Template text — replace me', 3, { icon: 'leaf' }),
                        item('Market Entry & Global Trade', 'Template text — replace me', 4, { icon: 'globe' }),
                    ],
                    consultingIntro: 'Expert guidance for a stronger and more competitive enterprise.',
                    consultingCta: { label: 'Explore our services', href: '/contact' },

                    publications: [
                        item('Annual Report — replace me', 'Template publication.', 1, { imageUrl: SLIDES[2] }),
                        item('Economic Survey — replace me', 'Template publication.', 2, { imageUrl: SLIDES[3] }),
                        item('Investment Opportunities — replace me', 'Template publication.', 3, { imageUrl: SLIDES[0] }),
                    ],

                    mediaReleases: [
                        item('Sample media release 1 — replace me', '', 1),
                        item('Sample media release 2 — replace me', '', 2),
                    ],
                    mediaCoverages: [
                        item('Sample media coverage — replace me', '', 1),
                    ],

                    contact: {
                        personName: 'Sample Name — replace me',
                        designation: 'Director',
                        addressLines: ['Ground Floor, Example Building', 'Example Road'],
                        city: state.name,
                        state: state.name,
                        country: 'India',
                        pincode: '',
                        email: '',
                        phone: '',
                    },
                    feedbackEnabled: true,

                    seo: { metaTitle: `ACTIV ${state.name}`, metaDescription: '', ogImageUrl: '' },
                    status: PUBLISH ? 'published' : 'draft',
                    extraFields: [{ label: 'Created by', value: SEED_MARK }],
                },
            },
            { upsert: true, setDefaultsOnInsert: true },
        );
        created += 1;
    }

    console.log(`state pages: ${created} written, ${skipped} left alone (${states.length} in the map)`);
    console.log(PUBLISH
        ? 'Written as PUBLISHED — they carry template copy, so replace the wording or unpublish.'
        : 'Written as DRAFTS. Publish from the CMS when the wording is the association’s own.');

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
