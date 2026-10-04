const adminRepository = require('../admin/admin.repository');
const geography = require('./geography');

/** Location choices come from LGD; review coverage comes from active admins. */

const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Bucket the active admins by role, keeping the first-seen canonical spelling. */
const buildCoverage = (admins) => {
    // stateKey -> { name, admins:[], districts: Map }
    const states = new Map();

    const stateNode = (name) => {
        const k = key(name);
        if (!k) return null;
        if (!states.has(k)) {
            states.set(k, { name: String(name).trim(), admins: [], districts: new Map() });
        }
        return states.get(k);
    };

    const districtNode = (stateName, name) => {
        const parent = stateNode(stateName);
        if (!parent) return null;
        const k = key(name);
        if (!k) return null;
        if (!parent.districts.has(k)) {
            parent.districts.set(k, { name: String(name).trim(), admins: [], blocks: new Map() });
        }
        return parent.districts.get(k);
    };

    const blockNode = (stateName, districtName, name) => {
        const parent = districtNode(stateName, districtName);
        if (!parent) return null;
        const k = key(name);
        if (!k) return null;
        if (!parent.blocks.has(k)) {
            parent.blocks.set(k, { name: String(name).trim(), admins: [] });
        }
        return parent.blocks.get(k);
    };

    (admins || []).forEach((admin) => {
        if (admin.role === 'state_admin') {
            const node = stateNode(admin.state);
            if (node) node.admins.push(admin);
        } else if (admin.role === 'district_admin') {
            const node = districtNode(admin.state, admin.district);
            if (node) node.admins.push(admin);
        } else if (admin.role === 'block_admin') {
            const node = blockNode(admin.state, admin.district, admin.block);
            if (node) node.admins.push(admin);
        }
        // super_admin is not geofenced and belongs to no node.
    });

    return states;
};

const summarise = (admins) => (admins || []).map(a => ({
    id: a.id,
    fullName: a.fullName,
    email: a.email
}));

/**
 * Derived-view cache.
 *
 * `adminRepository` already caches the admin *rows*, but every caller here then
 * rebuilt the coverage Maps and re-sorted the whole tree from those rows —
 * ~7,700 records bucketed, summarised and sorted, on every single request. The
 * registration screen alone asks for states, then districts, then blocks, then
 * validates, and `validateRegion` used to build it twice by itself.
 *
 * `builtFrom` is identity-compared against the rows array the repository hands
 * back. That array is replaced whenever the repository's own cache is refilled
 * or invalidated, so this cache expires exactly when the underlying data does —
 * it cannot go stale independently, and no second TTL has to be kept in sync.
 */
let derived = { builtFrom: null, states: null, tree: null, fullTree: null, locations: null };

class RegionService {
    /** The raw coverage map, rebuilt from the admin repository's cached scan. */
    async coverageMap({ fresh = false } = {}) {
        const admins = await adminRepository.findActive({ fresh });
        if (derived.builtFrom === admins && derived.states) return derived.states;

        const states = buildCoverage(admins);
        derived = { builtFrom: admins, states, tree: null, fullTree: null, locations: null };
        return states;
    }

    /** Admin coverage only. Used for staffing reports, never to restrict location choices. */
    async getTree(options = {}) {
        const prune = options.prune !== false;
        const slot = prune ? 'tree' : 'fullTree';

        const states = await this.coverageMap(options);
        if (derived.states === states && derived[slot]) return derived[slot];

        const tree = [];
        states.forEach((stateNode) => {
            const districts = [];

            stateNode.districts.forEach((districtNode) => {
                const blocks = [];
                districtNode.blocks.forEach((blockNode) => {
                    if (prune && blockNode.admins.length === 0) return;
                    blocks.push({
                        name: blockNode.name,
                        admins: blockNode.admins.length,
                        adminList: summarise(blockNode.admins)
                    });
                });

                if (prune && blocks.length === 0) return;
                blocks.sort((a, b) => a.name.localeCompare(b.name));

                districts.push({
                    name: districtNode.name,
                    admins: districtNode.admins.length,
                    adminList: summarise(districtNode.admins),
                    blocks
                });
            });

            if (prune && districts.length === 0) return;
            districts.sort((a, b) => a.name.localeCompare(b.name));

            tree.push({
                name: stateNode.name,
                admins: stateNode.admins.length,
                adminList: summarise(stateNode.admins),
                districts
            });
        });

        tree.sort((a, b) => a.name.localeCompare(b.name));

        // Only cache a tree built from the map currently cached. A `fresh` read
        // may have replaced `derived` underneath this call.
        if (derived.states === states) derived[slot] = tree;
        return tree;
    }

    /**
     * National locations plus any custom regions already used by active admins.
     * Staffing remains a separate count; selecting an unstaffed location never
     * creates an admin account or changes a regional admin's geofence.
     */
    async getLocationTree(options = {}) {
        const coverage = await this.coverageMap(options);
        if (derived.states === coverage && derived.locations) return derived.locations;
        // Keep the existing admin spelling so stored applications still match
        // their reviewers. Fresh LGD names fill the unstaffed parts of the tree.
        const counts = node => ({ name: node.name, admins: node.admins.length, adminList: summarise(node.admins) });
        const states = new Map([...coverage.values()].map(state => [key(state.name), {
            ...counts(state),
            districts: new Map([...state.districts.values()].map(district => [key(district.name), {
                ...counts(district),
                blocks: new Map([...district.blocks.values()].map(block => [key(block.name), counts(block)]))
            }]))
        }]));
        for (const name of geography.listStates()) {
            let state = states.get(key(name));
            if (!state) {
                state = { name, admins: 0, adminList: [], districts: new Map() };
                states.set(key(name), state);
            }
            for (const districtName of geography.listDistricts(name)) {
                let district = state.districts.get(key(districtName));
                if (!district) {
                    district = { name: districtName, admins: 0, adminList: [], blocks: new Map() };
                    state.districts.set(key(districtName), district);
                }
                for (const blockName of geography.listBlocks(name, districtName)) {
                    if (!district.blocks.has(key(blockName))) {
                        district.blocks.set(key(blockName), { name: blockName, admins: 0, adminList: [] });
                    }
                }
            }
        }
        const sorted = values => [...values].sort((a, b) => a.name.localeCompare(b.name));
        const tree = sorted(states.values()).map(state => ({
            ...state,
            districts: sorted(state.districts.values()).map(district => ({
                ...district, blocks: sorted(district.blocks.values())
            }))
        }));
        if (derived.states === coverage) derived.locations = tree;
        return tree;
    }

    /** State names an applicant may choose. */
    async listStates(options = {}) {
        const tree = await this.getLocationTree(options);
        return tree.map(node => node.name);
    }

    /** District names an applicant may choose inside a state. */
    async listDistricts(state, options = {}) {
        const tree = await this.getLocationTree(options);
        const node = tree.find(entry => key(entry.name) === key(state));
        return node ? node.districts.map(d => d.name) : [];
    }

    /** Block names an applicant may choose inside a district. */
    async listBlocks(state, district, options = {}) {
        const tree = await this.getLocationTree(options);
        const stateNode = tree.find(entry => key(entry.name) === key(state));
        if (!stateNode) return [];
        const districtNode = stateNode.districts.find(entry => key(entry.name) === key(district));
        return districtNode ? districtNode.blocks.map(b => b.name) : [];
    }

    /**
     * How many active admins sit at each tier above and at a region.
     *
     * This is what orphan fallback routing is decided on: a tier with a count of
     * zero cannot review anything, so its queue bubbles up to the first tier
     * above it that still has someone.
     */
    async coverageFor({ state, district, block } = {}, options = {}) {
        const states = await this.coverageMap(options);

        const stateNode = states.get(key(state)) || null;
        const districtNode = stateNode ? (stateNode.districts.get(key(district)) || null) : null;
        const blockNode = districtNode ? (districtNode.blocks.get(key(block)) || null) : null;

        return {
            state: stateNode ? stateNode.admins.length : 0,
            district: districtNode ? districtNode.admins.length : 0,
            block: blockNode ? blockNode.admins.length : 0
        };
    }

    /**
     * Coverage for many regions at once.
     *
     * A dashboard classifies up to a few hundred applications per load and each
     * one needs to know whether its block is staffed. Resolving them against one
     * already-built map keeps that a single scan instead of N.
     */
    async coverageResolver(options = {}) {
        const states = await this.coverageMap(options);

        return (region = {}) => {
            const stateNode = states.get(key(region.state)) || null;
            const districtNode = stateNode ? (stateNode.districts.get(key(region.district)) || null) : null;
            const blockNode = districtNode ? (districtNode.blocks.get(key(region.block)) || null) : null;

            return {
                state: stateNode ? stateNode.admins.length : 0,
                district: districtNode ? districtNode.admins.length : 0,
                block: blockNode ? blockNode.admins.length : 0
            };
        };
    }

    /** True when at least one region anywhere is selectable. */
    async hasAnyCoverage(options = {}) {
        const tree = await this.getTree(options);
        return tree.length > 0;
    }

    /** Validate parentage using national locations and existing custom admin regions. */
    async validateRegion({ state, district, block } = {}, options = {}) {
        const tree = await this.getLocationTree(options);
        const invalid = reason => ({ ok: false, reason, region: null });
        const stateNode = tree.find(entry => key(entry.name) === key(state));
        if (!stateNode) return invalid('Choose a valid state or union territory from the list.');
        const wantsDistrict = !!String(district || '').trim();
        const wantsBlock = !!String(block || '').trim();
        if (wantsBlock && !wantsDistrict) return invalid('Choose a district before choosing a block.');
        const districtNode = wantsDistrict
            ? stateNode.districts.find(entry => key(entry.name) === key(district)) : null;
        if (wantsDistrict && !districtNode) return invalid(`Choose a district from ${stateNode.name}.`);
        const blockNode = wantsBlock
            ? districtNode.blocks.find(entry => key(entry.name) === key(block)) : null;
        if (wantsBlock && !blockNode) return invalid(`Choose a block from ${districtNode.name}.`);
        const region = {
            state: stateNode.name,
            district: districtNode ? districtNode.name : '',
            block: blockNode ? blockNode.name : ''
        };
        const coverage = await this.coverageFor(region);
        return {
            ok: true, bootstrap: false, reason: '', region, coverage,
            reviewBy: coverage.state || coverage.district || coverage.block ? 'regional_admins' : 'super_admin'
        };
    }

    /** Drop the cached admin scan. Called after any admin write. */
    invalidate() {
        derived = { builtFrom: null, states: null, tree: null, fullTree: null, locations: null };
        adminRepository.invalidate();
    }
}

module.exports = new RegionService();
module.exports.buildCoverage = buildCoverage;
