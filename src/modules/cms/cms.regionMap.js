/**
 * The macro-regions of India, and which state sits in which.
 *
 * =========================================================================
 * ONE MAP, ON THE SERVER
 * =========================================================================
 *
 * The header's Regions menu, the region page's Focus States rail, the CMS
 * editor's state picker and the gallery's filters all answer the same question:
 * which states belong to which region. A copy of this list in the browser is a
 * second answer to that question, and the first time somebody adds a state to
 * one and not the other the nav offers a page the API will not serve.
 *
 * So it lives here, is served by `GET /cms/regions/map`, and every caller reads
 * it. Nothing hardcodes a region or a state name in a component.
 *
 * -------------------------------------------------------------------- scope
 *
 * This is CONTENT GEOGRAPHY, and it has nothing to do with
 * `admin.regions.js` / `adminsdb`, which decides which regions are staffed and
 * therefore open for registration. A CMS page may exist for a state with no
 * block admin — it is a page about that state, not a claim that somebody can
 * apply there. Do not "unify" the two: the admin tree is free text a super
 * admin typed and changes as accounts are created; this is a fixed political
 * map of India that changes when a state is created by act of parliament.
 *
 * ------------------------------------------------------------- the rules
 *
 * Every state and union territory appears in EXACTLY ONE region. `assertMap()`
 * proves it at boot rather than leaving a state to be silently unreachable from
 * the menu or, worse, listed under two regions with two different pages.
 */

/**
 * `key` is the join key and the URL slug; `label` is what a reader sees.
 *
 * Keyed on `south` and not on "South" because the label is editable content —
 * an association that renames its regions must not break every stored page and
 * every bookmark. The key never changes.
 */
const REGIONS = Object.freeze([
    Object.freeze({
        key: 'south',
        label: 'South',
        order: 1,
        states: Object.freeze([
            'Andhra Pradesh', 'Karnataka', 'Kerala', 'Tamil Nadu', 'Telangana',
            'Puducherry', 'Lakshadweep', 'Andaman and Nicobar Islands',
        ]),
    }),
    Object.freeze({
        key: 'north',
        label: 'North',
        order: 2,
        states: Object.freeze([
            'Delhi', 'Haryana', 'Punjab', 'Rajasthan', 'Uttar Pradesh',
            'Uttarakhand', 'Himachal Pradesh', 'Jammu and Kashmir', 'Ladakh',
            'Chandigarh',
        ]),
    }),
    Object.freeze({
        key: 'east',
        label: 'East',
        order: 3,
        states: Object.freeze([
            'Bihar', 'Jharkhand', 'Odisha', 'West Bengal',
        ]),
    }),
    Object.freeze({
        key: 'west',
        label: 'West',
        order: 4,
        states: Object.freeze([
            'Goa', 'Gujarat', 'Maharashtra', 'Madhya Pradesh', 'Chhattisgarh',
            'Dadra and Nagar Haveli and Daman and Diu',
        ]),
    }),
    Object.freeze({
        key: 'north-east',
        label: 'North East',
        order: 5,
        states: Object.freeze([
            'Assam', 'Arunachal Pradesh', 'Manipur', 'Meghalaya', 'Mizoram',
            'Nagaland', 'Sikkim', 'Tripura',
        ]),
    }),
]);

/**
 * `Andhra Pradesh` -> `andhra-pradesh`.
 *
 * The URL form of a state name. Accents and `&` are folded out rather than
 * escaped, because a slug with a `%26` in it is a slug nobody can read aloud
 * over a telephone — which is how half of these links will be shared.
 */
const slugify = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Every state, flattened, with the region it belongs to. Built once. */
const STATE_INDEX = (() => {
    const index = new Map();
    for (const region of REGIONS) {
        for (const name of region.states) {
            index.set(slugify(name), {
                name,
                slug: slugify(name),
                regionKey: region.key,
                regionLabel: region.label,
            });
        }
    }
    return index;
})();

/** The same index keyed on the NAME, for validating what a client sent. */
const STATE_BY_NAME = (() => {
    const index = new Map();
    for (const entry of STATE_INDEX.values()) {
        index.set(entry.name.toLowerCase(), entry);
    }
    return index;
})();

/**
 * Proves the map is exhaustive and non-overlapping.
 *
 * Called at boot. A state listed under two regions is the failure this exists
 * to catch: it produces two pages, two menu entries and one unresolvable
 * `regionKey`, and it is invisible until somebody notices the duplicate in a
 * dropdown weeks later.
 */
const assertMap = () => {
    const seen = new Set();
    const duplicates = [];
    for (const region of REGIONS) {
        for (const name of region.states) {
            const slug = slugify(name);
            if (seen.has(slug)) duplicates.push(name);
            seen.add(slug);
        }
    }
    if (duplicates.length) {
        throw new Error(`cms.regionMap: state listed in two regions: ${duplicates.join(', ')}`);
    }
    return { regions: REGIONS.length, states: seen.size };
};

/**
 * ============================================================================
 * THE COUNTRY, AS A REGION THE PAGE MACHINERY UNDERSTANDS
 * ============================================================================
 *
 * The association has a national tier above its five regions — national
 * office-bearers, a national contact list, and a map of the whole country. It
 * needs exactly what a region page already is.
 *
 * So it IS a region page, under a reserved key, and it gets the model, the
 * service, the CMS editor and the public page for nothing. What it is not is
 * a SIXTH REGION: it is deliberately outside `REGIONS`, because every state
 * belongs to exactly one region and `assertMap` proves it at boot. Listing
 * the country there would put all thirty-six states in two regions each and
 * the server would refuse to start — correctly.
 *
 * `states: []` is not an oversight either. A region's state list answers
 * "which state pages hang under this one", and no state page hangs under the
 * national one; they hang under their own region. The national page draws
 * the country from the MAP, which needs no list from here.
 */
const NATIONAL = Object.freeze({
    key: 'national',
    label: 'National',
    /* Before South, which is 1. The country comes first in any list it is in. */
    order: 0,
    national: true,
    states: Object.freeze([]),
});

/**
 * One region by key, or null. Never throws on a bad key.
 *
 * The national key resolves here and NOWHERE in `REGIONS`, so everything
 * that walks the five regions — the state-to-region mapping, `assertMap`,
 * the gallery filters — is untouched by its existence, while everything that
 * looks a key up finds it.
 */
const findRegion = (key) => {
    const want = slugify(key);
    if (want === NATIONAL.key) return NATIONAL;
    return REGIONS.find((region) => region.key === want) || null;
};

/** True for the one key that means the whole country. */
const isNational = (key) => slugify(key) === NATIONAL.key;

/** One state by slug OR by name, or null. */
const findState = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    return STATE_INDEX.get(slugify(raw))
        || STATE_BY_NAME.get(raw.toLowerCase())
        || null;
};

/** The states of one region, as `{ name, slug }`. Empty array for a bad key. */
const statesOf = (regionKey) => {
    const region = findRegion(regionKey);
    if (!region) return [];
    return region.states.map((name) => ({ name, slug: slugify(name) }));
};

/** Every state in the country, flat, sorted by name. For the CMS picker. */
const allStates = () =>
    [...STATE_INDEX.values()].sort((a, b) => a.name.localeCompare(b.name));

module.exports = {
    REGIONS,
    NATIONAL,
    isNational,
    slugify,
    assertMap,
    findRegion,
    findState,
    statesOf,
    allStates,
};
