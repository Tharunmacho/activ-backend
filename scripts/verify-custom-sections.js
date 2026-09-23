/**
 * End-to-end proof that a section an editor invents survives the round trip.
 *
 * =========================================================================
 * THROUGH THE SERVICE, NOT AROUND IT
 * =========================================================================
 *
 * It calls `saveStatePage` / `saveRegionPage` — the exact functions the CMS's
 * HTTP routes call once a request is authenticated — so the sanitiser, the
 * de-duplication of keys, the enum on `layout` and the mapper are all exercised.
 * A script that wrote the document with `updateOne` would prove only that Mongo
 * accepts objects.
 *
 * It runs create -> read -> update -> read -> delete -> read, and asserts at
 * every step. Whatever it creates, it removes: the page is left exactly as it
 * was found.
 *
 *   node scripts/verify-custom-sections.js
 *   node scripts/verify-custom-sections.js --keep   # leave the example behind
 */
require('dotenv').config();
const mongoose = require('mongoose');

const KEEP = process.argv.includes('--keep');
const SLUG = 'tamil-nadu';

const ok = (label, condition, detail = '') => {
    console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) process.exitCode = 1;
};

const main = async() => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const { ensureReady } = require('../src/modules/admin/adminsDb');
    await ensureReady();

    const service = require('../src/modules/cms/cms.regionPages.service');
    const actor = { email: 'verify-script@local' };

    const before = await service.getStatePage(SLUG, { includeDrafts: true });
    const original = (before.customSections || []).map((row) => ({
        key: row.key,
        title: row.title,
        icon: row.icon,
        layout: row.layout,
        intro: row.intro,
        text: row.text,
        items: row.items,
        displayOrder: row.displayOrder,
    }));
    console.log(`\nTamil Nadu had ${original.length} custom section(s) before this run\n`);

    /* ------------------------------------------------------------ create */
    const created = await service.saveStatePage(SLUG, {
        customSections: [
            ...original,
            {
                title: 'Scholarships & Grants',
                icon: 'graduation-cap',
                layout: 'tiles',
                intro: 'What the council funds, and who may apply.',
                items: [
                    {
                        title: 'Apprentice tuition grant',
                        summary: 'Covers the assessment fee for candidates from member districts.',
                        body: 'Applications open twice a year and are decided by the skills '
                            + 'working group within six weeks.',
                        date: 'Applications open Nov 2026',
                        location: 'Statewide',
                        imageUrl: 'https://images.unsplash.com/photo-1523580494863-6f3031224c94'
                            + '?auto=format&fit=crop&q=80',
                        category: 'Skills',
                    },
                    {
                        title: 'Women in Manufacturing scholarship',
                        summary: 'Ten places a year on the diploma programme.',
                        imageUrl: 'https://images.unsplash.com/photo-1581092160562-40aa08e78837'
                            + '?auto=format&fit=crop&q=80',
                        category: 'Skills',
                    },
                ],
            },
            /* Deliberately the SAME title twice: the two must not end up sharing
               a key, or the second section's screen would be unreachable. */
            {
                title: 'Scholarships & Grants',
                icon: 'award',
                layout: 'list',
                items: [{ title: 'Duplicate-title check' }],
            },
            /* And a layout the site cannot draw, which must fall back. */
            {
                title: 'Bad layout check',
                layout: 'fancy',
                items: [{ title: 'Falls back to a list' }],
            },
        ],
    }, actor);

    const mine = created.customSections.slice(original.length);
    ok('created three sections', mine.length === 3, `got ${mine.length}`);
    ok('key derived from the title', mine[0].key === 'scholarships-grants', mine[0].key);
    ok('duplicate title gets its own key', mine[1].key !== mine[0].key,
        `${mine[0].key} vs ${mine[1].key}`);
    ok('unknown layout falls back to list', mine[2].layout === 'list', mine[2].layout);
    ok('items survive with every field', mine[0].items.length === 2
        && !!mine[0].items[0].body && !!mine[0].items[0].imageUrl
        && mine[0].items[0].category === 'Skills');

    /* -------------------------------------------------------------- read */
    const publicRead = await service.getStatePage(SLUG);
    const readBack = publicRead.customSections.find((row) => row.key === 'scholarships-grants');
    ok('public read returns it', !!readBack);
    ok('layout and intro survive the read', readBack.layout === 'tiles'
        && readBack.intro.startsWith('What the council funds'));

    /* ------------------------------------------------------------ update */
    const renamed = await service.saveStatePage(SLUG, {
        customSections: created.customSections.map((row) => (row.key === 'scholarships-grants'
            ? { ...row, title: 'Scholarships', layout: 'figures', items: row.items.slice(0, 1) }
            : row)),
    }, actor);
    const after = renamed.customSections.find((row) => row.title === 'Scholarships');
    ok('renamed', !!after && after.title === 'Scholarships');
    ok('layout changed', !!after && after.layout === 'figures', after && after.layout);
    ok('items trimmed', !!after && after.items.length === 1);

    /* ---------------------------------------------- other sections untouched */
    const stillThere = await service.getStatePage(SLUG, { includeDrafts: true });
    ok('the rest of the page is untouched',
        stillThere.events.length === publicRead.events.length
        && stillThere.leaders.length === publicRead.leaders.length);

    /* ------------------------------------------------------------ delete */
    const kept = KEEP
        ? renamed.customSections.filter((row) => row.key !== 'scholarships-grants-2'
            && row.title !== 'Bad layout check')
        : original;
    const cleaned = await service.saveStatePage(SLUG, { customSections: kept }, actor);
    ok(KEEP ? 'test rows removed, example kept' : 'all test rows removed',
        cleaned.customSections.length === kept.length,
        `${cleaned.customSections.length} left`);

    /* ----------------------------------------------------- the region too */
    const region = await service.saveRegionPage('south', {
        customSections: [{
            title: 'Regional verification',
            layout: 'dated',
            items: [{ title: 'One row', date: 'Sep 2026' }],
        }],
    }, actor);
    ok('region pages take custom sections too',
        region.customSections.length === 1 && region.customSections[0].layout === 'dated');
    await service.saveRegionPage('south', { customSections: [] }, actor);
    const regionAfter = await service.getRegionPage('south', { includeDrafts: true });
    ok('region section removed', (regionAfter.customSections || []).length === 0);

    console.log('');
    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
