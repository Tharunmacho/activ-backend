/**
 * Fills the Tamil Nadu state page up to the size a real council reaches.
 *
 * =========================================================================
 * WHY THIS EXISTS
 * =========================================================================
 *
 * Every list on the state page switches presentation on its own length: four
 * or fewer items open in a panel over the page, more than four open a screen of
 * their own, and the gallery pages at twenty-four. Tamil Nadu had exactly four
 * events, four projects, four publications and four photographs, so the
 * screens — the half of the behaviour that matters at real volume — could not
 * be seen at all.
 *
 * This is CONTENT, not fixtures: it writes what an editor would type, so the
 * page can be judged as it will look in use. Every row is replaceable from
 * CMS -> Regions & States, and `--clear` takes exactly these rows back out.
 *
 * ------------------------------------------------------------- what it writes
 *
 *   web_gallery       photographs tagged  state: 'Tamil Nadu', region: 'south'
 *   web_state_pages   the Tamil Nadu document's events / projects /
 *                     publications / policyAdvocacy / mediaReleases arrays
 *
 * Nothing else. No admin collection, no member collection, no event collection.
 *
 * ------------------------------------------------------------------ running
 *
 *   node scripts/seed-tn-showcase.js
 *   node scripts/seed-tn-showcase.js --clear
 *
 * It is idempotent: an item whose title is already on the page is left alone,
 * so running it twice adds nothing and overwrites nothing an editor has since
 * changed.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CLEAR = process.argv.includes('--clear');
const TRIM = process.argv.includes('--trim');
/**
 * How many rows a list is allowed to hold.
 *
 * Seven, because that is what the association asked for and because it is the
 * useful size: above four the card hands off to a screen of its own, and a
 * screen of seven is one tidy set rather than a scroll. The gallery obeys the
 * same number — thirty stock photographs of the same four rooms taught nobody
 * anything about the layout.
 */
const TARGET = 7;
const SEED_MARK = 'seed:tn-showcase';
const SLUG = 'tamil-nadu';
const STATE = 'Tamil Nadu';

/* Public photographs, as the existing seeds use. */
const IMAGES = [
    'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1515169067868-5387ec356754?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1511578314322-379afb476865?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1523580494863-6f3031224c94?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1517048676732-d65bc937f952?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1528605248644-14dd04022da1?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1581092160562-40aa08e78837?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&q=80',
];

/* ------------------------------------------------------------------ gallery */

const PHOTOS = [
    ['Executive committee meeting, Chennai', 'Meetings', 'Manufacturing', 'Chennai', 'Aug 2026'],
    ['District chapter launch, Coimbatore', 'Meetings', 'Membership', 'Coimbatore', 'Aug 2026'],
    ['Members at the Tamil Nadu Business Summit', 'Events', 'Manufacturing', 'Chennai', 'Sep 2026'],
    ['Panel on power tariffs for continuous-process units', 'Events', 'Energy', 'Chennai', 'Sep 2026'],
    ['Welding and fabrication batch, Hosur', 'Skills', 'Skills', 'Hosur', 'Jul 2026'],
    ['Placement day for the skills programme', 'Skills', 'Skills', 'Chennai', 'Jul 2026'],
    ['CNC operator training, Coimbatore', 'Skills', 'Manufacturing', 'Coimbatore', 'Jun 2026'],
    ['Export documentation clinic', 'Workshops', 'Export', 'Chennai', 'Jun 2026'],
    ['Buyer-seller meet with Sri Lankan importers', 'Workshops', 'Export', 'Chennai', 'May 2026'],
    ['Leather cluster visit, Ambur', 'Visits', 'Leather', 'Ambur', 'May 2026'],
    ['Textile unit visit, Tiruppur', 'Visits', 'Textiles', 'Tiruppur', 'Apr 2026'],
    ['Automotive component plant visit, Sriperumbudur', 'Visits', 'Automotive', 'Sriperumbudur', 'Apr 2026'],
    ['MSME credit clinic with bankers', 'Workshops', 'Finance', 'Madurai', 'Mar 2026'],
    ['Women entrepreneurs meet, Madurai', 'Events', 'Entrepreneurship', 'Madurai', 'Mar 2026'],
    ['Young entrepreneurs forum', 'Events', 'Entrepreneurship', 'Chennai', 'Feb 2026'],
    ['Rooftop solar briefing for member units', 'Workshops', 'Energy', 'Coimbatore', 'Feb 2026'],
    ['Effluent treatment walkthrough, Tiruppur', 'Visits', 'Sustainability', 'Tiruppur', 'Jan 2026'],
    ['Annual awards night', 'Awards', 'Manufacturing', 'Chennai', 'Jan 2026'],
    ['Lifetime achievement award presentation', 'Awards', 'Membership', 'Chennai', 'Jan 2026'],
    ['Memorandum signed with the state skill mission', 'Meetings', 'Skills', 'Chennai', 'Dec 2025'],
    ['Pre-budget consultation with the state government', 'Meetings', 'Policy', 'Chennai', 'Dec 2025'],
    ['Industrial safety workshop', 'Workshops', 'Manufacturing', 'Hosur', 'Nov 2025'],
    ['Digital adoption seminar for small units', 'Seminars', 'Technology', 'Salem', 'Nov 2025'],
    ['Logistics and warehousing seminar', 'Seminars', 'Logistics', 'Chennai', 'Oct 2025'],
    ['Trade delegation briefing', 'Meetings', 'Export', 'Chennai', 'Oct 2025'],
    ['Members at the national council meeting', 'Meetings', 'Membership', 'New Delhi', 'Sep 2025'],
];

/* --------------------------------------------------------- the page's lists */

const EVENTS = [
    {
        title: 'Tamil Nadu Manufacturing Conclave 2026',
        date: 'Oct 22, 2026',
        location: 'Chennai Trade Centre, Chennai',
        summary: 'A full day on capacity, automation and the state’s component supply chains.',
        body: 'Sessions on shop-floor automation, energy costs and the components '
            + 'supply chain, with a buyer-seller meet in the afternoon. Open to member '
            + 'companies and to two delegates from each district chapter.',
        imageUrl: IMAGES[0],
        category: 'Conclave',
    },
    {
        title: 'Export Readiness Clinic — Coimbatore',
        date: 'Oct 30, 2026',
        location: 'Coimbatore',
        summary: 'One-to-one clinics on documentation, incoterms and first-order pricing.',
        body: 'Members bring a live enquiry and leave with a costed quotation, the '
            + 'documentation checklist for their product line, and an introduction to a '
            + 'freight forwarder on the panel.',
        imageUrl: IMAGES[7],
        category: 'Clinic',
    },
    {
        title: 'MSME Credit Mela with Lead Banks',
        date: 'Nov 12, 2026',
        location: 'Madurai',
        summary: 'Bankers, guarantee schemes and members, in one room for a day.',
        body: 'Six banks and the guarantee corporation take applications on the spot. '
            + 'Members are asked to bring two years of returns and a one-page project note.',
        imageUrl: IMAGES[8],
        category: 'Finance',
    },
    {
        title: 'Skills Programme — Hosur Placement Day',
        date: 'Nov 26, 2026',
        location: 'Hosur',
        summary: 'The seventh placement day of the welding and CNC batches.',
        body: 'Eleven member companies interview on the day. Candidates come from the '
            + 'welding, CNC and industrial-electrical batches run with the state skill mission.',
        imageUrl: IMAGES[4],
        category: 'Skills',
    },
    {
        title: 'Women in Enterprise — Chennai Chapter',
        date: 'Dec 05, 2026',
        location: 'Chennai',
        summary: 'A market-access clinic for women-led member companies.',
        body: 'Buyers from three retail chains and two e-commerce platforms take '
            + 'introductions. Twenty places, allotted by the chapter committee.',
        imageUrl: IMAGES[9],
        category: 'Chapter',
    },
    {
        title: 'Energy Cost Workshop for Continuous-Process Units',
        date: 'Dec 18, 2026',
        location: 'Erode',
        summary: 'Tariff structure, open access and rooftop solar, worked through with numbers.',
        body: 'The council’s tariff submission is explained, followed by worked '
            + 'examples of open access and rooftop solar for units of different sizes.',
        imageUrl: IMAGES[5],
        category: 'Workshop',
    },
];

const PROJECTS = [
    {
        title: 'Tamil Nadu Skills Mission Partnership',
        summary: 'Welding, CNC and industrial-electrical batches placed with member companies.',
        body: 'Run with the state skill mission across Chennai, Coimbatore and Hosur. '
            + 'Two thousand trainees have been placed since the programme began, and the '
            + 'council pays the assessment fee for candidates from member districts.',
        imageUrl: IMAGES[4],
    },
    {
        title: 'Export Facilitation Desk',
        summary: 'A standing desk that takes a member from first enquiry to first shipment.',
        body: 'Documentation, incoterms, freight and payment terms, handled case by case. '
            + 'Members have reached first orders in eleven new markets through the desk.',
        imageUrl: IMAGES[11],
    },
    {
        title: 'Cluster Modernisation — Ambur and Ranipet',
        summary: 'Common facilities and effluent handling for the leather cluster.',
        body: 'A shared finishing facility and a joint effluent proposal prepared with '
            + 'the cluster association and submitted to the state industries department.',
        imageUrl: IMAGES[10],
    },
    {
        title: 'Green Manufacturing Initiative',
        summary: 'Energy audits and rooftop solar for small and medium units.',
        body: 'Subsidised audits for member units under 5 MW, followed by a vetted panel '
            + 'of installers and a template power-purchase agreement.',
        imageUrl: IMAGES[5],
    },
    {
        title: 'Digital Adoption for Small Units',
        summary: 'Inventory, invoicing and compliance software, installed and taught.',
        body: 'A two-visit programme: the first sets the system up, the second returns '
            + 'after a month to fix what the shop floor actually ran into.',
        imageUrl: IMAGES[6],
    },
    {
        title: 'Women Entrepreneurship Cell',
        summary: 'Mentoring, credit introductions and market access for women-led units.',
        body: 'Each enrolled company is paired with a member company in the same sector '
            + 'for a year, with quarterly reviews by the chapter committee.',
        imageUrl: IMAGES[9],
    },
];

const PUBLICATIONS = [
    {
        title: 'Tamil Nadu Industry Outlook 2026',
        date: 'Sep 2026',
        summary: 'Sector-by-sector reading of output, employment and investment.',
        imageUrl: IMAGES[2],
    },
    {
        title: 'Power Tariff Submission to the State Regulator',
        date: 'Aug 2026',
        summary: 'The council’s representation ahead of the tariff order.',
        imageUrl: IMAGES[5],
    },
    {
        title: 'Skills Programme — Annual Review',
        date: 'Jul 2026',
        summary: 'Placements, retention and what the shop floors asked for next.',
        imageUrl: IMAGES[4],
    },
    {
        title: 'Exporters’ Handbook — Second Edition',
        date: 'May 2026',
        summary: 'Documentation, incoterms and costing, written for a first-time exporter.',
        imageUrl: IMAGES[11],
    },
    {
        title: 'MSME Credit Guide',
        date: 'Mar 2026',
        summary: 'Schemes, guarantees and what a banker actually asks for.',
        imageUrl: IMAGES[8],
    },
];

const POLICY = [
    {
        title: 'Single-window clearance — follow-up note',
        summary: 'Prepared with three district chapters after the first year of the portal.',
        date: 'Aug 2026',
    },
    {
        title: 'Submission on freight corridor access for Hosur units',
        summary: 'Filed with the state transport department.',
        date: 'Jun 2026',
    },
];

const MEDIA = [
    {
        title: 'Council welcomes the skills mission partnership renewal',
        date: 'Aug 2026',
        summary: 'Statement on the renewal of the state skill mission agreement.',
    },
    {
        title: 'Statement on the revised industrial land allotment rules',
        date: 'Jun 2026',
        summary: 'The council’s reading of the revised allotment rules.',
    },
];

/* ------------------------------------------------------------------ helpers */

const feedItem = (row, order, extra = {}) => ({
    title: row.title,
    summary: row.summary || '',
    body: row.body || '',
    date: row.date || '',
    location: row.location || '',
    href: '',
    imageUrl: row.imageUrl || '',
    fileUrl: '',
    category: row.category || '',
    sector: row.sector || '',
    icon: row.icon || '',
    displayOrder: order,
    isFeatured: false,
    isHidden: false,
    ...extra,
});

/**
 * Appends the rows that are not already on the page, keeping what is there.
 *
 * By TITLE, because that is what an editor sees. An index-based merge would
 * duplicate everything the moment somebody reorders the list in the CMS.
 */
const append = (existing, rows, extra) => {
    const have = new Set((existing || []).map((row) => String(row.title || '').trim().toLowerCase()));
    const added = [];
    let order = (existing || []).length;
    rows.forEach((row) => {
        if (have.has(row.title.trim().toLowerCase())) return;
        /* Never past the ceiling: a list is seven rows, not everything this
           script happens to know about. */
        if (order >= TARGET) return;
        order += 1;
        added.push(feedItem(row, order, extra));
    });
    return added;
};

const titlesOf = (rows) => new Set(rows.map((row) => row.title.trim().toLowerCase()));

/** This script's photographs: the stamp, or the title, for rows predating it. */
const MINE = {
    $or: [
        { 'customFields.value': SEED_MARK },
        { title: { $in: PHOTOS.map((row) => row[0]) } },
    ],
};

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { ensureReady } = require('../src/modules/admin/adminsDb');
    await ensureReady();

    const { GalleryItem, StatePage } = require('../src/modules/cms/cms.models');

    const page = await StatePage.findOne({ slug: SLUG });
    if (!page) throw new Error(`no state page for ${SLUG} — run seed-cms-states-all.js first`);

    if (CLEAR) {
        const removed = await GalleryItem.deleteMany(MINE);

        const drop = (list, rows) => {
            const names = titlesOf(rows);
            return (list || []).filter((row) => !names.has(String(row.title || '').trim().toLowerCase()));
        };
        page.events = drop(page.events, EVENTS);
        page.projects = drop(page.projects, PROJECTS);
        page.publications = drop(page.publications, PUBLICATIONS);
        page.policyAdvocacy = drop(page.policyAdvocacy, POLICY);
        page.mediaReleases = drop(page.mediaReleases, MEDIA);
        await page.save();

        console.log(`cleared ${removed.deletedCount} photographs and the seeded list items`);
        await mongoose.disconnect();
        return;
    }

    if (TRIM) {
        /* photographs: keep the first TARGET, and only ever delete rows this
           script created — an editor's own upload is never touched. */
        const photos = await GalleryItem.find({ state: STATE }).sort({ sortOrder: 1 }).lean();
        const mine = new Set(PHOTOS.map((row) => row[0].trim().toLowerCase()));
        const surplus = photos.slice(TARGET).filter((row) => mine.has(
            String(row.title || '').trim().toLowerCase(),
        ));
        if (surplus.length) {
            await GalleryItem.deleteMany({ _id: { $in: surplus.map((row) => row._id) } });
        }

        const trim = (list, rows) => {
            const mine = titlesOf(rows);
            const out = list.slice();
            while (out.length > TARGET) {
                /* from the end, and only rows this script wrote */
                let i = out.length - 1;
                while (i >= 0 && !mine.has(String(out[i].title || '').trim().toLowerCase())) i -= 1;
                if (i < 0) break;
                out.splice(i, 1);
            }
            return out;
        };
        page.events = trim(page.events, EVENTS);
        page.projects = trim(page.projects, PROJECTS);
        page.publications = trim(page.publications, PUBLICATIONS);
        page.policyAdvocacy = trim(page.policyAdvocacy, POLICY);
        page.mediaReleases = trim(page.mediaReleases, MEDIA);
        await page.save();

        console.log(`trimmed: ${surplus.length} photographs removed, `
            + `${await GalleryItem.countDocuments({ state: STATE })} left`);
        ['events', 'projects', 'publications', 'policyAdvocacy', 'mediaReleases']
            .forEach((key) => console.log(`${key.padEnd(16)} ${page[key].length}`));
        await mongoose.disconnect();
        return;
    }

    /* ---------------------------------------------------------- photographs */
    let created = 0;
    let skipped = 0;
    const already = await GalleryItem.countDocuments({ state: STATE });
    for (let i = 0; i < PHOTOS.length && already + created < TARGET; i += 1) {
        const [title, category, sector, location, eventDate] = PHOTOS[i];
        const exists = await GalleryItem.findOne({ title }).lean();
        if (exists) { skipped += 1; continue; }

        await GalleryItem.create({
            title,
            caption: `${location} · ${eventDate}`,
            media: {
                url: IMAGES[i % IMAGES.length],
                type: 'image',
                alt: title,
                fit: 'cover',
                position: 'center',
            },
            category,
            sector,
            state: STATE,
            /* Derived from the state, never asked for twice — a state and a
               region that disagree put one photograph in two galleries. */
            region: 'south',
            location,
            eventDate,
            visible: true,
            showOnHome: false,
            sortOrder: 100 + i,
            /* `customFields`, which is what the gallery schema calls it.
               `extraFields` is not a path on this model, and Mongoose strict
               mode drops an unknown path silently — the stamp went nowhere and
               `--clear` then matched nothing. */
            customFields: [{ label: 'Created by', value: SEED_MARK }],
        });
        created += 1;
    }

    /* ------------------------------------------------------- the page lists */
    const before = {
        events: page.events.length,
        projects: page.projects.length,
        publications: page.publications.length,
        policyAdvocacy: page.policyAdvocacy.length,
        mediaReleases: page.mediaReleases.length,
    };

    page.events.push(...append(page.events, EVENTS));
    page.projects.push(...append(page.projects, PROJECTS));
    page.publications.push(...append(page.publications, PUBLICATIONS));
    page.policyAdvocacy.push(...append(page.policyAdvocacy, POLICY));
    page.mediaReleases.push(...append(page.mediaReleases, MEDIA));
    await page.save();

    console.log(`gallery: ${created} photographs added, ${skipped} already there`);
    Object.keys(before).forEach((key) => {
        console.log(`${key.padEnd(16)} ${before[key]} -> ${page[key].length}`);
    });

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
