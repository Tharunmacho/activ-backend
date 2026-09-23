/**
 * Builds every region, and every state in it, out to the shape Tamil Nadu was
 * signed off at.
 *
 * =========================================================================
 * WHY THIS EXISTS
 * =========================================================================
 *
 * A state page draws three tiers — the state council, the state's own regions,
 * and its district chapters — and a region page draws two — the regional
 * council and its member states. The association approved that shape on Tamil
 * Nadu and the South. Every other state had two office-bearers, no regions and
 * no districts, and every other region page had two: the page they produced was
 * one short row and nothing else. The layout could not be judged, and a visitor
 * moving from Tamil Nadu to Bihar met what looked like a broken page rather
 * than a smaller council.
 *
 * This writes what an editor would type, for EVERY region and EVERY state, so
 * all forty-one pages can be read as they will be in use. Every row is
 * replaceable from CMS -> Regions & States and `--clear` takes exactly these
 * rows back out.
 *
 * ------------------------------------------------------------- what it writes
 *
 *   web_region_pages  each region's `leaders`
 *   web_state_pages   each state's `leaders`, `stateRegions` and `districts`
 *
 * Nothing else. No admin collection, no member collection, no events.
 *
 * ------------------------------------------------------------------- running
 *
 *   node scripts/seed-region-leadership.js                    # all five regions
 *   node scripts/seed-region-leadership.js --region north     # one region
 *   node scripts/seed-region-leadership.js --state Kerala     # one state
 *   node scripts/seed-region-leadership.js --clear            # remove exactly these
 *
 * IDEMPOTENT, AND IT OVERWRITES ONE THING ONLY: the "Sample Name — replace me"
 * rows every page was created with, which are scaffolding and not content — see
 * `isScaffold`. A bench that already has five people is
 * otherwise left alone; a region or district already named is left alone; a state that
 * already has ANY regions of its own has that whole tier left alone, because an
 * editor's four zones are not this script's four zones and interleaving them
 * would give a state five. Running it twice adds nothing, and running it after a
 * real edit does not undo the edit.
 *
 * ---------------------------------------------------------------- the names
 *
 * PLACEHOLDERS, as the benches that were already there are. The DISTRICT names
 * are real — they have to be, because the map matches its pins to them by name
 * — and the people are not.
 *
 * They are COMPOSED rather than listed, from a pool of given names and a pool
 * of surnames per naming tradition, because thirty-six hand-typed lists of
 * forty names each is fourteen hundred lines nobody will ever read and one of
 * them would end up holding Kerala's names under Nagaland. Composition also
 * makes the pools big enough that a page does not repeat a name, which the
 * hand-typed ones were not: one state needs five for its council, twenty for
 * its regions and twenty-four for its chapters.
 *
 * It is deterministic, so a second run over a half-filled page continues the
 * same bench rather than starting a different one. What `--clear` matches on is
 * NOT the names — see `MARKER`.
 *
 * Telephone numbers follow the +91 <std> 2345 xxxx shape the other seeds use
 * and belong to nobody.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CLEAR = process.argv.includes('--clear');
const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > -1 ? String(process.argv[i + 1] || '').trim() : '';
};
const ONLY_STATE = argOf('--state');
const ONLY_REGION = argOf('--region');

/** What a full bench looks like in the design. */
const BENCH = 5;
/** What a district chapter elects. */
const CHAPTER = 4;
/** How many district chapters a state gets, when it has that many districts. */
const CHAPTERS = 6;

const ROLES = [
    ['Chairman', 'Chairman'],
    ['Vice Chairman', 'Vice Chairman'],
    ['Secretary', 'Secretary'],
    ['Treasurer', 'Treasurer'],
    ['Member', 'Member'],
];

/* ------------------------------------------------------------------- names */

/* The pools, the traditions and the dialling codes — shared with
   `seed-region-profiles.js`, which writes the contacts on the same pages. */
const {
    STYLE_OF, REGION_STYLE, poolFor, CODES, portraitOf,
} = require('./lib/placeholderNames');

/** Firms, so an organisation line is not the same sentence forty times. */
const FIRMS = [
    'Industries Pvt Ltd', 'Textiles Ltd', 'Engineering Works', 'Agro Exports Pvt Ltd',
    'Traders & Co', 'Electronics Pvt Ltd', 'Logistics Services', 'Foods Pvt Ltd',
];

/**
 * Compass order, and the labels that go with it.
 *
 * The order matters because it becomes `displayOrder`, and the zones come out
 * of the generated map in whatever order the alphabetically-first district
 * happens to sit in — which put Tamil Nadu's bands on the page as East, North,
 * West, South. Four compass points in no compass order read as an accident.
 */
const ZONE_ORDER = ['north', 'east', 'south', 'west'];
const ZONE_LABELS = { north: 'North', east: 'East', south: 'South', west: 'West' };

/**
 * THE SCAFFOLD ROWS COME OUT, AND THEY ARE THE ONE THING THIS SCRIPT OVERWRITES.
 *
 * Every page was created with two leaders reading "Sample Name — replace me",
 * no photograph and no role. Topping a bench up AROUND them leaves the two
 * senior chairs held by placeholders and the real bench filed underneath as
 * Secretary, Treasurer and Member — a page that looks worse than the empty one
 * it replaced.
 *
 * They are not content and nobody typed them, so they are removed. A row an
 * editor has actually filled in does not match.
 */
const isScaffold = (row) => /sample name|replace me/i.test(String(row?.name || ''));

/**
 * WHAT `--clear` LOOKS FOR, AND WHY IT IS NOT THE NAMES.
 *
 * Every person this script writes carries this sentence in their biography, and
 * that — not the name — is what identifies a seeded row. The first version
 * rebuilt the name pool and matched on it, which quietly stopped working the
 * moment the pools changed: the rows stayed, invisible to the only thing that
 * was supposed to be able to remove them.
 *
 * A marker in the content survives a change to how the content is generated,
 * and it is also the honest answer to the question being asked, which is "is
 * this placeholder copy?" rather than "is this a name I would have picked?".
 *
 * IT MATCHES THE WHOLE SENTENCE, INCLUDING THE FIRST HALF, and that is not
 * belt-and-braces. `seed-tn-leadership.js` ends ITS biographies with the same
 * "Placeholder biography — replace it in the CMS." and writes a different
 * opening; matching on the trailing half alone made this script's `--clear`
 * delete Tamil Nadu's hand-written regions and chapters — the one page on the
 * site that had been signed off. Two scripts sharing a database need markers
 * that tell their own rows apart, not markers that agree.
 */
const MARKER = 'Placeholder biography — replace it in the CMS.';

const MINE = new RegExp(
    `^Serves on the ACTIV .+ and works with its member companies\. ${MARKER}`,
);

const isSeeded = (row) => MINE.test(String(row?.bio || ''));

/** A tier panel is this script's only if everybody on its bench is. */
const isSeededTier = (tier) => {
    const leaders = tier?.leaders || [];
    return leaders.length > 0 && leaders.every(isSeeded);
};

const slugOf = (value) => String(value || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const emailOf = (name) => String(name || '').toLowerCase()
    .replace(/^(mr|mrs|ms|dr)\s+/, '')
    .replace(/[^a-z]+/g, '.')
    .replace(/^\.|\.$/g, '');

/**
 * The district geometry the website ships, read straight from the generated
 * modules.
 *
 * Reading them rather than repeating them is the point: the map matches its
 * pins to chapters BY NAME, so a seed that invented district names would place
 * chapters the map cannot find. This way the two cannot disagree.
 */
const readMap = (slug) => {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(
        __dirname, '..', '..', 'website', 'src', 'data', 'maps', `${slug}.ts`,
    );
    if (!fs.existsSync(file)) return { districts: [], zones: [] };
    const text = fs.readFileSync(file, 'utf8');
    const districts = [];
    const re = /"name":\s*"([^"]+)"[\s\S]*?"slug":\s*"([^"]+)"[\s\S]*?(?:"zone":\s*"([^"]+)")?\s*\}/g;
    let m;
    while ((m = re.exec(text)) !== null) districts.push({ name: m[1], zone: m[3] || '' });
    const present = new Set(districts.map((d) => d.zone).filter(Boolean));
    const zones = ZONE_ORDER.filter((z) => present.has(z));
    return { districts, zones };
};

/**
 * Which districts get a chapter — one per zone, round-robin, until there are
 * enough.
 *
 * Taking the first six alphabetically put every pin for Odisha in one corner of
 * the map, because the districts of a state are not alphabetical by geography.
 * Cycling the zones spreads them over the whole shape, which is what a reader
 * is looking at, and is still perfectly stable between runs.
 */
const chapterPicks = (districts, want) => {
    const zones = [...new Set(districts.map((d) => d.zone))];
    const byZone = zones.map((z) => districts.filter((d) => d.zone === z));
    const out = [];
    for (let round = 0; out.length < want; round += 1) {
        let took = 0;
        byZone.forEach((list) => {
            if (out.length >= want || !list[round]) return;
            out.push(list[round]);
            took += 1;
        });
        if (!took) break;
    }
    return out;
};

/* ------------------------------------------------------------------- build */

/** Four digits from the name, so one person has one number everywhere. */
const lineOf = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 1000003;
    return String(1000 + (h % 9000));
};

const person = (name, [role, title], council, index, place, style, faces) => ({
    name,
    role,
    designation: `${title}, ACTIV ${council}`,
    organisation: `Managing Director, ${String(name).split(' ').pop()} ${FIRMS[index % FIRMS.length]}`,
    photoUrl: portraitOf(style, name, faces),
    bio: `Serves on the ACTIV ${council} and works with its member companies. ${MARKER}`,
    email: `${emailOf(name)}@activ.org.in`,
    /* Off the NAME, not off the position in the tier. The index restarts at
       zero for every bench, so two different people on one page were both on
       "+91 612 2345 1000". */
    phone: `+91 ${CODES[place] || '44'} 2345 ${lineOf(name)}`,
    address: `${place}`,
    displayOrder: (index % BENCH) + 1,
    isHidden: false,
});

const office = (name, title, place, state, index) => ({
    personName: name,
    photoUrl: '',
    designation: `${title}, ACTIV ${place}`,
    addressLines: [`ACTIV ${place} Office`],
    city: place,
    state,
    country: 'India',
    email: `${slugOf(place)}@activ.org.in`,
    phone: `+91 ${CODES[state] || '44'} 2345 ${lineOf(`${place} office`)}`,
    mapUrl: '',
});

/**
 * FILL A BLANK EMAIL OR TELEPHONE ON A ROW SOMEBODY ELSE WROTE.
 *
 * Filling an empty field is not overwriting, and it is the difference between
 * a person being IN the page's contact directory and being absent from it:
 * `contactEntries` lists a leader only if they have at least one way to be
 * reached. Tamil Nadu's four district chapters were written before those fields
 * existed, so sixteen real office-bearers were on the leadership board and on no
 * contact card anywhere.
 *
 * Only ever writes into an empty field, so a number an editor has typed is
 * never touched, and it does nothing on a second run.
 */
const fillBlankContacts = (rows, place) => {
    let filled = 0;
    (rows || []).forEach((row) => {
        if (!row?.name) return;
        if (row.email || row.phone) return;
        row.email = `${emailOf(row.name)}@activ.org.in`;
        row.phone = `+91 ${CODES[place] || '44'} 2345 ${lineOf(row.name)}`;
        filled += 1;
    });
    return filled;
};

/* ------------------------------------------------------------------- regions */

/** The regional council itself — the bench the region page's first band draws. */
const seedRegion = async(RegionPage, region, log) => {
    const page = await RegionPage.findOne({ regionKey: region.key });
    if (!page) { console.warn(`skipped region ${region.label} — no page`); return; }

    const style = REGION_STYLE[region.key] || 'hindi';
    const pool = poolFor(style, BENCH * 2);

    if (CLEAR) {
        page.leaders = (page.leaders || []).filter((l) => !isSeeded(l));
        await page.save();
        log(`region ${region.label}`, 'cleared');
        return;
    }

    let added = 0;
    page.leaders = (page.leaders || []).filter((l) => !isScaffold(l));
    const filled = fillBlankContacts(page.leaders, region.label);
    /* Seeded with the photographs the surviving rows already hold, so a bench
       this script only tops up does not repeat one of them. */
    const faces = new Set((page.leaders || []).map((l) => l.photoUrl).filter(Boolean));
    while ((page.leaders || []).length < BENCH) {
        const i = page.leaders.length;
        /*
         * The first chair of a ZONE is a Zone Chairman, not a Chairman — the
         * title is what distinguishes the tier on a page that draws three.
         *
         * "Regional", and the place written as "South Region", is what this
         * said. The tier below a state is a region and the tier above one is
         * a zone; using the same word for both is what put "Chairman, ACTIV
         * South Region" under a heading reading "South Zone Leaders". The
         * STATE's own regions, seeded further down this file, keep "Region"
         * and keep "Regional Chairman", because there the word is right.
         */
        const role = i === 0 ? ['Zone Chairman', 'Zone Chairman'] : ROLES[i % ROLES.length];
        page.leaders.push(person(
            pool[i], role, `${region.label} Zone`, i, region.label, style, faces,
        ));
        added += 1;
    }

    await page.save();
    log(`region ${region.label}`, `council +${added} (${page.leaders.length})`
        + (filled ? `  contacts filled ${filled}` : ''));
};

/* -------------------------------------------------------------------- states */

const seedState = async(StatePage, entry, log) => {
    const page = await StatePage.findOne({ slug: entry.slug });
    if (!page) { console.warn(`skipped ${entry.name} — no page`); return; }

    const style = STYLE_OF[entry.name] || 'hindi';
    /* Five for the council, five per region, four per chapter — and a margin,
       so the last chapter is not drawing names the council already used. */
    const pool = poolFor(style, BENCH + 4 * BENCH + CHAPTERS * CHAPTER + 8);

    if (CLEAR) {
        page.leaders = (page.leaders || []).filter((l) => !isSeeded(l));
        page.stateRegions = (page.stateRegions || []).filter((r) => !isSeededTier(r));
        page.districts = (page.districts || []).filter((d) => !isSeededTier(d));
        await page.save();
        log(entry.name, 'cleared');
        return;
    }

    const { districts, zones } = readMap(entry.slug);
    let cursor = 0;
    const next = () => pool[cursor++ % pool.length];

    /* ----------------------------------------------------- the state council */
    let addedLeaders = 0;
    page.leaders = (page.leaders || []).filter((l) => !isScaffold(l));
    const councilFaces = new Set((page.leaders || []).map((l) => l.photoUrl).filter(Boolean));
    while ((page.leaders || []).length < BENCH) {
        const i = page.leaders.length;
        page.leaders.push(person(
            next(), ROLES[i % ROLES.length], `${entry.name} State Council`, i, entry.name, style,
            councilFaces,
        ));
        addedLeaders += 1;
    }

    /* -------------------------------------------------- the state's own regions
     *
     * ALL OR NOTHING. A state that already has regions of its own has them
     * because somebody named them, and their four are not necessarily these
     * four — Tamil Nadu's are North, West, Central and South against this
     * script's North, West, East and South. Topping that up by name adds a
     * fifth region to a state that has four, which reads as a mistake on the
     * page and is one.
     */
    let addedRegions = 0;
    if (!(page.stateRegions || []).length) {
        zones.forEach((key, zi) => {
            const label = ZONE_LABELS[key] || key;
            const covers = districts.filter((d) => d.zone === key).map((d) => d.name);
            const zoneFaces = new Set();
            const bench = ROLES.map((role, i) => person(
                next(), role, `${label} Region, ${entry.name}`, zi * 3 + i, entry.name, style,
                zoneFaces,
            ));
            page.stateRegions.push({
                name: label,
                description: covers.slice(0, 5).join(', ')
                    + (covers.length > 5 ? ` and ${covers.length - 5} more` : ''),
                /* The same five titles the state council uses. Tamil Nadu's
                   zones were signed off reading "Chairman", not "Regional
                   Chairman" — the tier is already named by the band's heading,
                   and a second word for the same office reads as a different
                   office. */
                leaders: bench,
                /*
                 * THE OFFICE IS THE TIER'S OWN CHAIRMAN, and it has to be.
                 * `contactEntries` on the page drops the office entry when the
                 * bench beside it already names that person, which is what
                 * stops one chairman being printed twice. Naming somebody else
                 * — this drew from the front of the pool, which is where the
                 * STATE council's names come from — defeats the dedupe and puts
                 * the state chairman into a region's contact block.
                 */
                contact: office(
                    bench[0].name, 'Regional Chairman',
                    `${label} Region`, entry.name, zi,
                ),
                displayOrder: zi + 1,
                isHidden: false,
            });
            addedRegions += 1;
        });
    }

    /* ----------------------------------------------------- district chapters */
    const haveDistricts = new Set((page.districts || [])
        .map((d) => String(d.name || '').toLowerCase()));
    const chosen = chapterPicks(districts, CHAPTERS)
        .filter((d) => !haveDistricts.has(d.name.toLowerCase()))
        .slice(0, Math.max(0, CHAPTERS - haveDistricts.size));

    let addedDistricts = 0;
    chosen.forEach((d, di) => {
        const chapterFaces = new Set();
        const bench = ROLES.slice(0, CHAPTER).map((role, i) => person(
            next(), [role[0], `District ${role[1]}`], d.name, di * 5 + i, entry.name, style,
            chapterFaces,
        ));
        page.districts.push({
            name: d.name,
            description: '',
            leaders: bench,
            /* The chapter's own chairman — see the region tier above. */
            contact: office(bench[0].name, 'District Chairman', d.name, entry.name, di + 5),
            displayOrder: haveDistricts.size + di + 1,
            isHidden: false,
        });
        addedDistricts += 1;
    });

    /* Anything on this page that has no way to be reached, including rows
       written by another script — see `fillBlankContacts`. */
    let filled = fillBlankContacts(page.leaders, entry.name);
    (page.stateRegions || []).forEach((r) => { filled += fillBlankContacts(r.leaders, entry.name); });
    (page.districts || []).forEach((d) => { filled += fillBlankContacts(d.leaders, entry.name); });

    await page.save();
    log(
        entry.name,
        `council +${addedLeaders} (${page.leaders.length})`
        + `  regions +${addedRegions} (${page.stateRegions.length})`
        + `  districts +${addedDistricts} (${page.districts.length})`
        + (filled ? `  contacts filled ${filled}` : ''),
    );
};

/* ---------------------------------------------------------------------- run */

const main = async() => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);

    const { StatePage, RegionPage } = require('../src/modules/cms/cms.models');
    const { REGIONS, statesOf } = require('../src/modules/cms/cms.regionMap');

    const log = (who, what) => console.log(`${String(who).padEnd(42)} ${what}`);

    const regions = REGIONS.filter((r) => (ONLY_REGION ? r.key === ONLY_REGION : true));
    if (!regions.length) {
        throw new Error(`no region called "${ONLY_REGION}" — try ${REGIONS.map((r) => r.key).join(', ')}`);
    }

    for (const region of regions) {
        /* A single `--state` is a request about that state, not about the
           region page it happens to sit in. */
        if (!ONLY_STATE) await seedRegion(RegionPage, region, log);

        const wanted = statesOf(region.key)
            .filter((s) => (ONLY_STATE ? s.name === ONLY_STATE : true));

        for (const entry of wanted) await seedState(StatePage, entry, log);
    }

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
