const mongoose = require('mongoose');
const bcrypt = require('../common/passwordHash');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const ApiError = require('../../core/utils/ApiError');
const { normalizeStatus, isPending, PENDING_STORED_STATUSES } = require('../common/applicationStatus');
const adminService = require('./admin.service');
const auditService = require('../audit/audit.service');
const adminRepository = require('./admin.repository');
const cacheClient = require('../../core/cache/cacheClient');
const { CACHE_KEYS } = require('../../core/cache/cacheKeys');
const adminRegions = require('./admin.regions');
const regionService = require('../regions/region.service');
const tierRouting = require('../common/tierRouting');
const tierReviews = require('../common/tierReviews');

const { buildApplicant, escapeRegex, LEVELS, classifyForLevel } = adminService;

// An application counts as a bottleneck once it has sat at one tier this long.
const BOTTLENECK_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Upper bound on a single global scan. The super admin is not geofenced, so
// every query here can see the whole collection — cap it, or one dashboard load
// turns into a multi-second stall on a large database.
const GLOBAL_FETCH_LIMIT = 500;
const SEARCH_LIMIT = 8;

// Admin accounts are spread over five collections in two databases; every read
// and write goes through the repository so this module never has to know that.
const PRIMARY_ADMIN_COLLECTION = adminRepository.PRIMARY_COLLECTION;

const MANAGEABLE_ROLES = adminRepository.MANAGEABLE_ROLES;

// ============================================================ delegation

/**
 * Which tiers an admin may manage, and where.
 *
 * A state admin runs a state: every district inside it and every block inside
 * those. A district admin runs a district: the blocks inside it. Neither may
 * touch their own tier or anything above it, and neither may reach outside their
 * own patch — which is the same rule the application queues already enforce with
 * `assertWithinScope`, applied to the staff records rather than to the files.
 *
 * Written as data rather than as branches because every entry point below —
 * list, create, update, delete, removal preview — has to ask the same two
 * questions, and five copies of "is this role beneath mine, is this region
 * inside mine" is five chances for one of them to be subtly different. The
 * dangerous one is create: an escalation bug there hands out an account with
 * more power than the account that made it.
 */
const MANAGEABLE_BY = {
    super_admin: ['state_admin', 'district_admin', 'block_admin'],
    state_admin: ['district_admin', 'block_admin'],
    district_admin: ['block_admin'],
    // A block admin has nothing beneath them. Not absent — explicitly empty, so
    // a lookup returns a list rather than `undefined`.
    block_admin: []
};

/** The tiers this actor may see and manage. Empty means "manages nobody". */
const manageableRoles = (actor = {}) =>
    MANAGEABLE_BY[adminRepository.normalizeRole(actor.role || actor.adminType || '')] || [];

const sameRegion = (a, b) =>
    String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * The actor's patch, resolved the way every geofenced read resolves it.
 *
 * Through `resolveAdminScope` rather than off the token, for the reason that
 * function documents at length: the location claims are missing from tokens
 * minted on some sign-in paths, and an admin whose scope came back empty would
 * otherwise be treated as unrestricted — the exact inversion of the rule.
 */
const actorScope = async (actor = {}) => {
    const role = adminRepository.normalizeRole(actor.role || actor.adminType || '');
    if (role === 'super_admin') return { role, state: '', district: '', block: '' };

    const scope = await adminService.resolveAdminScope(actor);
    return {
        role,
        state: scope.stateName || '',
        district: scope.districtName || '',
        block: scope.blockName || ''
    };
};

/**
 * The region every listing and every write is forced into.
 *
 * Returned as the filter itself rather than as a boolean to check afterwards:
 * a caller that forgets to apply a returned filter fails open, and failing open
 * here means a district admin editing another district's staff.
 */
const scopeFilter = (scope = {}) => {
    if (scope.role === 'super_admin') return {};
    if (scope.role === 'state_admin') return { state: scope.state };
    if (scope.role === 'district_admin') return { state: scope.state, district: scope.district };
    // Anything else manages nobody. `null` rather than a filter that matches
    // nothing: callers can then answer "an empty list" outright instead of
    // running a query designed never to match, and the intent is readable.
    return null;
};

/**
 * A coverage lookup memoised per region, for one request.
 *
 * Coverage answers "is this block staffed", and both the placement of a file and
 * whether the caller may decide it depend on it. Fetching it per application
 * would run one lookup per row against the admin collections; a page of fifty
 * files in one block needs exactly one.
 *
 * A failed lookup resolves to `null` and is cached as such: `effectiveTier` then
 * falls back to the tier the status names, which is the conservative answer — an
 * unknown is not "nobody is there".
 */
const coverageResolver = () => {
    const cache = new Map();

    /**
     * THE PROMISE GOES IN THE MAP, NOT THE RESOLVED VALUE.
     *
     * This stored the awaited result: `cache.set(key, await coverageFor(...))`.
     * Read sequentially that memoises perfectly, and every caller reads it
     * CONCURRENTLY — `decorateDecidability` runs `Promise.all` over the page, so
     * all fifty rows reach the `has(key)` test in the same tick, all fifty find
     * it false, and all fifty start their own lookup. The memo saved nothing on
     * the one path that uses it.
     *
     * Storing the in-flight promise makes the second caller await the first
     * one's work, which is what a memo is for. Fifty rows in one block are one
     * lookup again.
     *
     * `.catch` is attached where the promise is created, so a rejection is
     * settled once rather than once per awaiting row — and a failed lookup
     * caches as `null`, which `tierRouting` reads as "staffing unknown" and
     * treats conservatively.
     */
    return (app = {}) => {
        const key = [app.state, app.district, app.block]
            .map(v => String(v || '').trim().toLowerCase()).join('|');

        if (!cache.has(key)) {
            cache.set(key, regionService
                .coverageFor({ state: app.state, district: app.district, block: app.block })
                .catch(() => null));
        }
        return cache.get(key);
    };
};

/**
 * May this actor act on this admin record?
 *
 * Throws rather than returning false, so a caller cannot proceed by ignoring the
 * answer. `notFound` rather than `forbidden` for a record outside the patch: an
 * id from another region is not a permission that could ever be granted, and
 * "exists, but not yours" tells a district admin that a state's staffing exists.
 */
const assertManageable = (target = {}, scope = {}) => {
    if (scope.role === 'super_admin') return;

    const allowed = MANAGEABLE_BY[scope.role] || [];
    const targetRole = adminRepository.normalizeRole(target.role || '');

    if (!allowed.includes(targetRole)) {
        throw ApiError.forbidden(`A ${scope.role.replace('_', ' ')} cannot manage a ${targetRole.replace('_', ' ')}`);
    }
    if (scope.state && !sameRegion(target.state, scope.state)) throw ApiError.notFound('Admin not found');
    if (scope.role === 'district_admin' && !sameRegion(target.district, scope.district)) {
        throw ApiError.notFound('Admin not found');
    }
};

const ROLE_LABELS = adminRepository.ROLE_LABELS;

/*
 * There is no "blocked tier" any more.
 *
 * This mapped a pending status to the one tier that owed a decision, so a stuck
 * file could name whoever was sitting on it. A pending file is with all three
 * tiers of its region at once now, and naming one of them would be picking a
 * scapegoat rather than reporting a fact. `bottlenecks` says that in words.
 */
const HOLDING_ALL_TIERS = 'Block, District and State';

const col = adminRepository.col;

/**
 * How long a Hub answer is reused. The dashboards' number, deliberately.
 *
 * `admin.service.cachedDashboard` settled on 120s for exactly this shape of
 * work: ten round trips to a remote cluster, an answer that only changes when
 * somebody decides an application or staffs a region, and both of those events
 * clearing the key outright. The Hub was the one admin surface left paying the
 * full cost on every visit — a state admin's Hub fires TWO directory calls on
 * load and the super admin's three, each a fresh scan of the applications and
 * the whole admin roster, and the answer is identical every time.
 */
const HUB_TTL_SECONDS = 120;

/**
 * A tier may only drill DOWN.
 *
 * A district admin asking for `level=state` would otherwise be handed a row per
 * state — every one outside their patch, with counts drawn from applications
 * they cannot open. The level is clamped to what sits beneath them; the parent
 * region is forced separately in `computeDirectory`, and the two together mean
 * a request can only ever describe its own ground. A super admin keeps all
 * three and is forced to nothing.
 *
 * Shared by the cache key and the query it keys, because they have to agree:
 * keying on the level as ASKED would file a district admin's `level=state`
 * request — which answers with blocks — under "state", and hand those blocks to
 * the next caller who asked for states.
 */
const allowedLevelsFor = (role) =>
    role === 'district_admin' ? ['block']
        : role === 'state_admin' ? ['district', 'block']
            : ['state', 'district', 'block'];

const resolveLevel = (role, asked) => {
    const allowed = allowedLevelsFor(role);
    const want = String(asked || '').toLowerCase();
    return allowed.includes(want) ? want : allowed[0];
};

/**
 * Read through the cache, and never let the cache break the request.
 *
 * A failing cache must degrade to a slow answer, not to no answer: both halves
 * are caught, so an unreachable Redis (this deployment falls back to an
 * in-process map, and that fallback can itself be cold) costs latency and
 * nothing else.
 */
const cached = async(key, ttlSeconds, build) => {
    const hit = await cacheClient.get(key).catch(() => null);
    if (hit) return hit;

    const payload = await build();
    await cacheClient.set(key, payload, ttlSeconds).catch(() => null);
    return payload;
};

const rx = (value) => new RegExp(escapeRegex(String(value || '')), 'i');
const rxExact = (value) => new RegExp(`^${escapeRegex(String(value || ''))}$`, 'i');

/**
 * Which tier's dashboard a global row should be rendered as.
 *
 * It used to matter: `buildApplicant` rendered from one tier's point of view and
 * the same application meant different things to each, so this picked the tier
 * that currently owned the file. All three tiers see the same three buckets
 * now, so the answer only decides the `level` label on the row. Block is the
 * applicant's own smallest region and is the honest default.
 */
const levelForApplication = () => LEVELS.BLOCK;

/**
 * The review seat an admin ROLE sits in.
 *
 * `super_admin` maps to `'super'`, which `tierReviews` resolves to the deciding
 * seat — the State's. That is deliberate and it is the whole reason a region
 * with no state admin is not a region where nobody can be enrolled.
 */
const ROLE_TIER = {
    block_admin: 'block',
    district_admin: 'district',
    state_admin: 'state',
    super_admin: 'super'
};

/**
 * The dashboard level a role reads by DEFAULT, when it has not asked for one.
 *
 * `levelForApplication` returned Block for everybody, which was harmless while
 * all three tiers shared one verdict and is not any more: the level decides
 * which tier's verdict a row renders as, so a State admin opening the Hub was
 * shown the BLOCK's answer for every applicant — a pending badge on a file they
 * had themselves approved.
 *
 * `super_admin` lands on `state` rather than `block`, matching the seat they
 * fill in `ROLE_TIER`. What they see and what they can sign then agree.
 */
const ROLE_LEVEL = {
    block_admin: LEVELS.BLOCK,
    district_admin: LEVELS.DISTRICT,
    state_admin: LEVELS.STATE,
    super_admin: LEVELS.STATE
};

/**
 * How long this applicant has been waiting.
 *
 * FROM SUBMISSION, always. This used to restart the clock each time the file
 * cleared a tier, because each tier was answerable only for its own leg of the
 * relay. Nobody hands the file on any more - it has been in front of all three
 * admins since the day it arrived - so the only honest measure of the wait is
 * how long the applicant has been waiting.
 */
const waitingSince = (application = {}) => application.createdAt || null;

const daysSince = (date) => {
    if (!date) return 0;
    const then = new Date(date).getTime();
    if (Number.isNaN(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / DAY_MS));
};

/** Hydrate a page of applications with their member profiles, then flatten. */
const toApplicants = async(applications, requestedLevel) => {
    const list = applications || [];
    const emails = [...new Set(
        list.map(app => String(app?.email || '').toLowerCase()).filter(Boolean)
    )];

    const memberByEmail = {};
    if (emails.length > 0) {
        const memberDocs = await Member.find({ email: { $in: emails } }).lean().catch(() => []);
        (memberDocs || []).forEach(doc => {
            memberByEmail[String(doc?.email || '').toLowerCase()] = doc;
        });
    }

    return list.map((app, index) => buildApplicant(
        app,
        memberByEmail[String(app?.email || '').toLowerCase()] || {},
        index,
        requestedLevel || levelForApplication(app)
    ));
};

/** Normalise an admin document from any of the admin collections. */
const toAdminRow = adminRepository.toAdminRow;

class SuperAdminService {
    /**
     * The Action Hub payload: platform-wide counters plus the files that have
     * been stuck at one tier long enough to need a super-admin override.
     */
    async getOverview() {
        // One answer for every super admin, cleared by any decision — see the
        // note on `ADMIN_OVERVIEW` in `cacheKeys`.
        return cached(CACHE_KEYS.ADMIN_OVERVIEW, HUB_TTL_SECONDS, () => this.computeOverview());
    }

    async computeOverview() {
        const [totalMembers, applications, allAdmins] = await Promise.all([
            Member.countDocuments().catch(() => 0),
            Application.find({})
            .sort({ createdAt: -1 })
            .limit(GLOBAL_FETCH_LIMIT)
            .lean()
            .catch(() => []),
            this.allAdminRows()
        ]);

        const counts = { pending: 0, approved: 0, rejected: 0 };
        /*
         * `tierQueue` counted how many files were sitting at each tier - the
         * shape of the relay. Every pending file is at all three tiers now, so
         * the three figures would be the same number printed three times.
         * Emitted as the pending total in each slot so the existing clients do
         * not read `undefined`, and no longer meaningful as a breakdown.
         */
        const stuck = [];
        const tierStats = {
            block: { total: 0, pending: 0, approved: 0, rejected: 0 },
            district: { total: 0, pending: 0, approved: 0, rejected: 0 },
            state: { total: 0, pending: 0, approved: 0, rejected: 0 }
        };

        (applications || []).forEach(app => {
            const status = normalizeStatus(app.status);

            if (status === 'Approved') counts.approved += 1;
            else if (status === 'Rejected') counts.rejected += 1;
            else counts.pending += 1;

            /*
             * The three tiers see the same file, so they see the same figures.
             * Kept as three rows because the Hub prints a card per tier and the
             * cards are about REGIONS - how many applicants sit under each
             * level of the geography - which is still a real question.
             */
            // Each card counts ITS OWN tier's verdict. This was one call with no
            // level, which classifies by the Block's verdict, so all three
            // cards printed the Block's answer.
            ['block', 'district', 'state'].forEach((tier) => {
                const stage = classifyForLevel(app, tier);
                tierStats[tier].total += 1;
                if (stage === 'pending') tierStats[tier].pending += 1;
                else if (stage === 'approved') tierStats[tier].approved += 1;
                else if (stage === 'rejected') tierStats[tier].rejected += 1;
            });

            const since = waitingSince(app);
            const stuckDays = daysSince(since);
            if (stuckDays >= BOTTLENECK_DAYS && isPending(status)) {
                stuck.push({ app, stuckDays, since, status });
            }
        });

        const tierQueue = { block: counts.pending, district: counts.pending, state: counts.pending };

        stuck.sort((a, b) => b.stuckDays - a.stuckDays);
        const top = stuck.slice(0, 20);
        const bottleneckApplicants = await toApplicants(top.map(row => row.app));

        const bottlenecks = bottleneckApplicants.map((applicant, index) => ({
            ...applicant,
            stuckDays: top[index]?.stuckDays || 0,
            waitingSince: top[index]?.since || null,
            // Every tier that could have cleared it and none of them has. The
            // super admin is not standing in for one of them when they act -
            // they are doing what all three were equally able to do.
            blockedTier: HOLDING_ALL_TIERS
        }));

        const adminCounts = { 
            block_admin: 0, 
            district_admin: 0, 
            state_admin: 0, 
            super_admin: 0 
        };
        (allAdmins || []).forEach(doc => {
            const role = String(doc.role || '').toLowerCase();
            if (role === 'block_admin') adminCounts.block_admin += 1;
            else if (role === 'district_admin') adminCounts.district_admin += 1;
            else if (role === 'state_admin') adminCounts.state_admin += 1;
            else if (role === 'super_admin') adminCounts.super_admin += 1;
        });

        const totalAdminsCount = adminCounts.block_admin + adminCounts.district_admin + adminCounts.state_admin + adminCounts.super_admin;

        const coverageGaps = await this.coverageGaps(applications);

        return {
            stats: {
                totalMembers: (applications || []).length, // Forced to match totalApplications to fix UI cache issue
                totalApplications: (applications || []).length,
                pendingApplications: counts.pending,
                approvedApplications: counts.approved,
                rejectedApplications: counts.rejected,
                totalAdmins: totalAdminsCount,
                bottleneckCount: stuck.length,
                escalatedCount: coverageGaps.reduce((sum, gap) => sum + gap.pending, 0)
            },
            tierStats,
            tierQueue,
            adminCounts,
            bottleneckAfterDays: BOTTLENECK_DAYS,
            bottlenecks,
            coverageGaps
        };
    }

    /**
     * Regions holding pending applications that NOBODY can act on.
     *
     * This used to report a region whose own tier was unstaffed, because under
     * the relay that file could not move until the tier above absorbed it. A
     * missing block admin is not a gap any more - the district and state admin
     * of that region were already holding the same file and either can clear it.
     *
     * What is still a gap, and a worse one, is a region with no admin at ANY
     * tier: its applicants are reachable only by the Super Admin. That is what
     * this reports now. Sorted by how many applicants are waiting, because that
     * is the order the vacancies should be filled in.
     */
    async coverageGaps(applications = []) {
        const coverageFor = await regionService.coverageResolver().catch(() => null);
        if (!coverageFor) return [];

        const gaps = new Map();

        (applications || []).forEach((app) => {
            if (!isPending(app.status)) return;

            const region = { state: app.state, district: app.district, block: app.block };
            const coverage = coverageFor(region);
            if (!tierRouting.isUnattended(coverage)) return;

            // Keyed on the applicant's own block, which is the most specific
            // region the vacancy covers - so one unstaffed block is one row
            // however many applications are sitting in it.
            const place = [app.block, app.district, app.state];
            const missing = tierRouting.unstaffedTiers(coverage);

            const id = `unattended|${place.join('|').toLowerCase()}`;
            if (!gaps.has(id)) {
                gaps.set(id, {
                    id,
                    missingTier: missing[0] || 'block',
                    missingTierLabel: missing
                        .map(tier => tierRouting.TIER_LABELS[tier])
                        .join(', ') || 'Block',
                    escalatedTo: 'super',
                    escalatedToLabel: 'Super',
                    block: place[0],
                    district: place[1],
                    state: place[2],
                    region: place.filter(Boolean).join(', '),
                    pending: 0
                });
            }
            gaps.get(id).pending += 1;
        });

        return [...gaps.values()].sort((a, b) => b.pending - a.pending);
    }

    /**
     * Cross-collection lookup behind the search bar. Members, applications and
     * admins come back as separate groups so the client never has to guess what
     * a row is.
     */
    async search(query = '') {
        const term = String(query || '').trim();
        if (term.length < 2) return { query: term, members: [], applications: [], admins: [] };

        const pattern = rx(term);
        const anyOf = (fields) => ({ $or: fields.map(field => ({ [field]: pattern })) });

        const [memberDocs, applicationDocs, adminDocs] = await Promise.all([
            Member.find(anyOf(['fullName', 'email', 'phoneNumber', 'block', 'district', 'state']))
            .select('fullName email phoneNumber block district state')
            .limit(SEARCH_LIMIT)
            .lean()
            .catch(() => []),
            Application.find(anyOf(['fullName', 'email', 'phone', 'block', 'district', 'state']))
            .select('fullName email phone block district state status createdAt')
            .sort({ createdAt: -1 })
            .limit(SEARCH_LIMIT)
            .lean()
            .catch(() => []),
            col(PRIMARY_ADMIN_COLLECTION)
            .find(anyOf(['fullName', 'name', 'email', 'block', 'district', 'state']))
            .limit(SEARCH_LIMIT)
            .toArray()
            .catch(() => [])
        ]);

        const place = (...parts) => parts.filter(Boolean).join(', ');

        return {
            query: term,
            members: (memberDocs || []).map(doc => ({
                id: doc._id ? doc._id.toString() : '',
                fullName: doc.fullName || '',
                email: doc.email || '',
                phone: doc.phoneNumber || '',
                location: place(doc.block, doc.district, doc.state)
            })),
            applications: (applicationDocs || []).map(doc => ({
                id: doc._id ? doc._id.toString() : '',
                fullName: doc.fullName || '',
                email: doc.email || '',
                status: normalizeStatus(doc.status),
                location: place(doc.block, doc.district, doc.state)
            })),
            admins: (adminDocs || []).map(doc => {
                const row = toAdminRow(doc);
                return {
                    id: row.id,
                    fullName: row.fullName,
                    email: row.email,
                    roleLabel: row.roleLabel,
                    location: place(row.block, row.district, row.state)
                };
            })
        };
    }

    /**
     * God view over the applications collection: no geofence, filtered only by
     * what the super admin asked for.
     */
    async getApplications(filters = {}, actor = {}) {
        /*
         * The actor's patch overrides whatever was asked for.
         *
         * A super admin passes no scope and this is a no-op — which is why their
         * screen behaves exactly as it did. A district admin asking for another
         * district gets their own: forced rather than rejected, so a stale
         * bookmark narrows to something they may see instead of erroring.
         */
        const scope = await actorScope(actor);
        if (scope.role === 'state_admin') filters = { ...filters, state: scope.state };
        if (scope.role === 'district_admin') filters = { ...filters, state: scope.state, district: scope.district };

        /*
         * =================================================================
         * CACHED FOR THE WAY THE HUB ACTUALLY USES IT, AND NOT OTHERWISE
         * =================================================================
         *
         * The drill-down opens a region, the admin decides something, and the
         * screen refetches this exact list — the same three or four regions,
         * over and over, each costing two round trips to a remote cluster.
         * That is the dashboards' own shape of work, so it gets the dashboards'
         * own treatment: the same TTL, the same `admin:dashboard:` prefix, and
         * therefore the same clearing on every approve and reject.
         *
         * A SEARCH IS NOT CACHED. `q` is free text a person types a character
         * at a time; keying on it would mint an entry per keystroke and evict
         * everything worth keeping to hold answers nobody will ask for twice.
         * Paging past the first page is left alone for the same reason — it is
         * a deliberate, one-off move, not the hot path.
         *
         * Note the key is built AFTER the scope is forced above, so a district
         * admin and a super admin asking about the same block are two different
         * keys.
         */
        const searching = !!(filters.q && String(filters.q).trim().length >= 2);
        const firstPage = Math.max(1, parseInt(filters.page, 10) || 1) === 1;

        if (!searching && firstPage) {
            const key = 'admin:dashboard:applications:' + [
                scope.role || 'unknown',
                filters.level || '',
                filters.status || 'all',
                filters.state || '',
                filters.district || '',
                filters.block || '',
                filters.limit || '',
            ].map(v => String(v).trim().toLowerCase()).join('|');

            return cached(key, HUB_TTL_SECONDS, () => this.computeApplications(filters, scope));
        }

        return this.computeApplications(filters, scope);
    }

    async computeApplications(filters = {}, scope = {}) {
        const { status, state, district, block, q, level } = filters;
        const page = Math.max(1, parseInt(filters.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 25));

        const conditions = [];
        if (state) conditions.push({ state: rxExact(state) });
        if (district) conditions.push({ district: rxExact(district) });
        if (block) conditions.push({ block: rxExact(block) });
        if (q && String(q).trim().length >= 2) {
            const pattern = rx(String(q).trim());
            conditions.push({ $or: [{ fullName: pattern }, { email: pattern }, { phone: pattern }] });
        }

        const mongoFilter = conditions.length > 0 ? { $and: conditions } : {};

        // Status is filtered in memory, not in Mongo: the collection holds three
        // different spellings of every status, so only normalizeStatus can bucket
        // a row correctly.
        const documents = await Application.find(mongoFilter)
            .sort({ createdAt: -1 })
            .limit(GLOBAL_FETCH_LIMIT)
            .lean()
            .catch(() => []);

        const validLevels = { block: LEVELS.BLOCK, district: LEVELS.DISTRICT, state: LEVELS.STATE };
        const requestedLevel = validLevels[String(level || '').toLowerCase()];

        /*
         * WHICH TIER'S VERDICT THIS PAGE IS SHOWING.
         *
         * The level being browsed when one was asked for; otherwise the reader's
         * own seat. It has to be one value for both the pills and the rows — a
         * page whose "Pending" filter counts the block's verdicts while the
         * badges print the state's is a page whose filter appears broken.
         */
        const viewLevel = requestedLevel || ROLE_LEVEL[scope.role] || LEVELS.BLOCK;

        /*
         * The filter pills, which mean THIS TIER'S VERDICT.
         *
         * "Pending" is "waiting on the tier this page is showing" — not "nobody
         * anywhere has decided". The two answers differ on exactly the rows an
         * admin most needs to find: an applicant the State has already enrolled
         * is still Pending for a District that has recorded nothing.
         */
        const wanted = String(status || 'all').toLowerCase();
        const matchesStatus = (app) => {
            if (!wanted || wanted === 'all') return true;
            return classifyForLevel(app, viewLevel) === wanted;
        };

        /*
         * A file stays visible at every level whose region it belongs to.
         *
         * An earlier version of this dropped a file from a level once it moved
         * past that level. It fixed the visible symptom - buttons offered for a
         * decision already made - and broke something worse: approving a file
         * made it vanish from the list the admin was looking at, with no
         * confirmation anywhere that it had been approved. "What happened in my
         * block" stopped being answerable.
         *
         * Nothing moves past a level any more, so the rule is simply the
         * geofence: an application appears in the list of its own state, its own
         * district and its own block, and in no other. The buttons are governed
         * by `canAct` below, which asks only whether it has been decided yet.
         */
        // One lookup per distinct region, shared by the decidability pass below:
        // a page of fifty files in one block is one lookup, not fifty.
        const coverageOf = coverageResolver();

        const filtered = (documents || []).filter(matchesStatus);

        const start = (page - 1) * limit;
        const page1 = filtered.slice(start, start + limit);
        const applicants = await toApplicants(page1, viewLevel);

        /*
         * Whether THIS admin can decide THIS file, answered by the server.
         *
         * The client cannot work it out: the answer depends on the caller's
         * role, on which tier the file currently sits at, AND on whether the
         * tiers beneath it are staffed at all — a `Pending-Block` file in a
         * block with no admin is the district's to decide, and one in a staffed
         * block is not. Deriving that in three dashboards would be three chances
         * to offer a button the API then refuses.
         *
         * Computed with the same helpers the write path uses, so a row that says
         * it can be approved can be approved.
         */
        const decorated = await this.decorateDecidability(page1, applicants, scope.role, coverageOf, level);

        return {
            applicants: decorated,
            pagination: {
                page,
                limit,
                total: filtered.length,
                pages: Math.max(1, Math.ceil(filtered.length / limit)),
                // True when the global cap trimmed the scan before filtering, so
                // the client can say "the most recent 500" instead of presenting
                // a partial count as the whole truth.
                truncated: (documents || []).length >= GLOBAL_FETCH_LIMIT
            }
        };
    }

    /**
     * Every admin account, merged across both databases and de-duplicated by
     * email. Delegated to the repository, which is the only reader of the admin
     * collections — so this list can never disagree with what login sees.
     */
    async allAdminRows() {
        return adminRepository.findAll();
    }

    async listAdmins(filters = {}, actor = {}) {
        const { role, q } = filters;

        /*
         * The actor's patch first, and it is not negotiable.
         *
         * Applied before the caller's own filters rather than merged with them:
         * a district admin passing `?state=Kerala` must be able to narrow their
         * view inside their district, never to widen it. A `null` scope is an
         * actor who manages nobody — answered with an empty list rather than
         * with everything, which is what an unguarded query would return.
         */
        const scope = await actorScope(actor);
        const forced = scopeFilter(scope);
        const allowedRoles = MANAGEABLE_BY[scope.role] || [];

        if (!forced) {
            return {
                admins: [],
                counts: { all: 0, block_admin: 0, district_admin: 0, state_admin: 0 },
                // `total` too: the clients read it, and an undefined count
                // renders as "undefined admins" rather than as "none".
                total: 0,
                scope: { role: scope.role, state: scope.state, district: scope.district, manageableRoles: [] }
            };
        }

        let admins = await this.allAdminRows();

        /*
         * Only the tiers beneath this actor — and ONLY for the tiers that have
         * something above them.
         *
         * The super admin's list is left exactly as it was: every row this
         * repository returns, filtered by nothing. Applying the role filter to
         * them too was a quiet regression — it dropped any row whose role is not
         * one of the three manageable ones from a screen that had always shown
         * the whole roster.
         */
        if (scope.role !== 'super_admin') {
            admins = admins.filter(a => allowedRoles.includes(a.role));
        }

        if (forced.state) admins = admins.filter(a => sameRegion(a.state, forced.state));
        if (forced.district) admins = admins.filter(a => sameRegion(a.district, forced.district));

        if (filters.state) {
            const needle = String(filters.state).trim().toLowerCase();
            admins = admins.filter(a => String(a.state || '').trim().toLowerCase() === needle);
        }
        if (filters.district) {
            const needle = String(filters.district).trim().toLowerCase();
            admins = admins.filter(a => String(a.district || '').trim().toLowerCase() === needle);
        }
        if (filters.block) {
            const needle = String(filters.block).trim().toLowerCase();
            admins = admins.filter(a => String(a.block || '').trim().toLowerCase() === needle);
        }

        const counts = {
            all: admins.length,
            block_admin: admins.filter(a => a.role === 'block_admin').length,
            district_admin: admins.filter(a => a.role === 'district_admin').length,
            state_admin: admins.filter(a => a.role === 'state_admin').length
        };

        if (role && role !== 'all') {
            const roleFilter = String(role).toLowerCase();
            admins = admins.filter(a => a.role === roleFilter);
        }
        if (q && String(q).trim().length >= 2) {
            const needle = String(q).trim().toLowerCase();
            admins = admins.filter(a =>
                `${a.fullName} ${a.email} ${a.block} ${a.district} ${a.state}`.toLowerCase().includes(needle)
            );
        }

        admins.sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || '')));

        // Annotate each row with how many other active admins share its exact
        // region. Computed here in one pass over the already-loaded list rather
        // than per row, so a 1000-admin platform stays a single scan.
        const all = await this.allAdminRows();
        const regionKey = (admin) => [
            admin.role,
            String(admin.state || '').trim().toLowerCase(),
            String(admin.district || '').trim().toLowerCase(),
            String(admin.block || '').trim().toLowerCase()
        ].join('|');

        const perRegion = new Map();
        all.filter(admin => admin.active).forEach((admin) => {
            const key = regionKey(admin);
            perRegion.set(key, (perRegion.get(key) || 0) + 1);
        });

        const annotated = admins.map(admin => ({
            ...admin,
            // Excludes the admin themselves, so 0 means "sole owner of this queue".
            coAdmins: Math.max(0, (perRegion.get(regionKey(admin)) || 0) - (admin.active ? 1 : 0)),
            region: [admin.block, admin.district, admin.state].filter(Boolean).join(', ')
        }));

        return {
            admins: annotated,
            counts,
            total: annotated.length,
            /*
             * What this actor may do, told to the client rather than inferred
             * there. The same page serves three tiers, and it must not offer a
             * district admin a "state admin" option in the role dropdown that
             * the server would then refuse — a form that can be filled in and
             * not submitted is worse than one that never offered the field.
             */
            scope: {
                role: scope.role,
                state: scope.state,
                district: scope.district,
                manageableRoles: allowedRoles
            }
        };
    }

    /**
     * The hierarchy view: one row per region at the requested tier, carrying the
     * numbers the drill-down needs before you open it.
     *
     * Region names come from the applications themselves, so a block with no
     * applications but a staffed admin still appears — otherwise the directory
     * would hide exactly the regions worth chasing.
     */
    /**
     * Mark each applicant with whether this admin may decide it.
     *
     * THE WHOLE RULE, now that the relay is gone:
     *
     *   1. A file that has already been decided - approved or rejected - is
     *      nobody's to act on. It still appears, because monitoring is half the
     *      point of the drill-down, but with no buttons.
     *   2. Anyone else looking at it may decide it. The row reached this caller
     *      through a geofenced query or a forced scope, so the fact that they
     *      can see it IS the permission: a block admin only ever sees their own
     *      block's applicants, a district admin their district's, a state admin
     *      their state's, and the super admin everyone's.
     *
     * What went with the relay: the check that the file was sitting at the
     * caller's own tier, the escalation that handed it upward when the tier
     * below was unstaffed, and the rule that withheld buttons in the drill-down
     * when you were browsing a level the file had moved past. A file cannot move
     * past a level any more.
     *
     * Coverage is still resolved, once per distinct region, for `waitingOn`:
     * a region with nobody at any tier is worth naming on the row.
     */
    async decorateDecidability(documents = [], applicants = [], role = '', coverageOf = coverageResolver(), _level = '') {
        /*
         * THE VIEWER'S OWN SEAT DECIDES THIS — not the level being browsed.
         *
         * A Super Admin can page through the Hub at `level=block`, and
         * `buildApplicant` will have answered `canAct` for the BLOCK seat.
         * That is the wrong seat for them: a Super Admin fills the STATE's,
         * because theirs is the approval that grants a membership. Reading the
         * level here would let them sign the block's slot instead and leave the
         * applicant un-enrolled with every button greyed out.
         */
        const tier = ROLE_TIER[role] || 'super';

        return Promise.all(applicants.map(async (applicant, i) => {
            const doc = documents[i] || {};

            /*
             * Not `isPending(doc.status)` — that is the APPLICATION's outcome,
             * and it closed the buttons for every tier the moment any one of
             * them acted. `canTierAct` asks the only question that governs a
             * button: has THIS seat been signed. A District admin still owes a
             * verdict on a file the State has approved.
             */
            if (!tierReviews.canTierAct(doc, tier)) {
                return { ...applicant, canAct: false, waitingOn: '' };
            }

            // Coverage is only worth resolving while the outcome is open — an
            // enrolled applicant is not waiting on anybody.
            const coverage = isPending(doc.status) ? await coverageOf(doc).catch(() => null) : null;

            return {
                ...applicant,
                canAct: true,
                // Only said when it is true and useful: this region has nobody
                // at any tier, so the Super Admin is the only one who will ever
                // clear it unless somebody is appointed.
                waitingOn: tierRouting.isUnattended(coverage) ? 'Super' : ''
            };
        }));
    }

    async getDirectory(filters = {}, actor = {}) {
        const scope = await actorScope(actor);

        /*
         * Keyed AFTER the scope is resolved and BEFORE it is forced below, from
         * the three things that decide the answer: who is asking, which level,
         * and which parent region. A district admin and a super admin can both
         * ask for `level=block`; they are asking different questions and the key
         * has to say so.
         */
        const key = CACHE_KEYS.ADMIN_DIRECTORY(
            scope.role || 'unknown',
            resolveLevel(scope.role, filters.level),
            scope.role === 'super_admin' ? (filters.state || '') : (scope.state || ''),
            scope.role === 'district_admin' ? (scope.district || '') : (filters.district || ''),
        );

        return cached(key, HUB_TTL_SECONDS, () => this.computeDirectory(filters, scope));
    }

    async computeDirectory(filters = {}, scope = {}) {

        // Clamped by `resolveLevel` — see its note. The region is forced below.
        const level = resolveLevel(scope.role, filters.level);

        /*
         * WHOSE VERDICT the counts report — a different question from which
         * level of the GEOGRAPHY the rows are. A district admin browsing blocks
         * is asking about their own decisions, the same figures their Dashboard
         * shows; the super admin's per-tier cards ask about that tier's.
         */
        const verdictLevel = scope.role === 'super_admin'
            ? level
            : (ROLE_LEVEL[scope.role] || level);

        if (scope.role === 'state_admin') filters = { ...filters, state: scope.state };
        if (scope.role === 'district_admin') filters = { ...filters, state: scope.state, district: scope.district };

        const parentState = String(filters.state || '').trim();
        const parentDistrict = String(filters.district || '').trim();

        const conditions = [];
        if (parentState) conditions.push({ state: rxExact(parentState) });
        if (parentDistrict) conditions.push({ district: rxExact(parentDistrict) });
        const mongoFilter = conditions.length > 0 ? { $and: conditions } : {};

        const [documents, admins, stateNames, districtNames, blockNames] = await Promise.all([
            Application.find(mongoFilter)
            /*
             * Everything `tierReviews.tierVerdict` reads. This used to omit
             * `reviews`, `approvedBy`, `reviewedBy` and `stateApprovedAt`, so a
             * file the District or State had approved looked undecided here —
             * the Hub printed "2 pending" beside a Dashboard printing 0.
             */
            .select('state district block status reviews approvedBy reviewedBy rejectedBy rejectionReason blockApprovedAt districtApprovedAt stateApprovedAt createdAt')
            .limit(GLOBAL_FETCH_LIMIT)
            .lean()
            .catch(() => []),
            this.allAdminRows(),
            Application.distinct('state').catch(() => []),
            Application.distinct('district').catch(() => []),
            Application.distinct('block').catch(() => [])
        ]);

        const matchesParent = (row) => {
            if (parentState && String(row.state || '').trim().toLowerCase() !== parentState.toLowerCase()) return false;
            if (parentDistrict && String(row.district || '').trim().toLowerCase() !== parentDistrict.toLowerCase()) return false;
            return true;
        };

        // Seed a row per region so a staffed-but-empty region is still listed.
        const rows = new Map();
        const rowFor = (name, context = {}) => {
            const key = String(name || '').trim() || 'Unassigned';
            if (!rows.has(key)) {
                rows.set(key, {
                    id: key,
                    name: key,
                    state: context.state || (level === 'state' ? key : parentState),
                    district: context.district || (level === 'district' ? key : parentDistrict),
                    block: level === 'block' ? key : '',
                    applications: 0,
                    pending: 0,
                    approved: 0,
                    rejected: 0,
                    admins: 0
                });
            }
            return rows.get(key);
        };

        (documents || []).forEach(app => {
            const row = rowFor(app[level], { state: app.state, district: app.district });
            // Every application in the region counts towards its row. There is
            // no longer a stage that belongs to a tier without belonging to the
            // region - `upstream` and `closed` are gone.
            const stage = classifyForLevel(app, verdictLevel);

            row.applications += 1;
            if (stage === 'approved') row.approved += 1;
            else if (stage === 'rejected') row.rejected += 1;
            else row.pending += 1;
        });

        (admins || []).filter(matchesParent).forEach(admin => {
            const name = String(admin[level] || '').trim();
            if (!name) return;
            rowFor(name, { state: admin.state, district: admin.district }).admins += 1;
        });

        /*
         * Staffed, or holding work. Not "staffed" alone.
         *
         * This filter was `r.admins > 0`, which hid the single most important
         * row on the screen: a block with applications and NO admin. Those
         * applicants are still covered - their district and state admin hold the
         * same files - but an unstaffed block is exactly the region the Super
         * Admin should be appointing into, so the region that most needs opening
         * was the one region the drill-down would not show. The comment above
         * the seeding says the directory exists so that "the regions worth
         * chasing" are visible; this is the other half of it.
         *
         * Regions with neither an admin nor an application are still dropped:
         * every name in the reference list would otherwise appear, and 6,966
         * empty blocks is not a work queue.
         */
        const regions = [...rows.values()]
            .filter(r => r.admins > 0 || r.applications > 0)
            .sort((a, b) =>
                (b.pending - a.pending) || String(a.name).localeCompare(String(b.name)));

        // The tier counts must span the same universe the drill-down lists —
        // applications *and* staffed regions — or the summary card promises two
        // blocks and the next screen shows nine.
        const distinctCount = (values, adminField) => {
            const seen = new Set();
            (admins || []).forEach(admin => {
                const name = String(admin[adminField] || '').trim();
                if (name) seen.add(name.toLowerCase());
            });
            return seen.size;
        };

        return {
            level,
            parent: { state: parentState, district: parentDistrict },
            summary: {
                states: distinctCount(stateNames, 'state'),
                districts: distinctCount(districtNames, 'district'),
                blocks: distinctCount(blockNames, 'block'),
                admins: (admins || []).length
            },
            regions,
            truncated: (documents || []).length >= GLOBAL_FETCH_LIMIT
        };
    }

    /**
     * Create a tier admin, in the collection that belongs to its tier.
     *
     * Block admins land in `adminsdb.blockadmins`, district admins in
     * `districtadmins`, state admins in `stateadmins`. Login reads all of them,
     * so the account works immediately.
     *
     * Regions are free text. Whatever the Super Admin types becomes, on save, an
     * option in the applicant's dropdowns — that is the whole remote-control
     * idea, and it is why no pre-existing parent is required.
     *
     * `adminRegions.resolveRegion` still runs, but only to settle *spelling*:
     * if the region already exists it reuses that exact casing. Two spellings of
     * one region would otherwise become two regions, each holding half the queue,
     * because the geofence matches with an anchored regex.
     */
    async createAdmin(payload = {}, actor = {}) {
        const role = String(payload.role || '').toLowerCase();
        const fullName = String(payload.fullName || '').trim();
        const email = String(payload.email || '').trim().toLowerCase();
        const password = String(payload.password || '');

        if (!MANAGEABLE_ROLES.includes(role)) {
            throw ApiError.badRequest(`Role must be one of: ${MANAGEABLE_ROLES.join(', ')}`);
        }

        /*
         * The escalation check, and the one that matters most in this file.
         *
         * Without it a district admin could POST `role: 'state_admin'` and mint
         * an account with authority over their own — the API is reachable with a
         * token and curl, so a role dropdown that only offers block admin proves
         * nothing. The region is then FORCED to the actor's own patch rather
         * than validated against it: validation rejects a bad value, forcing
         * makes a bad value impossible to express.
         */
        const scope = await actorScope(actor);
        const allowed = MANAGEABLE_BY[scope.role] || [];

        if (!allowed.includes(role)) {
            throw ApiError.forbidden(`A ${scope.role.replace('_', ' ')} cannot create a ${role.replace('_', ' ')}`);
        }
        if (scope.role === 'state_admin') payload = { ...payload, state: scope.state };
        if (scope.role === 'district_admin') payload = { ...payload, state: scope.state, district: scope.district };

        if (!fullName) throw ApiError.badRequest('Full name is required');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest('A valid email is required');
        if (password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

        if (await adminRepository.emailExists(email)) {
            throw ApiError.badRequest('An admin with this email already exists');
        }

        // Location claims ride in the JWT and drive every geofenced query. An
        // admin created without them silently inherits the default region and
        // sees another region's applications.
        const region = await adminRegions.resolveRegion(role, payload);

        const passwordHash = await bcrypt.hash(password, 10);
        const now = new Date();

        const created = await adminRepository.insert({
            email,
            passwordHash,
            fullName,
            phoneNumber: String(payload.phoneNumber || '').trim(),
            role,
            state: region.state,
            district: region.district,
            block: region.block,
            active: true,
            createdAt: now,
            updatedAt: now,
            /*
             * Still `super_admin_ui` whichever tier created it.
             *
             * This stamp is the discriminator that separates real staffing from
             * the pre-seeded scaffold — see the admin-first region architecture
             * note in CLAUDE.md. Coverage, the directory and the applicant
             * dropdowns all test it, and inventing a second value here would
             * make an account created by a district admin invisible to every one
             * of them: a block staffed through this screen would not open for
             * registration. WHO created it is recorded in the audit trail, which
             * is where that question belongs.
             */
            createdVia: 'super_admin_ui'
        });

        // The new admin changes who covers what, and the applicant dropdowns read
        // that tree. A stale cache here means a region that is staffed but not
        // yet selectable.
        regionService.invalidate();
        /*
         * And the Hub's own answers.
         *
         * `getDirectory` counts admins per region and `getOverview` counts them
         * per tier, so staffing a region changes both — and neither is on the
         * approve/reject path that clears this prefix the rest of the time. Left
         * out, a newly created block admin would not appear in the directory
         * for up to two minutes, which reads as the account not having saved.
         */
        await cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null);

        await auditService.record({
            action: 'admin.created',
            category: 'admin',
            summary: `Super Admin created ${created.roleLabel} account for ${created.fullName}` +
                (region.created.length > 0 ? ` — opening a new ${region.created.join(' / ')}` : ''),
            actorId: actor.userId || actor._id || '',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: created.id,
            targetLabel: created.email,
            state: created.state,
            district: created.district,
            block: created.block,
            metadata: {
                role: created.role,
                collection: created.source,
                // Which region levels this account brought into existence, so the
                // log says when a new region was opened for registration.
                regionsCreated: region.created
            }
        });

        // Co-admins share this region's queue; the UI says so on the created card.
        const coAdmins = await this.countCoAdmins(created);

        return { ...created, coAdmins, warnings: region.warnings, regionsCreated: region.created };
    }

    /**
     * How many *other* active admins share this account's exact tier and region.
     *
     * A region with several admins is the load-balancing case: they all see the
     * same geofenced queue and clear it together. Surfacing the number is what
     * stops two admins silently duplicating each other's work.
     */
    async countCoAdmins(admin = {}) {
        const key = (value) => String(value || '').trim().toLowerCase();
        const admins = await adminRepository.findActive();

        return admins.filter(other =>
            other.id !== admin.id &&
            other.role === admin.role &&
            key(other.state) === key(admin.state) &&
            key(other.district) === key(admin.district) &&
            key(other.block) === key(admin.block)
        ).length;
    }

    /**
     * How many applications would bubble to a higher tier if this admin stopped
     * covering their region.
     *
     * Called before a delete or a deactivation so the confirmation can say
     * "50 pending applications will escalate to the District tier" instead of
     * asking the super admin to guess. Read-only.
     */
    async orphanImpact(admin = {}) {
        const tier = { block_admin: 'block', district_admin: 'district', state_admin: 'state' }[admin.role];
        if (!tier) return { affected: 0, escalatesTo: '', tier: '', remainingAdmins: 0 };

        const key = (value) => String(value || '').trim().toLowerCase();
        const admins = await adminRepository.findActive();

        // Everyone else still covering this exact region. If anyone remains, the
        // queue does not move at all — that is the whole point of allowing more
        // than one admin per region.
        const remaining = admins.filter(other =>
            other.id !== admin.id &&
            other.role === admin.role &&
            key(other.state) === key(admin.state) &&
            (tier === 'state' || key(other.district) === key(admin.district)) &&
            (tier !== 'block' || key(other.block) === key(admin.block))
        ).length;

        if (remaining > 0) {
            return { affected: 0, escalatesTo: '', escalatesToLabel: '', tier, remainingAdmins: remaining };
        }

        /*
         * Every undecided application in this admin's patch.
         *
         * It used to count only the ones sitting AT this admin's tier, because
         * those were the only ones they could act on. All three tiers hold every
         * pending file in their region now, so removing this admin takes a pair
         * of hands off all of them - and the warning should say so.
         */
        const conditions = [];
        if (admin.state) conditions.push({ state: rxExact(admin.state) });
        if (tier !== 'state' && admin.district) conditions.push({ district: rxExact(admin.district) });
        if (tier === 'block' && admin.block) conditions.push({ block: rxExact(admin.block) });
        conditions.push({ status: { $in: PENDING_STORED_STATUSES } });

        const affected = await Application.countDocuments({ $and: conditions }).catch(() => 0);

        // Coverage as it will be once this admin is gone.
        const coverage = { block: 0, district: 0, state: 0 };
        admins.filter(other => other.id !== admin.id).forEach((other) => {
            if (other.role === 'block_admin' &&
                key(other.state) === key(admin.state) &&
                key(other.district) === key(admin.district) &&
                key(other.block) === key(admin.block)) coverage.block += 1;
            if (other.role === 'district_admin' &&
                key(other.state) === key(admin.state) &&
                key(other.district) === key(admin.district)) coverage.district += 1;
            if (other.role === 'state_admin' && key(other.state) === key(admin.state)) coverage.state += 1;
        });

        /*
         * Who is left holding those files.
         *
         * Nothing "escalates" - the other two tiers were already on them. What
         * this answers is whether anybody is left at all: if the region still
         * has an admin at some tier, name the first one; if it has none, the
         * Super Admin is the only route in and the field says so.
         */
        const remainingTier = tierRouting.TIER_ORDER.find(t => Number(coverage[t] || 0) > 0);
        const escalatesTo = remainingTier || 'super';

        return {
            affected,
            tier,
            escalatesTo,
            escalatesToLabel: tierRouting.TIER_LABELS[escalatesTo] || 'Super',
            remainingAdmins: 0
        };
    }

    /**
     * Edit an existing admin, including their tier and their region.
     *
     * Every field is editable, region included. Renaming a block here renames it
     * for applicants too — the dropdowns are derived from these records — so
     * this is also how a region is corrected or an admin is moved.
     *
     * The document is updated in whichever database and collection actually
     * holds it, with field names translated to that collection's spelling.
     */
    async updateAdmin(adminId, payload = {}, actor = {}) {
        if (!mongoose.Types.ObjectId.isValid(adminId)) {
            throw ApiError.badRequest('Invalid admin id');
        }

        const hit = await adminRepository.findRawById(adminId);
        if (!hit) throw ApiError.notFound('Admin not found');

        const existing = adminRepository.toAdminRow(hit.doc, hit.source);
        if (existing.role === 'super_admin') {
            throw ApiError.forbidden('Super admin accounts cannot be edited from the app');
        }

        // Beneath this actor, and inside their patch. Checked against the STORED
        // record rather than the payload: a district admin must not be able to
        // edit a block admin in another district, whatever they send.
        const scope = await actorScope(actor);
        assertManageable(existing, scope);

        const role = payload.role !== undefined
            ? String(payload.role || '').toLowerCase()
            : existing.role;
        if (!MANAGEABLE_ROLES.includes(role)) {
            throw ApiError.badRequest(`Role must be one of: ${MANAGEABLE_ROLES.join(', ')}`);
        }

        const pick = (key, fallback) =>
            (payload[key] !== undefined ? String(payload[key] || '').trim() : fallback);

        const fullName = pick('fullName', existing.fullName);
        const email = pick('email', existing.email).toLowerCase();
        const phoneNumber = pick('phoneNumber', existing.phoneNumber);

        if (!fullName) throw ApiError.badRequest('Full name is required');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest('A valid email is required');

        // Only check for a collision when the email actually changed, otherwise
        // the admin's own record would block their own edit.
        if (email !== existing.email && await adminRepository.emailExists(email, adminId)) {
            throw ApiError.badRequest('Another admin already uses this email');
        }

        // Same spelling reconciliation as creation. Omitted fields keep their
        // current value, so an edit that only changes a phone number does not
        // need the client to re-send the region.
        const region = await adminRegions.resolveRegion(role, {
            state: pick('state', existing.state),
            district: pick('district', existing.district),
            block: pick('block', existing.block)
        });

        const nowActive = payload.active !== undefined ? payload.active !== false : existing.active;

        // Measured *before* the write, while the admin still counts as covering
        // their region, so the number reflects what this edit is about to cause.
        const deactivating = existing.active && !nowActive;
        const movingRegion = region.state !== existing.state ||
            region.district !== existing.district ||
            region.block !== existing.block ||
            role !== existing.role;

        const impact = (deactivating || movingRegion)
            ? await this.orphanImpact(existing)
            : { affected: 0, escalatesTo: '', escalatesToLabel: '', tier: '', remainingAdmins: 0 };

        // Canonical field names. The repository translates them to whatever the
        // target collection calls them — the unified and per-tier documents
        // disagree on password, phone and active, and a wrong name is a silent
        // no-op rather than an error.
        const update = {
            fullName,
            email,
            phoneNumber,
            role,
            state: region.state,
            district: region.district,
            block: region.block,
            active: nowActive,
            updatedAt: new Date()
        };

        // An optional password reset. Without it, an admin who loses their
        // password can only be fixed by deleting and recreating the account.
        const newPassword = String(payload.password || '');
        if (newPassword) {
            if (newPassword.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');
            update.passwordHash = await bcrypt.hash(newPassword, 10);
            // A super-admin-set password is a real one, not a temporary.
            update.mustResetPassword = false;
        }

        await adminRepository.updateById(hit, update);
        regionService.invalidate();
        /*
         * And the Hub's own answers.
         *
         * `getDirectory` counts admins per region and `getOverview` counts them
         * per tier, so staffing a region changes both — and neither is on the
         * approve/reject path that clears this prefix the rest of the time. Left
         * out, a newly created block admin would not appear in the directory
         * for up to two minutes, which reads as the account not having saved.
         */
        await cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null);

        const updated = adminRepository.toAdminRow({ ...hit.doc, ...update, _id: hit.objectId }, hit.source);
        updated.source = hit.sourceKey;

        const changed = [];
        if (fullName !== existing.fullName) changed.push('name');
        if (email !== existing.email) changed.push('email');
        if (role !== existing.role) changed.push('role');
        if (movingRegion) changed.push('region');
        if (nowActive !== existing.active) changed.push(nowActive ? 'reactivated' : 'deactivated');
        if (newPassword) changed.push('password');

        await auditService.record({
            action: 'admin.updated',
            category: 'admin',
            summary: `Super Admin updated ${updated.roleLabel} ${updated.fullName}` +
                (changed.length > 0 ? ` (${changed.join(', ')})` : '') +
                (impact.affected > 0
                    ? ` — ${impact.affected} pending application(s) now escalate to the ${impact.escalatesToLabel} tier`
                    : ''),
            actorId: actor.userId || actor._id || '',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: adminId,
            targetLabel: updated.email,
            state: updated.state,
            district: updated.district,
            block: updated.block,
            metadata: {
                changed,
                previousEmail: existing.email,
                previousRegion: [existing.block, existing.district, existing.state].filter(Boolean).join(', '),
                orphanImpact: impact.affected > 0 ? impact : undefined
            }
        });

        const coAdmins = await this.countCoAdmins(updated);
        return {
            ...updated,
            coAdmins,
            warnings: region.warnings,
            regionsCreated: region.created,
            orphanImpact: impact
        };
    }

    /**
     * What deleting or deactivating this admin would do, without doing it.
     *
     * Backs the confirmation dialog: the super admin is told how many
     * applications are about to change hands and which tier inherits them,
     * before they press the button rather than after.
     */
    async previewAdminRemoval(adminId, actor = {}) {
        const admin = await adminRepository.findById(adminId);
        if (!admin) throw ApiError.notFound('Admin not found');

        // The preview reports one region's queue and staffing, so it is gated
        // exactly as the delete it precedes: reading it for another district is
        // reading that district's workload.
        assertManageable(admin, await actorScope(actor));

        const impact = await this.orphanImpact(admin);
        const children = await this.countChildren(admin);

        return {
            admin: {
                id: admin.id,
                fullName: admin.fullName,
                email: admin.email,
                roleLabel: admin.roleLabel,
                region: [admin.block, admin.district, admin.state].filter(Boolean).join(', ')
            },
            ...impact,
            children
        };
    }

    /**
     * Admins that hang beneath this one in the tree.
     *
     * Deleting a state admin does not delete the district admins under them, but
     * it does mean the region they root has no state tier left — so their files
     * escalate to the super admin. The count is shown in the confirmation so
     * that consequence is visible.
     */
    async countChildren(admin = {}) {
        const key = (value) => String(value || '').trim().toLowerCase();
        const admins = await adminRepository.findActive();

        if (admin.role === 'state_admin') {
            return admins.filter(other =>
                other.id !== admin.id &&
                (other.role === 'district_admin' || other.role === 'block_admin') &&
                key(other.state) === key(admin.state)
            ).length;
        }
        if (admin.role === 'district_admin') {
            return admins.filter(other =>
                other.id !== admin.id &&
                other.role === 'block_admin' &&
                key(other.state) === key(admin.state) &&
                key(other.district) === key(admin.district)
            ).length;
        }
        return 0;
    }

    /**
     * Hard delete. The record is removed from every admin collection in both
     * databases that holds that email, so the account cannot sign in through a
     * legacy path.
     *
     * The applications that admin was holding are *not* rewritten. Ownership is
     * derived from live coverage at read time (see `common/tierRouting`), so the
     * moment this account is gone their pending queue appears in the tier above,
     * and it returns to a replacement block admin the moment one is created. The
     * count is measured here only so the audit entry records what moved.
     */
    async deleteAdmin(adminId, actor = {}) {
        if (!mongoose.Types.ObjectId.isValid(adminId)) {
            throw ApiError.badRequest('Invalid admin id');
        }

        const found = await adminRepository.findById(adminId);
        if (!found) throw ApiError.notFound('Admin not found');

        // Same rule as the edit path, on the same stored record.
        assertManageable(found, await actorScope(actor));

        if (found.role === 'super_admin') {
            throw ApiError.forbidden('Super admin accounts cannot be deleted from the app');
        }

        const actorEmail = String(actor.email || '').toLowerCase();
        if (actorEmail && actorEmail === found.email) {
            throw ApiError.badRequest('You cannot delete your own account');
        }

        // Measured before the delete, while this admin still counts as covering
        // the region — afterwards the answer would always be zero.
        const impact = await this.orphanImpact(found);
        const children = await this.countChildren(found);

        const removed = await adminRepository.deleteEverywhere({
            email: found.email,
            objectId: new mongoose.Types.ObjectId(adminId)
        });
        regionService.invalidate();
        /*
         * And the Hub's own answers.
         *
         * `getDirectory` counts admins per region and `getOverview` counts them
         * per tier, so staffing a region changes both — and neither is on the
         * approve/reject path that clears this prefix the rest of the time. Left
         * out, a newly created block admin would not appear in the directory
         * for up to two minutes, which reads as the account not having saved.
         */
        await cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null);

        // Written after the delete: the account is gone from every collection,
        // so this entry is now the only remaining record that it existed.
        await auditService.record({
            action: 'admin.deleted',
            category: 'admin',
            summary: `Super Admin hard-deleted ${found.roleLabel} account ${found.fullName || found.email}` +
                (impact.affected > 0
                    ? ` — ${impact.affected} pending application(s) escalated to the ${impact.escalatesToLabel} tier`
                    : ''),
            actorId: actor.userId || actor._id || '',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetId: adminId,
            targetLabel: found.email,
            state: found.state,
            district: found.district,
            block: found.block,
            metadata: {
                role: found.role,
                collectionsAffected: removed,
                orphanedApplications: impact.affected,
                escalatedTo: impact.escalatesTo,
                orphanedChildAdmins: children
            }
        });

        return {
            id: adminId,
            email: found.email,
            removed,
            orphanImpact: { ...impact, children }
        };
    }

    /**
     * Region name suggestions for the Super Admin's form.
     *
     * Suggestions, not constraints — the fields stay free text. They exist so
     * adding a second admin to an existing district does not depend on typing
     * the name identically by hand, which would split one region into two.
     */
    async suggestRegions(filters = {}, actor = {}) {
        /*
         * Suggestions inside the actor's patch only.
         *
         * A district admin naming a new block should be offered the blocks of
         * their own district; offering them every block in India is both noise
         * and a small leak of another region's structure. Forced rather than
         * defaulted, for the same reason as `createAdmin`: the parameters arrive
         * from a query string.
         */
        const scope = await actorScope(actor);

        return adminRegions.suggestRegions({
            state: scope.role === 'super_admin' ? filters.state : scope.state,
            district: scope.role === 'district_admin' ? scope.district : filters.district
        });
    }
}

module.exports = new SuperAdminService();
module.exports.MANAGEABLE_ROLES = MANAGEABLE_ROLES;
module.exports.BOTTLENECK_DAYS = BOTTLENECK_DAYS;
