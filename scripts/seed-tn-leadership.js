/**
 * Fills the THREE-TIER LEADERSHIP BOARD on a state page, and the rail beside it.
 *
 * =========================================================================
 * WHY THIS EXISTS
 * =========================================================================
 *
 * The state page draws three benches — the state council, the region it sits
 * in, and its districts — five portraits across, as the association's design
 * lays them out. Tamil Nadu had two names on its own bench and the South region
 * had three, and the district field was new, so the board came up as one short
 * row, one shorter row and nothing at all: the layout could not be judged
 * because there was not enough on it to fill a row.
 *
 * The same is true of the rail beside it. `keyAchievements` is a new field, so
 * every page in the collection has an empty one and the third rail card did not
 * draw.
 *
 * This writes what an editor would type at CMS -> Regions & States, so the page
 * can be judged as it will look in use. Every row is replaceable from that
 * screen and `--clear` takes exactly these rows back out.
 *
 * ------------------------------------------------------------- what it writes
 *
 *   web_state_pages    the state's `leaders`, `districts`, `achievements`
 *                      and `keyAchievements`
 *   web_region_pages   the parent region's `leaders`, `keyAchievements` and
 *                      the rail's `explore` card
 *
 * Nothing else. No admin collection, no member collection, no event collection.
 *
 * ------------------------------------------------------------------- running
 *
 *   node scripts/seed-tn-leadership.js
 *   node scripts/seed-tn-leadership.js --clear
 *   node scripts/seed-tn-leadership.js --state "Kerala"
 *
 * IDEMPOTENT, AND IT NEVER OVERWRITES. A person whose name is already on a
 * bench is left alone — including one an editor has since rewritten — and a
 * bench that has reached five is not topped up further. Running it twice adds
 * nothing.
 *
 * The names, numbers and figures are PLACEHOLDERS, exactly as the benches that
 * were already there are. The telephone numbers follow the +91 xx 2345 xxxx
 * shape the other seeds use and belong to nobody.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CLEAR = process.argv.includes('--clear');

const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? String(process.argv[i + 1] || '').trim() : '';
};

const STATE = argOf('--state') || 'Tamil Nadu';
const SLUG = STATE.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** What a full bench looks like in the design. */
const BENCH_SIZE = 5;

/* Public photographs, the same set the other region seeds draw on. */
const PORTRAITS = [
    'https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1573497019940-1c28c88b4f3e?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1580489944761-15a19d654956?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&q=80&w=600',
    'https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&q=80&w=600',
];

/* ------------------------------------------------------------- the benches */

/** The office-bearers the state council still wants, after the two it has. */
const STATE_BENCH = [
    ['Mr S Karthikeyan', 'Secretary', 'CEO, Karthik Electronics Pvt Ltd'],
    ['Mr R Ganesh', 'Treasurer', 'Managing Director, Ganesh Auto Components Pvt Ltd'],
    ['Ms Priya Natarajan', 'Member', 'Director, Nila Leather Exports Pvt Ltd'],
];

const REGION_BENCH = [
    ['Mr A Venkatesh', 'Treasurer', 'Director, Venkatesh Textiles'],
    ['Mr M Rajasekar', 'Member', 'CEO, Rajasekar Exports'],
];

const BOARD = [
    ['Chairman', 'District Chairman'],
    ['Chairperson', 'District Chairperson'],
    ['Secretary', 'District Secretary'],
    ['Treasurer', 'District Treasurer'],
];

/**
 * The line printed beside a district's name — what its members actually make.
 *
 * A heading a reader skims becomes a heading that tells them whether this is
 * their chapter. Placeholder copy, replaceable in the CMS like everything else.
 */
const DISTRICT_LINES = {
    Chennai: 'Automotive assembly, electronics and industrial services',
    Coimbatore: 'Pumps, motors, foundries and textile machinery',
    Madurai: 'Engineering, food processing and printing',
    Tiruppur: 'Knitwear, garment exports and dyeing units',
};

/* district, dialling code, the trade the chapter is known for, four names. */
const DISTRICTS = [
    ['Chennai', '44', 'automotive components', [
        'Mr D Murali', 'Ms K Anitha', 'Mr V Selvam', 'Ms G Revathi',
    ]],
    ['Coimbatore', '422', 'pumps and castings', [
        'Mr S Balamurugan', 'Ms P Nithya', 'Mr R Chandran', 'Ms T Kavitha',
    ]],
    ['Madurai', '452', 'engineering and food processing', [
        'Mr A Mohan', 'Ms S Vasanthi', 'Mr K Prabhu', 'Ms M Latha',
    ]],
    ['Tiruppur', '421', 'knitwear and garment exports', [
        'Mr N Senthil', 'Ms R Divya', 'Mr P Arumugam', 'Ms J Bhuvana',
    ]],
];

/* ------------------------------------------------------------- the rail */

/**
 * The figures in the rail's Highlights card.
 *
 * =========================================================================
 * WHY THESE REPLACE WHAT IS THERE, AND ONLY THESE
 * =========================================================================
 *
 * Tamil Nadu's Highlights card was seeded, long before the rail existed, with
 * the state's area, its population and "2nd — Largest Economy". Those three are
 * ALREADY on the page twice over: area and population are hero facts and the
 * economy line is the first row of State at a Glance. Drawn a third time in the
 * rail they made the card look like a rendering fault rather than like
 * information.
 *
 * So the replacement is conditional and narrow: the list is rewritten only when
 * every row still in it is one of those three known duplicates. A card an
 * editor has touched at all — one row added, one row reworded — keeps every row
 * it has, and these are appended instead.
 */
const HIGHLIGHTS = [
    ['12,500+', 'Total industries', 'factory'],
    ['Automotive | Textiles | Leather | Electronics', 'Major sectors', 'layers'],
    ['3.2 Lakhs+', 'MSME units', 'building'],
    ['USD 34.5 Billion', 'Exports (FY 2023-24)', 'trending-up'],
    ['18+', 'Skill development centres', 'graduation-cap'],
];

/** What the old seed left behind, and the only rows this will overwrite. */
const HERO_DUPLICATES = new Set([
    '1,30,058 km²', '72.1 million', '2nd',
]);

/**
 * The region's own ticked list, and the picture at the top of its rail.
 *
 * The region page draws the same three rail cards the state page does, and two
 * of the three are new fields — so every region in the collection has them
 * empty and the rail came up with one card in it. These are what an editor
 * would type; `--clear` takes exactly them back out.
 */
const REGION_KEY_ACHIEVEMENTS = [
    ['One council speaking for eight states and union territories', 'users'],
    ['Four working ports on one export agenda', 'ship'],
    ['Regional skills charter adopted by every state council', 'graduation-cap'],
    ['Joint submissions on power tariffs and MSME credit', 'scale'],
    ['Quarterly regional council meetings', 'calendar'],
];

/**
 * The ticked list. SENTENCES, not figures — the figures live in `achievements`
 * and are drawn as the Highlights card above this one.
 */
const KEY_ACHIEVEMENTS = [
    ['First orders in 11 new export markets', 'globe'],
    ['Power tariff and MSME credit advocacy', 'zap'],
    ['Land allotment facilitation', 'map-pin'],
    ['Skill training for 50,000+ young people', 'graduation-cap'],
    ['Quarterly state council meetings', 'calendar'],
];

/* ------------------------------------------------------------------ shapes */

const leader = ([name, role, organisation], council, index) => ({
    name,
    role,
    designation: `${role}, ACTIV ${council}`,
    organisation,
    photoUrl: PORTRAITS[index % PORTRAITS.length],
    bio: `Serves on the ACTIV ${council} and works with its member companies. `
        + 'Placeholder biography — replace it in the CMS.',
    displayOrder: index + 1,
    isHidden: false,
});

const districtRow = ([name, code, trade, names], index) => ({
    name,
    description: DISTRICT_LINES[name] || '',
    leaders: BOARD.map(([role, designation], n) => ({
        name: names[n] || '',
        role,
        designation: `${designation}, ACTIV ${name}`,
        organisation: `Managing Director, ${name} ${['Traders', 'Textiles', 'Industries', 'Agro'][n]}`,
        photoUrl: PORTRAITS[(index * 2 + n) % PORTRAITS.length],
        bio: `Leads the ACTIV chapter in ${name}, which works largely with the `
            + `district's ${trade} members. Placeholder biography — replace it in the CMS.`,
        displayOrder: n + 1,
        isHidden: false,
    })),
    contact: {
        personName: names[0] || '',
        photoUrl: '',
        designation: `District Chairman, ACTIV ${name}`,
        addressLines: [`ACTIV ${name} District Office`],
        city: name,
        state: STATE,
        country: 'India',
        pincode: '',
        email: `${name.toLowerCase().replace(/[^a-z]/g, '')}@activ.org.in`,
        phone: `+91 ${code} 2345 ${1000 + index * 111}`,
        mapUrl: '',
    },
    displayOrder: index + 1,
    isHidden: false,
});

/* ------------------------------------------------------------------ helpers */

const named = (list, key = 'name') => new Set(
    (list || []).map((row) => String(row[key] || '').trim().toLowerCase()),
);

/** Adds the rows that are not there, in order, and renumbers nothing. */
const topUp = (list, rows, make, limit) => {
    const have = named(list);
    let added = 0;
    rows.forEach((row) => {
        if (limit && list.length >= limit) return;
        if (have.has(String(row[0]).trim().toLowerCase())) return;
        list.push(make(row, list.length));
        added += 1;
    });
    return added;
};

const dropNamed = (list, names) => (list || [])
    .filter((row) => !names.has(String(row.name || row.title || '').trim().toLowerCase()));

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { StatePage, RegionPage } = require('../src/modules/cms/cms.models');

    const page = await StatePage.findOne({ slug: SLUG });
    if (!page) throw new Error(`no state page for ${SLUG} — run seed-cms-states-all.js first`);

    const region = page.regionKey
        ? await RegionPage.findOne({ regionKey: page.regionKey })
        : null;

    const mineState = new Set(STATE_BENCH.map((r) => r[0].toLowerCase()));
    const mineRegion = new Set(REGION_BENCH.map((r) => r[0].toLowerCase()));
    const mineDistrict = new Set(DISTRICTS.map((r) => r[0].toLowerCase()));
    const mineKey = new Set(KEY_ACHIEVEMENTS.map((r) => r[0].toLowerCase()));
    const mineHigh = new Set(HIGHLIGHTS.map((r) => r[0].toLowerCase()));

    if (CLEAR) {
        page.leaders = dropNamed(page.leaders, mineState);
        page.districts = dropNamed(page.districts, mineDistrict);
        page.keyAchievements = (page.keyAchievements || [])
            .filter((row) => !mineKey.has(String(row.title || '').trim().toLowerCase()));
        page.achievements = (page.achievements || [])
            .filter((row) => !mineHigh.has(String(row.title || '').trim().toLowerCase()));
        await page.save();

        if (region) {
            region.leaders = dropNamed(region.leaders, mineRegion);
            const mineRegionKey = new Set(
                REGION_KEY_ACHIEVEMENTS.map((r) => r[0].toLowerCase()),
            );
            region.keyAchievements = (region.keyAchievements || [])
                .filter((row) => !mineRegionKey.has(String(row.title || '').trim().toLowerCase()));
            await region.save();
        }

        console.log(`${STATE}: cleared — ${page.leaders.length} state leaders, `
            + `${page.districts.length} districts, ${page.keyAchievements.length} achievements`);
        await mongoose.disconnect();
        return;
    }

    /* ---------------------------------------------------------- the state */
    const addedState = topUp(
        page.leaders, STATE_BENCH,
        (row, i) => leader(row, `${STATE} State Council`, i),
        BENCH_SIZE,
    );

    /* ------------------------------------------------------- the districts */
    const haveDistricts = named(page.districts);
    let addedDistricts = 0;
    DISTRICTS.forEach((row, index) => {
        if (haveDistricts.has(row[0].toLowerCase())) return;
        page.districts.push(districtRow(row, index));
        addedDistricts += 1;
    });

    /* ------------------------------------------------------------ the rail */

    /* The figures. Replaced wholesale ONLY when nothing but the three
       hero-duplicates is in there; otherwise appended, so an editor's own rows
       survive. */
    const onlyDuplicates = (page.achievements || []).length > 0
        && (page.achievements || []).every(
            (row) => HERO_DUPLICATES.has(String(row.title || '').trim().toLowerCase()),
        );
    if (onlyDuplicates) page.achievements = [];

    const haveHigh = new Set(
        (page.achievements || []).map((row) => String(row.title || '').trim().toLowerCase()),
    );
    let addedHigh = 0;
    HIGHLIGHTS.forEach(([title, summary, icon], index) => {
        if (haveHigh.has(title.toLowerCase())) return;
        page.achievements.push({
            title, summary, icon, displayOrder: index + 1, isHidden: false,
        });
        addedHigh += 1;
    });

    const haveKey = new Set(
        (page.keyAchievements || []).map((row) => String(row.title || '').trim().toLowerCase()),
    );
    let addedKey = 0;
    KEY_ACHIEVEMENTS.forEach(([title, icon], index) => {
        if (haveKey.has(title.toLowerCase())) return;
        page.keyAchievements.push({
            title, summary: '', icon, displayOrder: index + 1, isHidden: false,
        });
        addedKey += 1;
    });

    await page.save();

    /* ----------------------------------------------------------- the region */
    let addedRegion = 0;
    let addedRegionKey = 0;
    if (region) {
        const label = `${region.regionName || page.regionKey} Region`;
        addedRegion = topUp(
            region.leaders, REGION_BENCH,
            (row, i) => leader(row, label, i),
            BENCH_SIZE,
        );

        const haveRegionKey = new Set(
            (region.keyAchievements || [])
                .map((row) => String(row.title || '').trim().toLowerCase()),
        );
        REGION_KEY_ACHIEVEMENTS.forEach(([title, icon], index) => {
            if (haveRegionKey.has(title.toLowerCase())) return;
            region.keyAchievements.push({
                title, summary: '', icon, displayOrder: index + 1, isHidden: false,
            });
            addedRegionKey += 1;
        });

        /* The rail's picture. Only written when the field is still empty — an
           editor who has chosen a photograph keeps it. The hero's background is
           the obvious stand-in: it is already a picture OF this region, chosen
           by the same editor. */
        const explore = region.explore || {};
        if (!explore.title && !explore.imageUrl) {
            region.explore = {
                imageUrl: (region.hero && region.hero.backgroundUrl) || '',
                title: label,
                subtitle: 'Eight states and union territories, one council',
                href: '',
            };
        }

        await region.save();
    }

    console.log(`${STATE}`);
    console.log(`  state bench      +${addedState}  -> ${page.leaders.length}`);
    console.log(`  region bench     +${addedRegion}  -> ${region ? region.leaders.length : 0}`);
    console.log(`  districts        +${addedDistricts}  -> ${page.districts.length}`);
    console.log(`  highlights       +${addedHigh}  -> ${page.achievements.length}`
        + `${onlyDuplicates ? '  (replaced the hero duplicates)' : ''}`);
    console.log(`  key achievements +${addedKey}  -> ${page.keyAchievements.length}`);
    console.log(`  region rail      +${addedRegionKey}  -> `
        + `${region ? region.keyAchievements.length : 0} achievements`);

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
