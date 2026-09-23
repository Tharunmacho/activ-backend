/**
 * Seeds a handful of gallery photographs TAGGED with a state and a region.
 *
 * =========================================================================
 * SEPARATE FROM THE PAGE SEED, BECAUSE IT TOUCHES SOMEBODY ELSE'S COLLECTION
 * =========================================================================
 *
 * `seed-cms-regions.js` writes only the two collections the feature owns. This
 * one writes into `web_gallery`, which the gallery screen also uses — so it is
 * its own script, run deliberately, and every row it creates is stamped so
 * `--clear` can take exactly those rows back out and nothing else.
 *
 * It exists because the region and state pages each show a strip of
 * photographs, and a strip with nothing in it cannot be evaluated. The images
 * are the same public photographs the seeded events already use.
 *
 *   node scripts/seed-cms-region-gallery.js
 *   node scripts/seed-cms-region-gallery.js --clear
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CLEAR = process.argv.includes('--clear');
const SEED_MARK = 'seed:cms-region-gallery';

/* Stock photographs, the same ones the seeded events carry. */
const IMAGES = [
    'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1523580494863-6f3031224c94?auto=format&fit=crop&q=80',
];

const ROWS = [
    { state: 'Tamil Nadu', title: 'State council meeting, Chennai', category: 'Meetings', sector: 'Manufacturing' },
    { state: 'Tamil Nadu', title: 'Skills workshop for member companies', category: 'Workshops', sector: 'Skills' },
    { state: 'Tamil Nadu', title: 'Export readiness clinic', category: 'Workshops', sector: 'Export' },
    { state: 'Tamil Nadu', title: 'Annual dinner and awards', category: 'Awards', sector: 'Manufacturing' },
    { state: 'Delhi', title: 'Policy roundtable', category: 'Meetings', sector: 'Policy' },
    { state: 'Delhi', title: 'Member induction evening', category: 'Meetings', sector: 'Membership' },
    { state: 'Maharashtra', title: 'Industry visit, Pune', category: 'Visits', sector: 'Manufacturing' },
    { state: 'West Bengal', title: 'MSME finance seminar', category: 'Seminars', sector: 'Finance' },
    { state: 'Assam', title: 'North East trade meet', category: 'Meetings', sector: 'Export' },
];

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { GalleryItem } = require('../src/modules/cms/cms.models');
    const { findState } = require('../src/modules/cms/cms.regionMap');

    if (CLEAR) {
        const result = await GalleryItem.deleteMany({ 'customFields.value': SEED_MARK });
        console.log(`cleared ${result.deletedCount} seeded photographs`);
        await mongoose.disconnect();
        return;
    }

    let created = 0;
    let skipped = 0;

    for (let i = 0; i < ROWS.length; i += 1) {
        const row = ROWS[i];
        const state = findState(row.state);
        if (!state) { console.warn(`unknown state ${row.state}`); continue; }

        const exists = await GalleryItem.findOne({ title: row.title }).lean();
        if (exists) { skipped += 1; continue; }

        await GalleryItem.create({
            title: row.title,
            caption: 'Sample photograph — replace it in the CMS gallery.',
            media: {
                url: IMAGES[i % IMAGES.length],
                type: 'image',
                alt: row.title,
                fit: 'cover',
                position: 'center',
            },
            category: row.category,
            sector: row.sector,
            state: state.name,
            /* DERIVED, never asked for twice — a state and a region that
               disagree put one photograph in two galleries. */
            region: state.regionKey,
            visible: true,
            showOnHome: false,
            sortOrder: i + 1,
            customFields: [{ label: 'Created by', value: SEED_MARK }],
        });
        created += 1;
    }

    console.log(`gallery: ${created} photographs added, ${skipped} already there`);
    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
