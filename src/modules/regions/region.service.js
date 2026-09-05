const adminRepository = require('../admin/admin.repository');
const geography = require('./geography');

/**
 * The region tree, derived from the admin database.
 *
 * This module is the practical expression of "the admin database is the master
 * truth". Nothing here reads a static list of Indian regions to decide what an
 * applicant may choose — it reads who has actually been staffed, and offers
 * exactly those regions. An applicant physically cannot pick a block that has
 * nobody to review their file, so an orphaned application cannot be created.
 *
 * Coverage is defined bottom-up and deliberately strictly:
 *
 *   a block is selectable   <- it has >= 1 active block admin
 *   a district is selectable <- it has >= 1 selectable block
 *   a state is selectable    <- it has >= 1 selectable district
 *
 * Requiring the block level means every offered choice has a complete review
 * chain, because the hierarchical creation rules guarantee that a block admin
 * can only exist under a district admin, who can only exist under a state admin.
 */

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
let derived = { builtFrom: null, states: null, tree: null, fullTree: null };

class RegionService {
    /** The raw coverage map, rebuilt from the admin repository's cached scan. */
    async coverageMap({ fresh = false } = {}) {
        const admins = await adminRepository.findActive({ fresh });
        if (derived.builtFrom === admins && derived.states) return derived.states;

        const states = buildCoverage(admins);
        derived = { builtFrom: admins, states, tree: null, fullTree: null };
        return states;
    }

    /**
     * The region tree, in one of two shapes.
     *
     * `staffed` counts are carried on every node so the super admin's directory
     * can show where the platform is thin without a second round-trip, while the
     * applicant-facing endpoints only ever read the names.
     *
     * TWO SHAPES, BECAUSE "WHICH REGIONS EXIST" AND "WHICH REGIONS AN APPLICANT
     * MAY PICK" ARE DIFFERENT QUESTIONS, and answering both with one tree is
     * what made a state with a state admin and no block admins invisible to
     * everything.
     *
     *   prune: true (default)  the SELECTABLE tree. Bottom-up: a block needs a
     *          block admin, a district needs such a block, a state needs such a
     *          district. This is the registration contract — creating a block
     *          admin is what opens a region — and it is bottom-up precisely so
     *          it cannot offer an applicant a dead end.
     *
     *   prune: false           EVERY region the admin database knows, with its
     *          own staffing counts. A state carrying only a state admin appears,
     *          with however many districts its admins named — possibly none.
     *
     * The unpruned shape exists because the pruning rule, applied where it does
     * not belong, deletes real regions from the answer. Aiming an event at a
     * state whose only staffed account is its state admin is an ordinary thing
     * to want: that admin and every member standing in that state are a real
     * audience, and none of them needs a block admin to exist first. The event
     * picker was reading the applicant tree, so a platform with two staffed
     * states offered one, with nothing on screen to say the other had been
     * withheld or why.
     *
     * Cached in its own slot. Both shapes are derived from the same coverage map
     * and invalidate together with it, so one `builtFrom` identity check still
     * governs both.
     */
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

    /** State names an applicant may choose. */
    async listStates(options = {}) {
        const tree = await this.getTree(options);
        return tree.map(node => node.name);
    }

    /** District names an applicant may choose inside a state. */
    async listDistricts(state, options = {}) {
        const tree = await this.getTree(options);
        const node = tree.find(entry => key(entry.name) === key(state));
        return node ? node.districts.map(d => d.name) : [];
    }

    /** Block names an applicant may choose inside a district. */
    async listBlocks(state, district, options = {}) {
        const tree = await this.getTree(options);
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

    /**
     * Gate for registration and application submission.
     *
     * Returns `{ ok, reason, region }` rather than throwing, so callers can
     * decide between rejecting and merely warning. `region` carries the
     * canonical spellings from the admin database, which is what should be
     * stored — an applicant who typed a differently-cased block name would
     * otherwise fall outside their own admin's geofence regex.
     *
     * Bootstrap escape hatch: on a platform with no admins at all, coverage
     * cannot be enforced without locking everybody out, so an empty tree passes
     * and says so. That is the only case where an unstaffed region is accepted.
     */
    async validateRegion({ state, district, block } = {}, options = {}) {
        // Sequential, not Promise.all: `getTree()` calls `coverageMap()` itself,
        // and racing them meant two cold builds of the same map on a cache miss —
        // the single most expensive thing on the registration path.
        //
        // THE UNPRUNED TREE, matching what the applicant was offered. Validating
        // against the pruned one while the dropdown lists the full one is the
        // arrangement that rejects a region the form itself suggested.
        const tree = await this.getTree({ ...options, prune: false });
        const states = await this.coverageMap(options);

        // The bootstrap test is "does any geofenced admin exist at all", not
        // "is the tree empty". A platform with three state admins and no block
        // admins yet has an empty *selectable* tree, and treating that as
        // unstaffed would wave through every region in India — the exact hole
        // this gate exists to close. It is only skipped on a genuinely blank
        // platform, where enforcing coverage would lock everybody out.
        if (states.size === 0) {
            const normalized = geography.normalizeRegion({ state, district, block });
            return {
                ok: true,
                bootstrap: true,
                reason: 'No admins exist yet, so region coverage cannot be enforced',
                treeEmpty: tree.length === 0,
                region: {
                    state: normalized.state,
                    district: normalized.district,
                    block: normalized.block
                }
            };
        }

        /*
         * VALIDATED TO THE DEPTH THE APPLICANT ACTUALLY GAVE.
         *
         * This used to demand all three levels, matched against the PRUNED
         * tree — so the only acceptable region was one staffed all the way down
         * to a block admin. That made a state carrying only a state admin
         * unusable: it was missing from the dropdown, and typed in by hand it
         * was rejected for having no districts.
         *
         * What the gate is actually for is making sure an application does not
         * land in nobody's queue. A node exists in this tree only because a live
         * admin account names it, and `tierRouting.effectiveTier` walks up from
         * the tier the status names to the first one that has an admin. So a
         * state that is present here has an owner, whether or not anything below
         * it does, and requiring the two lower levels protected nothing.
         *
         * The levels below are still checked WHEN GIVEN, because a district that
         * is not in the tree is a typo or an unstaffed guess either way, and
         * accepting it would put the applicant in a region nothing routes from.
         * Skipping a level and filling the next is likewise refused: a block
         * without its district cannot be placed.
         */
        const stateNode = tree.find(entry => key(entry.name) === key(state));
        if (!stateNode) {
            return {
                ok: false,
                reason: `No active admin covers the state "${String(state || '').trim() || '(none selected)'}". Choose a state from the list.`,
                region: null
            };
        }

        const wantsDistrict = !!String(district || '').trim();
        const wantsBlock = !!String(block || '').trim();

        if (wantsBlock && !wantsDistrict) {
            return {
                ok: false,
                reason: 'Choose a district before choosing a block.',
                region: null
            };
        }

        let districtNode = null;
        if (wantsDistrict) {
            districtNode = stateNode.districts.find(entry => key(entry.name) === key(district));
            if (!districtNode) {
                return {
                    ok: false,
                    reason: `No active admin covers the district "${String(district).trim()}" in ${stateNode.name}. Choose a district from the list, or leave it blank.`,
                    region: null
                };
            }
        }

        let blockNode = null;
        if (wantsBlock) {
            blockNode = districtNode.blocks.find(entry => key(entry.name) === key(block));
            if (!blockNode) {
                return {
                    ok: false,
                    reason: `No active admin covers the block "${String(block).trim()}" in ${districtNode.name}. Choose a block from the list, or leave it blank.`,
                    region: null
                };
            }
        }

        return {
            ok: true,
            bootstrap: false,
            reason: '',
            // Canonical spellings, and empty for the levels that were not given.
            // Empty is meaningful downstream: `buildGeoFilter` reads a missing
            // level as "not narrowed to one", which is exactly the case here.
            region: {
                state: stateNode.name,
                district: districtNode ? districtNode.name : '',
                block: blockNode ? blockNode.name : ''
            }
        };
    }

    /** Drop the cached admin scan. Called after any admin write. */
    invalidate() {
        derived = { builtFrom: null, states: null, tree: null };
        adminRepository.invalidate();
    }
}

module.exports = new RegionService();
module.exports.buildCoverage = buildCoverage;
