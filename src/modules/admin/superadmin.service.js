const mongoose = require('mongoose');
const bcrypt = require('../common/passwordHash');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const ApiError = require('../../core/utils/ApiError');
const { normalizeStatus } = require('../common/applicationStatus');
const adminService = require('./admin.service');
const auditService = require('../audit/audit.service');
const adminRepository = require('./admin.repository');
const adminRegions = require('./admin.regions');
const regionService = require('../regions/region.service');
const tierRouting = require('../common/tierRouting');

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

const ROLE_LABELS = adminRepository.ROLE_LABELS;

const TIER_LABELS = {
    'Pending-Block': 'Block',
    'Pending-District': 'District',
    'Pending-State': 'State'
};

const col = adminRepository.col;

const rx = (value) => new RegExp(escapeRegex(String(value || '')), 'i');
const rxExact = (value) => new RegExp(`^${escapeRegex(String(value || ''))}$`, 'i');

/**
 * The tier whose perspective makes a global row read correctly.
 *
 * `buildApplicant` always renders from one tier's point of view, and the same
 * application means different things to each. The super admin wants the plain
 * truth — pending means "someone still owes a decision", approved means fully
 * approved — so pick the tier that currently owns the file.
 */
const levelForApplication = (application = {}) => {
    const status = normalizeStatus(application.status);
    if (status === 'Pending-District') return LEVELS.DISTRICT;
    if (status === 'Pending-State') return LEVELS.STATE;
    if (status === 'Approved') return LEVELS.STATE;
    if (status === 'Rejected') {
        const by = String(application.rejectedBy?.adminType || '');
        if (by === 'DistrictAdmin') return LEVELS.DISTRICT;
        if (by === 'StateAdmin') return LEVELS.STATE;
        return LEVELS.BLOCK;
    }
    return LEVELS.BLOCK;
};

/** When the clock started running at the tier that currently holds the file. */
const waitingSince = (application = {}) => {
    const status = normalizeStatus(application.status);
    if (status === 'Pending-State') {
        return application.districtApprovedAt || application.blockApprovedAt || application.createdAt || null;
    }
    if (status === 'Pending-District') {
        return application.blockApprovedAt || application.createdAt || null;
    }
    return application.createdAt || null;
};

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
        const tierQueue = { block: 0, district: 0, state: 0 };
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

            if (status === 'Pending-Block') tierQueue.block += 1;
            else if (status === 'Pending-District') tierQueue.district += 1;
            else if (status === 'Pending-State') tierQueue.state += 1;

            // Tier-specific relative stats
            const blockStage = classifyForLevel(app, LEVELS.BLOCK);
            if (blockStage !== 'upstream') {
                tierStats.block.total += 1;
                if (blockStage === 'pending') tierStats.block.pending += 1;
                else if (blockStage === 'approved') tierStats.block.approved += 1;
                else if (blockStage === 'rejected' || blockStage === 'closed') tierStats.block.rejected += 1;
            }

            const districtStage = classifyForLevel(app, LEVELS.DISTRICT);
            if (districtStage !== 'upstream') {
                tierStats.district.total += 1;
                if (districtStage === 'pending') tierStats.district.pending += 1;
                else if (districtStage === 'approved') tierStats.district.approved += 1;
                else if (districtStage === 'rejected' || districtStage === 'closed') tierStats.district.rejected += 1;
            }

            const stateStage = classifyForLevel(app, LEVELS.STATE);
            if (stateStage !== 'upstream') {
                tierStats.state.total += 1;
                if (stateStage === 'pending') tierStats.state.pending += 1;
                else if (stateStage === 'approved') tierStats.state.approved += 1;
                else if (stateStage === 'rejected' || stateStage === 'closed') tierStats.state.rejected += 1;
            }

            const since = waitingSince(app);
            const stuckDays = daysSince(since);
            if (stuckDays >= BOTTLENECK_DAYS && (status === 'Pending-Block' || status === 'Pending-District' || status === 'Pending-State')) {
                stuck.push({ app, stuckDays, since, status });
            }
        });

        stuck.sort((a, b) => b.stuckDays - a.stuckDays);
        const top = stuck.slice(0, 20);
        const bottleneckApplicants = await toApplicants(top.map(row => row.app));

        const bottlenecks = bottleneckApplicants.map((applicant, index) => ({
            ...applicant,
            stuckDays: top[index]?.stuckDays || 0,
            waitingSince: top[index]?.since || null,
            // The tier that currently owes a decision — this is who the super
            // admin acts in place of when they override.
            blockedTier: TIER_LABELS[top[index]?.status] || 'Block'
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
     * Regions holding pending applications that their own tier can no longer act
     * on, because nobody covers them.
     *
     * These files are not stuck — orphan fallback has already handed them to the
     * tier above — but they are the super admin's cue to staff a replacement, and
     * the only place the platform says out loud that a region went unstaffed.
     * Sorted by how many applicants are waiting, because that is the order the
     * vacancies should be filled in.
     */
    async coverageGaps(applications = []) {
        const coverageFor = await regionService.coverageResolver().catch(() => null);
        if (!coverageFor) return [];

        const gaps = new Map();

        (applications || []).forEach((app) => {
            const status = normalizeStatus(app.status);
            if (status !== 'Pending-Block' && status !== 'Pending-District' && status !== 'Pending-State') return;

            const region = { state: app.state, district: app.district, block: app.block };
            const coverage = coverageFor(region);
            if (!tierRouting.isOrphaned(app, coverage)) return;

            const owner = tierRouting.owningTier(app);
            const effective = tierRouting.effectiveTier(app, coverage);

            // Keyed on the unstaffed tier's own region, so one vacancy is one row
            // however many applications are sitting behind it.
            const place = owner === 'block'
                ? [app.block, app.district, app.state]
                : owner === 'district'
                    ? ['', app.district, app.state]
                    : ['', '', app.state];

            const id = `${owner}|${place.join('|').toLowerCase()}`;
            if (!gaps.has(id)) {
                gaps.set(id, {
                    id,
                    missingTier: owner,
                    missingTierLabel: tierRouting.TIER_LABELS[owner] || '',
                    escalatedTo: effective,
                    escalatedToLabel: tierRouting.TIER_LABELS[effective] || 'Super',
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
    async getApplications(filters = {}) {
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

        const wanted = String(status || 'all').toLowerCase();
        const matchesStatus = (app) => {
            if (!wanted || wanted === 'all') return true;
            
            if (requestedLevel) {
                const stage = classifyForLevel(app, requestedLevel);
                if (wanted === 'rejected') return stage === 'rejected' || stage === 'closed';
                return stage === wanted;
            }

            const normalized = normalizeStatus(app.status);
            if (wanted === 'pending') return normalized !== 'Approved' && normalized !== 'Rejected';
            if (wanted === 'approved') return normalized === 'Approved';
            if (wanted === 'rejected') return normalized === 'Rejected';
            return normalized.toLowerCase() === wanted;
        };

        const filtered = (documents || []).filter(matchesStatus);
        const start = (page - 1) * limit;
        const applicants = await toApplicants(filtered.slice(start, start + limit), requestedLevel);

        return {
            applicants,
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

    async listAdmins(filters = {}) {
        const { role, q } = filters;
        let admins = await this.allAdminRows();

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

        return { admins: annotated, counts, total: annotated.length };
    }

    /**
     * The hierarchy view: one row per region at the requested tier, carrying the
     * numbers the drill-down needs before you open it.
     *
     * Region names come from the applications themselves, so a block with no
     * applications but a staffed admin still appears — otherwise the directory
     * would hide exactly the regions worth chasing.
     */
    async getDirectory(filters = {}) {
        const level = ['state', 'district', 'block'].includes(String(filters.level || '').toLowerCase())
            ? String(filters.level).toLowerCase()
            : 'state';

        const parentState = String(filters.state || '').trim();
        const parentDistrict = String(filters.district || '').trim();

        const conditions = [];
        if (parentState) conditions.push({ state: rxExact(parentState) });
        if (parentDistrict) conditions.push({ district: rxExact(parentDistrict) });
        const mongoFilter = conditions.length > 0 ? { $and: conditions } : {};

        const [documents, admins, stateNames, districtNames, blockNames] = await Promise.all([
            Application.find(mongoFilter)
            .select('state district block status blockApprovedAt districtApprovedAt rejectedBy createdAt')
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
            const reqLevel = { block: LEVELS.BLOCK, district: LEVELS.DISTRICT, state: LEVELS.STATE }[level];
            const stage = classifyForLevel(app, reqLevel);

            if (stage !== 'upstream') {
                row.applications += 1;
                if (stage === 'approved') row.approved += 1;
                else if (stage === 'rejected' || stage === 'closed') row.rejected += 1;
                else if (stage === 'pending') row.pending += 1;
            }
        });

        (admins || []).filter(matchesParent).forEach(admin => {
            const name = String(admin[level] || '').trim();
            if (!name) return;
            rowFor(name, { state: admin.state, district: admin.district }).admins += 1;
        });

        const regions = [...rows.values()]
            .filter(r => r.admins > 0)
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
            createdVia: 'super_admin_ui'
        });

        // The new admin changes who covers what, and the applicant dropdowns read
        // that tree. A stale cache here means a region that is staffed but not
        // yet selectable.
        regionService.invalidate();

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

        const pendingStatus = {
            block: ['PENDING', 'Pending-Block'],
            district: ['Pending-District'],
            state: ['Pending-State']
        }[tier];

        const conditions = [];
        if (admin.state) conditions.push({ state: rxExact(admin.state) });
        if (tier !== 'state' && admin.district) conditions.push({ district: rxExact(admin.district) });
        if (tier === 'block' && admin.block) conditions.push({ block: rxExact(admin.block) });
        conditions.push({ status: { $in: pendingStatus } });

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

        const startStatus = { block: 'Pending-Block', district: 'Pending-District', state: 'Pending-State' }[tier];
        const escalatesTo = tierRouting.effectiveTier({ status: startStatus }, coverage);

        return {
            affected,
            tier,
            escalatesTo: escalatesTo || '',
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
    async previewAdminRemoval(adminId) {
        const admin = await adminRepository.findById(adminId);
        if (!admin) throw ApiError.notFound('Admin not found');

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
    async suggestRegions(filters = {}) {
        return adminRegions.suggestRegions({
            state: filters.state,
            district: filters.district
        });
    }
}

module.exports = new SuperAdminService();
module.exports.MANAGEABLE_ROLES = MANAGEABLE_ROLES;
module.exports.BOTTLENECK_DAYS = BOTTLENECK_DAYS;
