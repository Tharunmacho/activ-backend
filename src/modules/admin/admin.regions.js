const ApiError = require('../../core/utils/ApiError');
const adminRepository = require('./admin.repository');
const geography = require('../regions/geography');

/**
 * Region handling for admin creation and editing.
 *
 * The Super Admin's form is the remote control for the whole platform: whatever
 * region names they type become, immediately, the options an applicant sees.
 * So this module deliberately does **not** enforce a parent chain. Typing
 * "New Super Block" into a brand-new district in a brand-new state is a valid,
 * one-step way to open that region for registration.
 *
 * What it does instead is stop the same region existing twice under two
 * spellings, because that is what actually breaks routing: `buildGeoFilter`
 * matches an admin's region against an application's with an anchored regex, so
 * "Tamil Nadu" and "tamil  nadu" are two different regions, each with their own
 * half of the queue.
 *
 * Three rules, in order of preference:
 *   1. If a region with this name already exists in the admin database, reuse
 *      that exact spelling.
 *   2. Otherwise, if the canonical India reference recognises it, use that
 *      spelling.
 *   3. Otherwise accept it as typed, trimmed and whitespace-collapsed, and
 *      report it as new so the UI can say "this creates a new region".
 */

const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

/**
 * Every region name currently in use, indexed for spelling reuse.
 *
 * Districts and blocks are keyed by their parent too: two states can both have
 * an "Ariyalur" district, and collapsing them would make one adopt the other's
 * capitalisation.
 */
const buildKnownRegions = (admins = []) => {
    const states = new Map();
    const districts = new Map();
    const blocks = new Map();

    admins.forEach((admin) => {
        const state = clean(admin.state);
        const district = clean(admin.district);
        const block = clean(admin.block);

        if (state && !states.has(key(state))) states.set(key(state), state);
        if (state && district && !districts.has(`${key(state)}|${key(district)}`)) {
            districts.set(`${key(state)}|${key(district)}`, district);
        }
        if (state && district && block && !blocks.has(`${key(state)}|${key(district)}|${key(block)}`)) {
            blocks.set(`${key(state)}|${key(district)}|${key(block)}`, block);
        }
    });

    return { states, districts, blocks };
};

/**
 * The region names the Super Admin's form offers as suggestions.
 *
 * Suggestions only — the field stays free text. They exist so the common case
 * (adding a second admin to an existing district) does not depend on typing the
 * name identically by hand.
 */
const suggestRegions = async({ state = '', district = '' } = {}) => {
    const admins = await adminRepository.findActive();
    const known = buildKnownRegions(admins);

    const states = [...known.states.values()].sort((a, b) => a.localeCompare(b));

    const districts = state
        ? [...known.districts.entries()]
            .filter(([composite]) => composite.startsWith(`${key(state)}|`))
            .map(([, name]) => name)
            .sort((a, b) => a.localeCompare(b))
        : [];

    const blocks = (state && district)
        ? [...known.blocks.entries()]
            .filter(([composite]) => composite.startsWith(`${key(state)}|${key(district)}|`))
            .map(([, name]) => name)
            .sort((a, b) => a.localeCompare(b))
        : [];

    return {
        // What the admin database already knows — reusing one of these is what
        // keeps a region from splitting into two spellings.
        states,
        districts,
        blocks,
        // The canonical India reference, offered underneath as a starting point
        // for a region nobody has staffed yet.
        referenceStates: geography.listStates(),
        referenceDistricts: state ? geography.listDistricts(state) : [],
        referenceBlocks: (state && district) ? geography.listBlocks(state, district) : []
    };
};

/**
 * Validate and canonicalise the region for one admin account.
 *
 * Returns `{ state, district, block, created, warnings }`. `created` lists the
 * levels this account brings into existence, which the UI echoes back so the
 * Super Admin knows when they have just opened a new region for registration
 * rather than joining an existing one.
 */
const resolveRegion = async(role, payload = {}) => {
    const childRole = String(role || '').toLowerCase();
    if (!adminRepository.MANAGEABLE_ROLES.includes(childRole)) {
        throw ApiError.badRequest(`Role must be one of: ${adminRepository.MANAGEABLE_ROLES.join(', ')}`);
    }

    let state = clean(payload.state);
    let district = childRole === 'state_admin' ? '' : clean(payload.district);
    let block = childRole === 'block_admin' ? clean(payload.block) : '';

    if (!state) throw ApiError.badRequest('State is required');
    if (childRole !== 'state_admin' && !district) throw ApiError.badRequest('District is required');
    if (childRole === 'block_admin' && !block) throw ApiError.badRequest('Block is required');

    const admins = await adminRepository.findActive();
    const known = buildKnownRegions(admins);
    const reference = geography.normalizeRegion({ state, district, block });

    const created = [];
    const warnings = [];

    // State.
    const knownState = known.states.get(key(state));
    if (knownState) {
        state = knownState;
    } else if (!reference.unknown.state) {
        state = reference.state;
        created.push('state');
    } else {
        created.push('state');
        warnings.push(`"${state}" is not in the reference list of Indian states; it was saved as typed.`);
    }

    // District.
    if (district) {
        const knownDistrict = known.districts.get(`${key(state)}|${key(district)}`);
        if (knownDistrict) {
            district = knownDistrict;
        } else {
            const canonical = geography.canonicalDistrict(state, district);
            if (canonical) district = canonical;
            else warnings.push(`"${district}" is not in the reference list of districts for ${state}; it was saved as typed.`);
            created.push('district');
        }
    }

    // Block.
    if (block) {
        const knownBlock = known.blocks.get(`${key(state)}|${key(district)}|${key(block)}`);
        if (knownBlock) {
            block = knownBlock;
        } else {
            const canonical = geography.canonicalBlock(state, district, block);
            if (canonical) block = canonical;
            else warnings.push(`"${block}" is not in the reference list of blocks for ${district}; it was saved as typed.`);
            created.push('block');
        }
    }

    return { state, district, block, created, warnings };
};

module.exports = {
    buildKnownRegions,
    suggestRegions,
    resolveRegion
};
