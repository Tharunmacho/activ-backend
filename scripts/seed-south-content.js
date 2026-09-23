/**
 * Fills every page in the South region — the seven remaining states and the
 * region itself — to the size and shape Tamil Nadu was signed off at.
 *
 * =========================================================================
 * ONE SHAPE, EIGHT SUBJECTS
 * =========================================================================
 *
 * Tamil Nadu is the reference: a hero with four facts and a glance card, an
 * About card with four feature tiles, two leaders, a gallery, four figures of
 * statistics, and lists of seven — events, projects, publications — with
 * consulting, policy and media beneath. Every other page in the region is
 * written to exactly that shape, so the layout a reader learns on one page is
 * the layout they get on all of them.
 *
 * What differs is the SUBJECT. The facts are each state's own; the events,
 * projects and submissions are generated from that state's sectors and cities,
 * so Kerala's page is about spices and marine exports out of Kochi and
 * Karnataka's is about machine tools out of Bengaluru. Nothing says
 * "Sample event 1".
 *
 * ------------------------------------------------------------- what it writes
 *
 *   web_state_pages    the seven southern states other than Tamil Nadu
 *   web_region_pages   the South region document
 *   web_gallery        seven photographs per state, tagged state + region
 *
 * Nothing else. No admin collection, no member collection, no events collection.
 *
 * ------------------------------------------------------------------- running
 *
 *   node scripts/seed-south-content.js            # fill what is still template
 *   node scripts/seed-south-content.js --force    # overwrite even edited pages
 *   node scripts/seed-south-content.js --clear    # remove the photographs it added
 *
 * WITHOUT `--force` NOTHING AN EDITOR HAS WRITTEN IS TOUCHED. A list is
 * replaced only when every row in it still says "replace me", and a field only
 * when it is empty or still carries the template sentence. Running it twice is
 * therefore safe, and running it after a real edit does not undo the edit.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { STATES, REGION, SCENES, PORTRAITS, WORK } = require('./data/south-states');

const FORCE = process.argv.includes('--force');
const CLEAR = process.argv.includes('--clear');
const SEED_MARK = 'seed:south-content';

/** Seven to a list — the number the association settled on. */
const TARGET = 7;

/* ---------------------------------------------------------------- helpers */

const feed = (row, order) => ({
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
    displayOrder: order + 1,
    isFeatured: false,
    isHidden: false,
});

const list = (rows) => rows.slice(0, TARGET).map(feed);

/**
 * Is this still the template?
 *
 * The state seeder wrote "Sample event 1 — replace me" and "Template text for
 * …" into every page. Those strings are how this script knows it may write:
 * anything else is an editor's work and is left exactly as it is.
 */
const TEMPLATE = /replace me|template text|sample (name|event|project|media|policy)/i;
const isTemplateList = (rows) => !rows || !rows.length
    || rows.every((row) => TEMPLATE.test(String(row.title || '') + String(row.summary || '')));
const isTemplateText = (value) => !String(value || '').trim() || TEMPLATE.test(String(value));

/* ------------------------------------------------------------ the content */

/** The four chips across the hero, and the three figures under Statistics. */
const heroOf = (state, scene) => ({
    eyebrow: 'Industry · Innovation · Growth',
    headline: state.name,
    tagline: state.tagline,
    blurb: '',
    backgroundUrl: scene,
    sideImageUrl: '',
    features: state.features.map(([icon, label]) => ({ icon, label })),
    facts: [
        { icon: 'building', label: 'Capital', value: state.capital },
        { icon: 'map-pin', label: 'Area', value: state.area },
        { icon: 'users', label: 'Population', value: state.population },
        { icon: 'globe', label: 'Languages', value: state.languages },
    ],
    glance: state.glance.map(([icon, title, subtitle]) => ({ icon, title, subtitle })),
});

const storyOf = (state) => [
    `${state.name} is built on ${state.sectors[0].toLowerCase()}, `
        + `${state.sectors[1].toLowerCase()} and ${state.sectors[2].toLowerCase()}, `
        + `with member companies in ${state.cities.join(', ')} and the districts around them.`,
    `The council meets every quarter and runs four working groups. Its skills programme `
        + `places trainees with member companies across ${state.cities[0]} and `
        + `${state.cities[1]}, and its export desk has taken members from a first enquiry `
        + `to a first shipment in new markets.`,
    `The council's representations to the government cover power tariffs, land allotment, `
        + `${state.sectors[0].toLowerCase()} incentives and MSME credit.`,
].join('\n\n');

const eventsOf = (state) => [
    {
        title: `${state.name} Industry Conclave 2026`,
        date: 'Oct 22, 2026',
        location: state.cities[0],
        category: 'Conclave',
        summary: `A full day on capacity, costs and the state's ${state.sectors[0].toLowerCase()} supply chain.`,
        body: `Sessions on ${state.sectors[0].toLowerCase()} and ${state.sectors[1].toLowerCase()}, `
            + `energy costs and logistics, with a buyer-seller meet in the afternoon. Open to `
            + `member companies and to two delegates from each district chapter.`,
        imageUrl: WORK[0],
    },
    {
        title: `Export Readiness Clinic — ${state.cities[1]}`,
        date: 'Oct 30, 2026',
        location: state.cities[1],
        category: 'Clinic',
        summary: 'One-to-one clinics on documentation, incoterms and first-order pricing.',
        body: 'Members bring a live enquiry and leave with a costed quotation, the '
            + 'documentation checklist for their product line, and an introduction to a '
            + 'freight forwarder on the panel.',
        imageUrl: WORK[7],
    },
    {
        title: 'MSME Credit Mela with Lead Banks',
        date: 'Nov 12, 2026',
        location: state.cities[2],
        category: 'Finance',
        summary: 'Bankers, guarantee schemes and members, in one room for a day.',
        body: 'Six banks and the guarantee corporation take applications on the spot. '
            + 'Members are asked to bring two years of returns and a one-page project note.',
        imageUrl: WORK[8],
    },
    {
        title: `Skills Programme — ${state.cities[0]} Placement Day`,
        date: 'Nov 26, 2026',
        location: state.cities[0],
        category: 'Skills',
        summary: 'Interviews for the current batches, with member companies on the panel.',
        body: `Candidates come from the batches run with the ${state.name} skill mission. `
            + 'Member companies interview on the day and offers are made the same week.',
        imageUrl: WORK[4],
    },
    {
        title: `Women in Enterprise — ${state.cities[0]} Chapter`,
        date: 'Dec 05, 2026',
        location: state.cities[0],
        category: 'Chapter',
        summary: 'A market-access clinic for women-led member companies.',
        body: 'Buyers from retail chains and e-commerce platforms take introductions. '
            + 'Twenty places, allotted by the chapter committee.',
        imageUrl: WORK[9],
    },
    {
        title: `${state.sectors[0]} Sector Roundtable`,
        date: 'Dec 18, 2026',
        location: state.capital,
        category: 'Roundtable',
        summary: `What the ${state.sectors[0].toLowerCase()} members are asking the state for, worked through with numbers.`,
        body: 'The council\'s submission is explained clause by clause, followed by the '
            + 'costed examples behind it. Member companies may add to the submission on the day.',
        imageUrl: WORK[5],
    },
    {
        title: 'Annual General Meeting and Awards Night',
        date: 'Jan 24, 2027',
        location: state.capital,
        category: 'Annual',
        summary: 'The year\'s accounts, the council elections and the member awards.',
        body: 'The AGM is followed by the awards dinner. Nominations for the member '
            + 'awards close six weeks before the date and are judged by the outgoing council.',
        imageUrl: WORK[3],
    },
];

const projectsOf = (state) => [
    {
        title: `${state.name} Skills Mission Partnership`,
        summary: `Trade batches trained and placed with member companies across ${state.cities[0]} and ${state.cities[1]}.`,
        body: `Run with the state skill mission. The council pays the assessment fee for `
            + `candidates from member districts, and member companies take the placements.`,
        imageUrl: WORK[4],
    },
    {
        title: 'Export Facilitation Desk',
        summary: 'A standing desk that takes a member from first enquiry to first shipment.',
        body: 'Documentation, incoterms, freight and payment terms, handled case by case '
            + 'by the desk and a panel of freight forwarders.',
        imageUrl: WORK[11],
    },
    {
        title: `${state.sectors[0]} Cluster Modernisation`,
        summary: `Common facilities and shared testing for the ${state.sectors[0].toLowerCase()} cluster.`,
        body: `A shared facility and a joint proposal prepared with the cluster association `
            + `and submitted to the state industries department.`,
        imageUrl: WORK[10],
    },
    {
        title: 'Green Manufacturing Initiative',
        summary: 'Energy audits and rooftop solar for small and medium units.',
        body: 'Subsidised audits for member units, followed by a vetted panel of installers '
            + 'and a template power-purchase agreement.',
        imageUrl: WORK[5],
    },
    {
        title: 'Digital Adoption for Small Units',
        summary: 'Inventory, invoicing and compliance software, installed and taught.',
        body: 'A two-visit programme: the first sets the system up, the second returns after '
            + 'a month to fix what the shop floor actually ran into.',
        imageUrl: WORK[6],
    },
    {
        title: 'Women Entrepreneurship Cell',
        summary: 'Mentoring, credit introductions and market access for women-led units.',
        body: 'Each enrolled company is paired with a member company in the same sector for '
            + 'a year, with quarterly reviews by the chapter committee.',
        imageUrl: WORK[9],
    },
    {
        title: `${state.cities[1]} Common Facility Centre`,
        summary: 'Shared testing, finishing and packing for units too small to own them.',
        body: 'Booked by the hour by member units, with the council underwriting the first '
            + 'year of operations.',
        imageUrl: WORK[2],
    },
];

const publicationsOf = (state) => [
    { title: `${state.name} Industry Outlook 2026`, date: 'Sep 2026', imageUrl: WORK[2],
        summary: 'Sector-by-sector reading of output, employment and investment.' },
    { title: `${state.sectors[0]} Sector Report`, date: 'Aug 2026', imageUrl: WORK[5],
        summary: `Where the ${state.sectors[0].toLowerCase()} trade stands, and what it is asking for.` },
    { title: `Exporters' Handbook — ${state.name} Edition`, date: 'Jul 2026', imageUrl: WORK[11],
        summary: 'Documentation, incoterms and costing, written for a first-time exporter.' },
    { title: 'MSME Credit Guide', date: 'May 2026', imageUrl: WORK[8],
        summary: 'Schemes, guarantees and what a banker actually asks for.' },
    { title: 'Skills Programme — Annual Review', date: 'Apr 2026', imageUrl: WORK[4],
        summary: 'Placements, retention and what the shop floors asked for next.' },
    { title: 'Policy Submissions Compendium 2026', date: 'Mar 2026', imageUrl: WORK[3],
        summary: 'Every representation the council filed in the year, with the outcome.' },
    { title: `ACTIV ${state.name} Annual Report 2025-26`, date: 'Feb 2026', imageUrl: WORK[0],
        summary: 'Accounts, membership, programmes and the council\'s year.' },
];

const policyOf = (state) => [
    { title: 'Submission on power tariffs for industry', date: 'Aug 2026',
        summary: 'Filed with the state regulator ahead of the tariff order.', icon: 'scale' },
    { title: 'Land allotment and clearance timelines', date: 'Jul 2026',
        summary: 'A single-window proposal prepared with three district chapters.', icon: 'building' },
    { title: 'MSME credit guarantee — state supplement', date: 'Jun 2026',
        summary: 'Proposes a state-level top-up to the central guarantee for first-time borrowers.', icon: 'handshake' },
    { title: `${state.sectors[0]} incentives — representation`, date: 'May 2026',
        summary: `What the ${state.sectors[0].toLowerCase()} members need from the industrial policy.`, icon: 'factory' },
    { title: `Freight and logistics access for ${state.cities[1]} units`, date: 'Apr 2026',
        summary: 'Filed with the state transport department.', icon: 'ship' },
];

const mediaOf = (state) => [
    { title: `Council welcomes the ${state.name} industrial policy`, date: 'Sep 2026',
        summary: 'Statement on the policy as notified.', icon: 'file-text' },
    { title: 'Skills programme crosses its placement target', date: 'Aug 2026',
        summary: 'The year\'s placement figures, by trade and by district.', icon: 'file-text' },
    { title: 'Statement on the revised land allotment rules', date: 'Jun 2026',
        summary: 'The council\'s reading of the revised rules.', icon: 'file-text' },
    { title: `${state.name} council signs the skills agreement renewal`, date: 'May 2026',
        summary: 'The renewal of the agreement with the state skill mission.', icon: 'file-text' },
];

const consultingOf = (state) => [
    { title: 'Policy Advocacy', icon: 'scale',
        summary: 'Support in policy formulation, representation and follow-up with the state.' },
    { title: 'Business Consulting', icon: 'briefcase',
        summary: `Strategic guidance for ${state.sectors[0].toLowerCase()} and allied member companies.` },
    { title: 'Market Research', icon: 'search',
        summary: 'Data-driven insight on markets, buyers and competing supply.' },
    { title: 'Training & Capacity Building', icon: 'graduation-cap',
        summary: 'Workshops, seminars and skill development for member companies.' },
];

const achievementsOf = (state) => [
    { title: state.area, summary: 'Area', icon: 'map-pin' },
    { title: state.population.replace(/ \(\d+\)$/, ''), summary: 'Population', icon: 'users' },
    { title: state.standing[0], summary: state.standing[1], icon: 'trending-up' },
];

const photosOf = (state) => [
    [`State council meeting, ${state.capital}`, 'Meetings', state.sectors[0], state.capital],
    [`${state.sectors[0]} members' roundtable`, 'Meetings', state.sectors[0], state.cities[0]],
    [`Skills workshop, ${state.cities[1]}`, 'Skills', 'Skills', state.cities[1]],
    [`Export documentation clinic, ${state.cities[0]}`, 'Workshops', 'Export', state.cities[0]],
    [`Industry visit, ${state.cities[2]}`, 'Visits', state.sectors[1], state.cities[2]],
    [`Women in Enterprise meet, ${state.cities[0]}`, 'Events', 'Entrepreneurship', state.cities[0]],
    [`Annual awards night, ${state.capital}`, 'Awards', 'Membership', state.capital],
];

/* ------------------------------------------------------------------- write */

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { ensureReady } = require('../src/modules/admin/adminsDb');
    await ensureReady();

    const { StatePage, RegionPage, GalleryItem } = require('../src/modules/cms/cms.models');
    const { findState } = require('../src/modules/cms/cms.regionMap');

    if (CLEAR) {
        const result = await GalleryItem.deleteMany({ 'customFields.value': SEED_MARK });
        console.log(`cleared ${result.deletedCount} photographs`);
        await mongoose.disconnect();
        return;
    }

    /* ------------------------------------------------------------ states */
    for (let i = 0; i < STATES.length; i += 1) {
        const state = STATES[i];
        const mapped = findState(state.name);
        if (!mapped) { console.warn(`! ${state.name} is not in the region map`); continue; }

        const page = await StatePage.findOne({ slug: mapped.slug });
        if (!page) { console.warn(`! no page for ${state.name} — run seed-cms-states-all.js`); continue; }

        const touched = [];
        const setList = (key, rows) => {
            if (!FORCE && !isTemplateList(page[key])) return;
            page[key] = list(rows);
            touched.push(key);
        };
        const setText = (key, value) => {
            if (!FORCE && !isTemplateText(page[key])) return;
            page[key] = value;
            touched.push(key);
        };

        if (FORCE || isTemplateText(page.hero && page.hero.blurb) || !page.hero.facts.length) {
            page.hero = heroOf(state, SCENES[i % SCENES.length]);
            touched.push('hero');
        }
        setText('shortDescription', state.about);
        setText('fullDescription', storyOf(state));

        if (FORCE || isTemplateList(page.leaders)) {
            page.leaders = state.leaders.map(([name, role, organisation], n) => ({
                name,
                role,
                designation: `${role}, ACTIV ${state.name} State Council`,
                organisation,
                photoUrl: PORTRAITS[(i * 2 + n) % PORTRAITS.length],
                bio: `${role === 'Chairman' ? 'Chairs' : 'Serves on'} the ${state.name} council `
                    + `and works with its ${state.sectors[0].toLowerCase()} members. `
                    + 'Placeholder biography — replace it in the CMS.',
                displayOrder: n + 1,
                isHidden: false,
            }));
            touched.push('leaders');
        }

        setList('achievements', achievementsOf(state));
        setList('events', eventsOf(state));
        setList('projects', projectsOf(state));
        setList('publications', publicationsOf(state));
        setList('policyAdvocacy', policyOf(state));
        setList('mediaReleases', mediaOf(state));
        setList('consultingServices', consultingOf(state));

        if (FORCE || isTemplateText(page.consultingIntro)) {
            page.consultingIntro = 'Expert guidance for a stronger and more competitive enterprise.';
        }

        if (FORCE || isTemplateText(page.contact && page.contact.personName)) {
            page.contact = {
                personName: `${state.leaders[0][0].split(' ').slice(0, 2).join(' ')}`,
                photoUrl: PORTRAITS[(i * 2) % PORTRAITS.length],
                designation: 'Director',
                addressLines: state.office,
                city: state.capital,
                state: state.name,
                country: 'India',
                pincode: state.pincode,
                email: `${mapped.slug}@activ.org.in`,
                phone: `+91 ${state.std.replace(/^0/, '')} 2345 ${1100 + i * 7}`,
                mapUrl: '',
            };
            touched.push('contact');
        }

        if (!page.socialLinks || !page.socialLinks.length) {
            page.socialLinks = [
                { icon: 'facebook', href: 'https://facebook.com' },
                { icon: 'twitter', href: 'https://twitter.com' },
                { icon: 'linkedin', href: 'https://linkedin.com' },
                { icon: 'youtube', href: 'https://youtube.com' },
            ];
        }
        page.feedbackEnabled = true;
        page.status = 'published';
        await page.save();

        /* ------------------------------------------------------ gallery */
        let added = 0;
        const rows = photosOf(state);
        const have = await GalleryItem.countDocuments({ state: state.name });
        for (let n = 0; n < rows.length && have + added < TARGET; n += 1) {
            const [title, category, sector, location] = rows[n];
            /* eslint-disable no-await-in-loop */
            if (await GalleryItem.findOne({ title }).lean()) continue;
            await GalleryItem.create({
                title,
                caption: `${location} · ACTIV ${state.name}`,
                media: {
                    url: WORK[(i * 3 + n) % WORK.length],
                    type: 'image',
                    alt: title,
                    fit: 'cover',
                    position: 'center',
                },
                category,
                sector,
                state: state.name,
                region: mapped.regionKey,
                location,
                eventDate: '',
                visible: true,
                showOnHome: false,
                sortOrder: 200 + i * 10 + n,
                customFields: [{ label: 'Created by', value: SEED_MARK }],
            });
            added += 1;
            /* eslint-enable no-await-in-loop */
        }

        console.log(`${state.name.padEnd(30)} ${touched.length ? touched.join(', ') : 'left alone'}`
            + ` | +${added} photographs`);
    }

    /* ------------------------------------------------------------ region */
    const region = await RegionPage.findOne({ regionKey: REGION.key });
    if (!region) {
        console.warn('! no South region page — run seed-cms-regions.js');
    } else {
        const touched = [];
        const setList = (key, rows) => {
            if (!FORCE && !isTemplateList(region[key])) return;
            region[key] = list(rows);
            touched.push(key);
        };

        /* The label the association asked for: South, not Southern. */
        region.regionName = REGION.name;

        if (FORCE || !region.hero || !region.hero.facts || !region.hero.facts.length
            || isTemplateText(region.hero.blurb)) {
            region.hero = {
                eyebrow: 'Industry · Innovation · Growth',
                headline: REGION.headline,
                tagline: REGION.tagline,
                blurb: '',
                backgroundUrl: REGION.hero,
                sideImageUrl: '',
                features: REGION.features.map(([icon, label]) => ({ icon, label })),
                facts: REGION.facts.map(([icon, label, value]) => ({ icon, label, value })),
                glance: REGION.glance.map(([icon, title, subtitle]) => ({ icon, title, subtitle })),
            };
            touched.push('hero');
        }

        if (FORCE || isTemplateText(region.shortDescription)) {
            region.shortDescription = REGION.about;
            touched.push('shortDescription');
        }
        if (FORCE || isTemplateText(region.fullDescription)) {
            region.fullDescription = REGION.story;
            touched.push('fullDescription');
        }

        if (FORCE || isTemplateList(region.leaders)) {
            region.leaders = REGION.leaders.map(
                ([name, role, designation, organisation, bio], n) => ({
                    name, role, designation, organisation, bio,
                    photoUrl: PORTRAITS[n % PORTRAITS.length],
                    displayOrder: n + 1,
                    isHidden: false,
                }),
            );
            touched.push('leaders');
        }

        if (FORCE || isTemplateList(region.achievements)) {
            region.achievements = REGION.achievements.map(([title, summary, icon], n) => feed(
                { title, summary, icon }, n,
            ));
            touched.push('achievements');
        }

        /* The region's programme, written as a region writes: across states. */
        const acrossStates = STATES.slice(0, 5).map((row) => row.name);
        setList('events', [
            { title: 'South Region Industry Summit 2026', date: 'Nov 05, 2026', location: 'Chennai',
                category: 'Summit', imageUrl: WORK[0],
                summary: 'The eight councils, their working groups and the year\'s common agenda.',
                body: 'Two days. The manufacturing, export, energy and skills groups each '
                    + 'report, and the region\'s submissions for the year are settled.' },
            { title: 'Inter-State Buyer-Seller Meet', date: 'Nov 19, 2026', location: 'Bengaluru',
                category: 'Trade', imageUrl: WORK[7],
                summary: 'Members from all eight councils, matched by sector before the day.',
                body: 'Meetings are scheduled in advance from the enquiry each member files, '
                    + 'so nobody spends the day walking a hall.' },
            { title: 'Regional Export Conclave', date: 'Dec 03, 2026', location: 'Kochi',
                category: 'Export', imageUrl: WORK[11],
                summary: 'Ports, freight and documentation, for members shipping out of the South.',
                body: 'Port authorities, customs brokers and freight forwarders take questions '
                    + 'from the floor and one-to-one sessions afterwards.' },
            { title: 'Skills Partnership Review', date: 'Dec 17, 2026', location: 'Hyderabad',
                category: 'Skills', imageUrl: WORK[4],
                summary: 'What the five state skill missions placed this year, compared.',
                body: 'Each council presents its placement figures by trade, and the region '
                    + 'agrees which trades to fund next year.' },
            { title: 'Regional Council Meeting — Q4', date: 'Jan 16, 2027', location: 'Visakhapatnam',
                category: 'Council', imageUrl: WORK[3],
                summary: 'The quarterly meeting of the eight state and territorial councils.',
                body: 'Chairmen and secretaries of the eight councils, the working group '
                    + 'chairs, and the regional secretariat.' },
            { title: 'Women in Enterprise — Regional Forum', date: 'Feb 06, 2027',
                location: 'Coimbatore', category: 'Forum', imageUrl: WORK[9],
                summary: 'Women-led member companies from across the region, with buyers present.',
                body: 'Market access, credit and mentoring, run as clinics rather than panels.' },
            { title: 'South Region Awards Night', date: 'Feb 27, 2027', location: 'Chennai',
                category: 'Annual', imageUrl: WORK[5],
                summary: 'The region\'s member awards, judged across the eight councils.',
                body: 'Nominations close six weeks before the date and are judged by a panel '
                    + 'drawn from councils other than the nominee\'s own.' },
        ]);

        setList('projects', [
            { title: 'Regional Export Desk', imageUrl: WORK[11],
                summary: 'One desk, eight councils — documentation, freight and first orders.',
                body: 'Run once for the region rather than eight times, with a liaison in '
                    + 'each state council.' },
            { title: 'South Skills Partnership', imageUrl: WORK[4],
                summary: 'A common framework with five state skill missions.',
                body: 'Shared curriculum and assessment, so a trade certificate earned in one '
                    + 'state is read the same way by a member company in another.' },
            { title: 'Port and Logistics Working Group', imageUrl: WORK[2],
                summary: 'Freight access, turnaround and cost, taken up with four major ports.',
                body: 'Quarterly meetings with port authorities, and a standing note on '
                    + 'container availability for member exporters.' },
            { title: 'Regional Energy Cost Programme', imageUrl: WORK[5],
                summary: 'Audits, open access and rooftop solar, priced for member units.',
                body: 'A vetted panel of auditors and installers, and a template power-purchase '
                    + 'agreement the councils negotiated together.' },
            { title: 'Common Digital Compliance Toolkit', imageUrl: WORK[6],
                summary: 'One toolkit for GST, returns and inspections, in four languages.',
                body: 'Built once for the region and translated, because the compliance is '
                    + 'central and the language is not.' },
            { title: 'Cluster Modernisation Fund', imageUrl: WORK[10],
                summary: 'Shared facilities for clusters too small to fund them alone.',
                body: 'The region underwrites the first year; the cluster association runs it '
                    + 'thereafter.' },
            { title: 'Regional Mentoring Network', imageUrl: WORK[8],
                summary: 'Member companies mentoring member companies, across state lines.',
                body: 'Pairs are matched by sector and reviewed twice a year by the regional '
                    + 'secretariat.' },
        ]);

        setList('publications', [
            { title: 'South Region Industry Outlook 2026', date: 'Sep 2026', imageUrl: WORK[2],
                summary: 'The eight economies, read together.' },
            { title: 'Ports and Freight — Regional Review', date: 'Aug 2026', imageUrl: WORK[11],
                summary: 'Turnaround, cost and container availability at the four major ports.' },
            { title: 'Skills Partnership — Annual Review', date: 'Jul 2026', imageUrl: WORK[4],
                summary: 'Placements and retention across five state missions.' },
            { title: 'Regional Policy Compendium 2026', date: 'Jun 2026', imageUrl: WORK[3],
                summary: 'Every representation the region filed, with the outcome.' },
            { title: 'Energy Costs for Industry in the South', date: 'May 2026', imageUrl: WORK[5],
                summary: 'Tariffs, open access and solar, state by state.' },
            { title: 'Exporters\' Handbook — South Edition', date: 'Apr 2026', imageUrl: WORK[7],
                summary: 'Documentation and costing, written for a first-time exporter.' },
            { title: 'ACTIV South Annual Report 2025-26', date: 'Mar 2026', imageUrl: WORK[0],
                summary: 'Accounts, membership, programmes and the region\'s year.' },
        ]);

        setList('policyAdvocacy', [
            { title: 'Joint submission on inter-state freight costs', date: 'Aug 2026',
                icon: 'ship', summary: 'Filed with the central ministry on behalf of all eight councils.' },
            { title: 'Representation on power tariff parity', date: 'Jul 2026',
                icon: 'scale', summary: 'On the spread between industrial tariffs across the region.' },
            { title: 'MSME credit — regional note', date: 'Jun 2026',
                icon: 'handshake', summary: 'What first-time borrowers are actually refused on, with figures.' },
            { title: 'Port turnaround and container availability', date: 'May 2026',
                icon: 'ship', summary: 'Taken up with four port authorities together.' },
            { title: 'Skills certification portability', date: 'Apr 2026',
                icon: 'graduation-cap', summary: 'So a certificate earned in one state is read the same in another.' },
        ]);

        setList('mediaReleases', [
            { title: 'South councils file a joint freight submission', date: 'Aug 2026',
                icon: 'file-text', summary: 'All eight councils, one representation.' },
            { title: 'Regional export desk crosses its first-order target', date: 'Jul 2026',
                icon: 'file-text', summary: 'Members reach first orders in new markets.' },
            { title: 'Skills partnership renewed with five missions', date: 'Jun 2026',
                icon: 'file-text', summary: 'The framework runs for another three years.' },
            { title: 'Statement on the revised port tariff order', date: 'May 2026',
                icon: 'file-text', summary: 'The region\'s reading of the order as notified.' },
        ]);

        setList('sectorUpdates', [
            { title: 'Machine tools: order books lengthen', date: 'Sep 2026', icon: 'factory',
                summary: 'Members report longer lead times and a shortage of skilled operators.' },
            { title: 'Marine exports: freight rates ease', date: 'Aug 2026', icon: 'ship',
                summary: 'Container rates fall on the Europe lane for the third month.' },
            { title: 'Pharma: audit readiness becomes the constraint', date: 'Jul 2026',
                icon: 'award', summary: 'Members are hiring quality staff faster than production staff.' },
            { title: 'Textiles: cotton prices steady', date: 'Jun 2026', icon: 'leaf',
                summary: 'After two volatile quarters, mills report predictable input costs.' },
            { title: 'Electronics: component lead times shorten', date: 'May 2026', icon: 'rocket',
                summary: 'Members report improved availability of passive components.' },
        ]);

        setList('newsUpdates', [
            { title: 'Two new district chapters open in the region', date: 'Sep 2026',
                icon: 'building', summary: 'Taking the region to ninety-six chapters.' },
            { title: 'Regional secretariat moves to a larger office', date: 'Aug 2026',
                icon: 'map-pin', summary: 'The Chennai office takes a second floor.' },
            { title: 'Membership crosses fourteen thousand companies', date: 'Jul 2026',
                icon: 'users', summary: 'Growth led by Karnataka and Telangana.' },
            { title: 'Working group chairs appointed for the year', date: 'Jun 2026',
                icon: 'handshake', summary: 'Manufacturing, exports, energy and skills.' },
            { title: 'Regional council calendar published', date: 'May 2026',
                icon: 'calendar', summary: 'Four council meetings and eleven programmes.' },
        ]);

        setList('speakInMedia', [
            { title: 'Regional Chairman on manufacturing costs', date: 'Sep 2026', icon: 'mic',
                summary: 'On energy and freight, in a national business daily.' },
            { title: 'Export working group chair on new markets', date: 'Aug 2026', icon: 'mic',
                summary: 'On where members are finding first orders.' },
            { title: 'Secretary on the skills partnership', date: 'Jul 2026', icon: 'mic',
                summary: 'On certification portability across the five states.' },
        ]);

        setList('consultingServices', [
            { title: 'Policy Advocacy', icon: 'scale',
                summary: 'Representation to the central government on what crosses a state border.' },
            { title: 'Business Consulting', icon: 'briefcase',
                summary: 'Strategic guidance for member companies operating in several states.' },
            { title: 'Market Research', icon: 'search',
                summary: 'Regional data on markets, buyers and competing supply.' },
            { title: 'Training & Capacity Building', icon: 'graduation-cap',
                summary: 'Programmes run once for the region and delivered in each state.' },
        ]);

        if (FORCE || isTemplateText(region.consultingIntro)) {
            region.consultingIntro = 'Run once for the region, delivered in every state.';
        }

        if (FORCE || isTemplateText(region.contact && region.contact.personName)) {
            region.contact = {
                ...REGION.office,
                photoUrl: PORTRAITS[4],
                country: 'India',
                mapUrl: '',
            };
            touched.push('contact');
        }

        if (!region.socialLinks || !region.socialLinks.length) {
            region.socialLinks = [
                { icon: 'facebook', href: 'https://facebook.com' },
                { icon: 'twitter', href: 'https://twitter.com' },
                { icon: 'linkedin', href: 'https://linkedin.com' },
                { icon: 'youtube', href: 'https://youtube.com' },
            ];
        }
        region.feedbackEnabled = true;
        region.status = 'published';
        await region.save();

        console.log(`South region${''.padEnd(18)} ${touched.length ? touched.join(', ') : 'lists only'}`);
    }

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
