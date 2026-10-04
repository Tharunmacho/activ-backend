const logger = require('../../config/logger');

/** National LGD location choices and canonical spellings. Admins determine review coverage. */

let index = null;

const key = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Build the three lookup levels once.
 *
 * A malformed or missing dataset must not take the API down — the whole module
 * degrades to "nothing is known", and every caller treats an unknown region as
 * unvalidated rather than invalid.
 */
/**
 * Placeholder names the bundled export carries as if they were regions.
 *
 * It was produced from a spreadsheet, and an empty cell came through as the
 * literal string "nan". Left in, it reaches the Super Admin's state dropdown as
 * a selectable region called "nan" — and anything selectable there is one save
 * away from being offered to applicants.
 */
const isPlaceholderName = (value) => {
    const name = key(value);
    return !name || name === 'nan' || name === 'null' || name === 'undefined' || name === 'none' || name === '-';
};

/** Fold the dated LGD export into the lookup index. */
const absorb = (states, raw) => {
    (raw && raw.states ? raw.states : []).forEach((stateEntry) => {
        const stateName = String((stateEntry && stateEntry.state) || '').trim();
        if (isPlaceholderName(stateName)) return;

        const existing = states.get(key(stateName));
        const districts = existing ? existing.districts : new Map();

        ((stateEntry && stateEntry.districts) || []).forEach((districtEntry) => {
            const districtName = String((districtEntry && districtEntry.district) || '').trim();
            if (isPlaceholderName(districtName)) return;

            const knownDistrict = districts.get(key(districtName));
            const blocks = knownDistrict ? knownDistrict.blocks : new Map();

            // The dataset spells this key `block` (singular) even though it holds an array.
            ((districtEntry && districtEntry.block) || []).forEach((blockName) => {
                const name = String(blockName || '').trim();
                if (!isPlaceholderName(name)) blocks.set(key(name), name);
            });

            districts.set(key(districtName), { name: knownDistrict ? knownDistrict.name : districtName, blocks });
        });

        states.set(key(stateName), { name: existing ? existing.name : stateName, districts });
    });
};

const build = () => {
    const states = new Map(); // stateKey -> { name, districts: Map }

    let raw = null;
    try {
        // eslint-disable-next-line global-require
        raw = require('./data/india-geography.json');
    } catch (err) {
        logger.warn('India geography dataset could not be loaded; region spellings will not be normalised', {
            error: err && err.message
        });
        return states;
    }

    absorb(states, raw);

    return states;
};

const getIndex = () => {
    if (!index) index = build();
    return index;
};

/** True when the dataset loaded at all. Callers skip validation when it did not. */
const isLoaded = () => getIndex().size > 0;

/** The canonical spelling of a state, or '' when it is not in the dataset. */
const canonicalState = (state) => {
    const entry = getIndex().get(key(state));
    return entry ? entry.name : '';
};

/** The canonical spelling of a district within a state, or '' when unknown. */
const canonicalDistrict = (state, district) => {
    const stateEntry = getIndex().get(key(state));
    if (!stateEntry) return '';
    const entry = stateEntry.districts.get(key(district));
    return entry ? entry.name : '';
};

/** The canonical spelling of a block within a district, or '' when unknown. */
const canonicalBlock = (state, district, block) => {
    const stateEntry = getIndex().get(key(state));
    if (!stateEntry) return '';
    const districtEntry = stateEntry.districts.get(key(district));
    if (!districtEntry) return '';
    return districtEntry.blocks.get(key(block)) || '';
};

const listStates = () => [...getIndex().values()]
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

const listDistricts = (state) => {
    const stateEntry = getIndex().get(key(state));
    if (!stateEntry) return [];
    return [...stateEntry.districts.values()]
        .map(entry => entry.name)
        .sort((a, b) => a.localeCompare(b));
};

const listBlocks = (state, district) => {
    const stateEntry = getIndex().get(key(state));
    if (!stateEntry) return [];
    const districtEntry = stateEntry.districts.get(key(district));
    if (!districtEntry) return [];
    return [...districtEntry.blocks.values()].sort((a, b) => a.localeCompare(b));
};

// Urban districts can have no development blocks. Unknown/custom districts
// keep the existing requirement rather than bypassing location validation.
const requiresBlock = (state, district) => !canonicalDistrict(state, district)
    || listBlocks(state, district).length > 0;

/**
 * Normalise a region triple to canonical spellings.
 *
 * Deliberately permissive at the leaves: a name the dataset does not carry is
 * returned trimmed rather than rejected, and flagged in `unknown`. The dataset
 * is a good reference, not a complete census — hard-failing on an unlisted but
 * real block would make it impossible to staff that block at all. Callers that
 * want strictness inspect `unknown` themselves.
 */
const normalizeRegion = ({ state, district, block } = {}) => {
    const rawState = String(state || '').trim().replace(/\s+/g, ' ');
    const rawDistrict = String(district || '').trim().replace(/\s+/g, ' ');
    const rawBlock = String(block || '').trim().replace(/\s+/g, ' ');

    if (!isLoaded()) {
        return {
            state: rawState,
            district: rawDistrict,
            block: rawBlock,
            unknown: { state: false, district: false, block: false }
        };
    }

    const okState = canonicalState(rawState);
    const okDistrict = okState ? canonicalDistrict(okState, rawDistrict) : '';
    const okBlock = okDistrict ? canonicalBlock(okState, okDistrict, rawBlock) : '';

    return {
        state: okState || rawState,
        district: okDistrict || rawDistrict,
        block: okBlock || rawBlock,
        unknown: {
            state: !!rawState && !okState,
            district: !!rawDistrict && !okDistrict,
            block: !!rawBlock && !okBlock
        }
    };
};

module.exports = {
    isLoaded,
    canonicalState,
    canonicalDistrict,
    canonicalBlock,
    listStates,
    listDistricts,
    listBlocks,
    requiresBlock,
    normalizeRegion,
    metadata: () => require('./data/india-geography.json').source,
    // Exposed for tests, which need a deterministic starting point.
    _reset: () => { index = null; }
};
