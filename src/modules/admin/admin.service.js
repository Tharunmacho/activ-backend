const mongoose = require('mongoose');
const User = require('../auth/auth.model');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const { normalizeStatus } = require('../common/applicationStatus');
const tierRouting = require('../common/tierRouting');
const regionService = require('../regions/region.service');
const adminRepository = require('./admin.repository');
const cacheClient = require('../../core/cache/cacheClient');
const { CACHE_KEYS } = require('../../core/cache/cacheKeys');

/**
 * How long a tier dashboard is reused.
 *
 * An approve or reject clears the key outright — see `invalidateReviewCaches`
 * in `application.service`, which every one of the six tier-review branches
 * calls — so this never delays the admin's own action. It only bounds how long
 * a change made *somewhere else* takes to appear: another admin's decision, or
 * a new application arriving.
 *
 * Raised from 20s to 120s once that invalidation was in place. At 20s a state
 * admin reading a queue for a couple of minutes paid for six rebuilds, each
 * measured at 0.5–1.7s against the remote cluster; the rebuilt payload was
 * identical every time, because nothing had happened. Two minutes is the point
 * where a queue is worth re-reading on its own — a decision the admin makes
 * themselves no longer waits for it either way.
 */
const DASHBOARD_TTL_SECONDS = 120;

/** How long an admin's own profile record is reused. Cleared on edit. */
const ADMIN_PROFILE_TTL_SECONDS = 300;

// Applications still awaiting the Block Admin's decision.
const BLOCK_PENDING_STATUSES = ['PENDING', 'Pending-Block'];

// Statuses that mean the block has already signed off and the file moved downstream.
const PAST_BLOCK_STATUSES = ['Pending-District', 'Pending-State', 'Approved'];

// Statuses that mean the district has already signed off.
const PAST_DISTRICT_STATUSES = ['Pending-State', 'Approved'];

// Upper bound on how many applications a single dashboard payload carries.
const APPLICANT_FETCH_LIMIT = 300;

const escapeRegex = (value = '') => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const firstOf = (...values) => {
    for (const value of values) {
        if (value === 0 || value === false) return value;
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
};

/**
 * Which tier's point of view a dashboard is rendered from.
 * Each tier sees a *different* stage for the same application: a file sitting at
 * 'Pending-District' is "approved" to the block admin but "pending" to the district admin.
 */
const LEVELS = { BLOCK: 'block', DISTRICT: 'district', STATE: 'state' };

const rejectedByType = (application) => String(application.rejectedBy?.adminType || '');

/**
 * Bucket an application from one tier's perspective. Exact status matching only —
 * substring matching on 'pending' would put 'Pending-District' in the block's
 * pending queue, which is precisely the leak this workflow must not have.
 *
 * The status is normalized first: live rows carry legacy spellings such as
 * 'pending_district_approval' and bare lowercase 'approved'.
 */
const classifyForLevel = (application, level, coverage = null) => {
    const status = normalizeStatus(application.status);
    const isRejected = status === 'Rejected';

    // Orphan fallback. When the tier that formally owes a decision has no active
    // admin left, the file bubbles to the first tier above that does — so a
    // resigned block admin's fifty pending applications appear in the district
    // admin's action queue instead of sitting in a queue nobody can open.
    //
    // Only ever *promotes* a file into an action bucket; it never removes one
    // from the tier that legitimately owns it, and `coverage === null` (unknown
    // staffing) leaves classification exactly as it was.
    if (!isRejected && coverage) {
        const owner = tierRouting.owningTier(application);
        const effective = tierRouting.effectiveTier(application, coverage);
        if (owner && effective && effective !== owner && effective === level) {
            return 'pending';
        }
    }

    if (level === LEVELS.DISTRICT) {
        // A rejection only belongs to the district's "rejected" bucket if the
        // district is who rejected it; block-stage rejections never reached them.
        if (isRejected) {
            return rejectedByType(application) === 'DistrictAdmin' ? 'rejected' : 'closed';
        }
        if (status === 'Pending-District') return 'pending';
        if (application.districtApprovedAt || PAST_DISTRICT_STATUSES.includes(status)) return 'approved';
        // Still upstream at the block — visible in `all`, but in no action bucket.
        return 'upstream';
    }

    if (level === LEVELS.STATE) {
        if (isRejected) {
            return rejectedByType(application) === 'StateAdmin' ? 'rejected' : 'closed';
        }
        if (status === 'Pending-State') return 'pending';
        if (status === 'Approved') return 'approved';
        return 'upstream';
    }

    // Block level.
    if (isRejected) return 'rejected';
    if (BLOCK_PENDING_STATUSES.includes(status)) return 'pending';
    if (application.blockApprovedAt || PAST_BLOCK_STATUSES.includes(status)) return 'approved';
    return 'pending';
};

/**
 * The applications that have actually reached a tier.
 *
 * `classifyForLevel` marks two stages a tier can see but never act on:
 * `upstream` — still awaiting a decision from a tier below — and `closed`,
 * rejected by a different tier. Both used to be listed under "All".
 *
 * That is what put a `Pending-Block` applicant on the district admin's screen.
 * The card carried an "Awaiting Block Admin review" caption and offered no
 * buttons, but a file nobody at the block has approved yet appearing in the
 * district's own list reads as the sequential workflow having been skipped, and
 * it inflated every count above the list with work this tier does not own.
 *
 * A tier now sees exactly what the state machine has handed it: its own
 * pending / approved / rejected files and nothing else. This is a display rule
 * only — the stored status is untouched, so the file stays exactly where it is
 * and reappears at the district the moment the block approves it.
 *
 * Escalated files survive this filter by construction: when the tier below has
 * no active admin, `classifyForLevel` has already promoted them to `pending`,
 * which is not one of the stages removed here. The block tier is unaffected —
 * being first, it produces neither stage.
 */
const TIER_ONLY_VISIBLE_STAGES = ['upstream', 'closed'];
const reachedThisTier = (applicants = []) =>
    applicants.filter(a => !TIER_ONLY_VISIBLE_STAGES.includes(a && a.stage));

/**
 * The Members directory a tier admin sees, with a real Active / Inactive split.
 *
 * The Inactive tab was permanently empty, on both clients, and the reason was
 * structural rather than a bug in the filter: the list was built from
 * `applicants.approved` alone, and every approved applicant defaults to
 * `isActive: true`. Nothing could ever land in the other tab, so the filter
 * looked broken because it had nothing to select.
 *
 * A member is Inactive when either of two things is true:
 *
 *   - **their application was rejected.** A rejected applicant is not an active
 *     member of the region, and they had been vanishing from the directory
 *     entirely — the only place they appeared was the Approvals queue's
 *     "Rejected" tab.
 *   - **their account was suspended** — `isActive === false` on the member
 *     record, which `memberAction` writes.
 *
 * Built here rather than in each client so the two cannot disagree about who
 * counts as a member; both now render this array as it arrives.
 */
const buildMemberDirectory = (approved = [], rejected = []) => {
    const rows = [];

    for (const member of approved) {
        const suspended = member.isActive === false;
        rows.push(Object.assign({}, member, {
            memberStatus: suspended ? 'Inactive' : 'Active',
            // Why they are inactive, so the row can say so instead of leaving an
            // admin to guess between "suspended" and "rejected".
            inactiveReason: suspended ? 'Account suspended by an admin' : ''
        }));
    }

    for (const member of rejected) {
        rows.push(Object.assign({}, member, {
            memberStatus: 'Inactive',
            inactiveReason: member.rejectionReason
                ? `Application rejected: ${member.rejectionReason}`
                : 'Application rejected'
        }));
    }

    return rows;
};

const STAGE_LABELS = {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    upstream: 'In Progress',
    closed: 'Closed'
};

/** Human-readable attribution line shown under an applicant card. */
const buildAttribution = (application, stage, level, scope = {}) => {
    if (stage === 'approved') {
        if (level === LEVELS.BLOCK) return `Approved by ${scope.blockName || 'Block'} Admin`;
        if (level === LEVELS.DISTRICT) return `Approved by ${scope.districtName || 'District'} Admin`;
        return `Approved by ${scope.stateName || 'State'} Admin`;
    }

    if (stage === 'rejected' || stage === 'closed') {
        const by = rejectedByType(application);
        if (by === 'BlockAdmin') return `Rejected by ${scope.blockName || 'Block'} Admin`;
        if (by === 'DistrictAdmin') return `Rejected by ${scope.districtName || 'District'} Admin`;
        if (by === 'StateAdmin') return `Rejected by ${scope.stateName || 'State'} Admin`;
        return 'Rejected';
    }

    if (stage === 'upstream') {
        const status = normalizeStatus(application.status);
        if (status === 'Pending-District') return 'Awaiting District Admin review';
        if (status === 'Pending-State') return 'Awaiting State Admin review';
        return 'Awaiting Block Admin review';
    }

    return '';
};

/**
 * Flattens an application (plus the member profile it belongs to, when one exists)
 * into the detailed applicant object the admin screens render.
 */
const buildApplicant = (application, member = {}, index = 0, level = LEVELS.BLOCK, scope = {}, coverage = null) => {
    const data = application.data || {};
    const personal = data.personalDetails || data.personal || data;
    const business = data.businessInfo || data.business || data;
    const financial = data.financialInfo || data.financial || data;
    const declaration = data.declaration || data;

    const stage = classifyForLevel(application, level, coverage);
    const id = application._id.toString();

    // Provenance for a file that reached this tier by escalation rather than by
    // the normal sequence. The card renders it so an admin is never asked to
    // decide on another tier's application without being told why it is theirs.
    const owningTier = tierRouting.owningTier(application);
    const effectiveTier = tierRouting.effectiveTier(application, coverage);
    const orphaned = !!coverage && tierRouting.isOrphaned(application, coverage);
    const doingBusiness = business.doingBusiness === true || data.doingBusiness === true || !!business.organizationName || !!data.organizationName;

    // Real values only. Every field below resolves from the application, the
    // submitted form data, or the member profile — and stays empty when none of
    // those hold a value. Inventing a placeholder name, phone or block here
    // makes an admin's review screen lie about the applicant.
    const blockName = firstOf(application.block, personal.block, member.block);
    const approvedByText = buildAttribution(application, stage, level, {
        blockName: blockName || scope.blockName,
        districtName: firstOf(application.district, personal.district, member.district, scope.districtName),
        stateName: firstOf(application.state, personal.state, member.state, scope.stateName)
    });

    // Only a genuine member code — never a synthesised MEM001-style sequence,
    // which would collide with real codes and look authoritative.
    const memberCode = firstOf(application.memberCode, member.memberCode);

    // Derived from what the applicant actually declared, not guessed.
    const isAspirantUser =
        (business.doingBusiness === false || data.doingBusiness === false) &&
        !doingBusiness &&
        (data.registrationType === 'aspirant' || data.memberType === 'aspirant' || application.registrationType === 'aspirant' || application.memberType === 'aspirant');

    let derivedRole = 'Member';
    if (isAspirantUser) {
        derivedRole = 'Aspirant';
    } else if (doingBusiness) {
        derivedRole = 'Business Member';
    }

    const finalRole = isAspirantUser ? 'Aspirant' : (derivedRole !== 'Member' ? derivedRole : firstOf(application.role, member.role, 'Business Member'));

    return {
        id,
        applicationId: id,
        memberId: application.userId ? application.userId.toString() : (member._id ? member._id.toString() : ''),
        memberCode,
        fullName: firstOf(application.fullName, personal.fullName, member.fullName),
        email: firstOf(application.email, personal.email, member.email),
        phone: firstOf(application.phone, personal.phoneNumber, personal.phone, member.phoneNumber),
        role: finalRole,
        /**
         * `'business' | 'aspirant'`, from what the applicant declared.
         *
         * Both clients read `memberType` — the mobile applicant card renders it
         * as "Membership Type" and the website Members screens map it with
         * `app.memberType || 'aspirant'` — but it was never included in this
         * payload. The fallback therefore fired for every row, so every member
         * was labelled an aspirant however plainly they had declared a business.
         *
         * Derived from the same `isAspirantUser` the role above uses, so the two
         * fields cannot disagree about the same applicant.
         */
        memberType: isAspirantUser ? 'aspirant' : 'business',
        /**
         * Whether the member's account is active — the real Boolean on their
         * "web users" record, which `userAction` toggles when an admin suspends
         * or reactivates someone.
         *
         * Both clients' Members screens used to decide this with
         * `const isInactiveMember = (index) => index % 4 === 3` — every fourth
         * row in the list was labelled "Inactive", purely because of where it
         * happened to sit. It had nothing to do with the member. Sorting the
         * list, or one new approval arriving, relabelled different people.
         *
         * Defaults to true when there is no member record to read, matching the
         * schema default; an application with no member yet is not "suspended".
         */
        isActive: member.isActive !== false,
        doingBusiness,
        gender: firstOf(personal.gender, member.gender),
        block: blockName,
        district: firstOf(application.district, personal.district, member.district),
        state: firstOf(application.state, personal.state, member.state),
        city: firstOf(personal.city, member.city),
        // Normalized so the client can compare against the canonical enum;
        // `rawStatus` preserves whatever legacy spelling the document holds.
        status: normalizeStatus(application.status),
        rawStatus: application.status || '',
        stage,
        level,
        statusLabel: STAGE_LABELS[stage] || 'Pending',
        approvedByText,
        // Escalation flags. `orphaned` is false whenever coverage is unknown, so
        // a caller that does not resolve staffing sees the plain workflow.
        orphaned,
        owningTier: owningTier || '',
        effectiveTier: effectiveTier || '',
        fallbackReason: orphaned ? tierRouting.fallbackReason(application, coverage) : '',
        submittedAt: application.createdAt || null,
        // Every tier timestamp is exposed so the client can render the full
        // approval trail without a second round-trip.
        blockApprovedAt: application.blockApprovedAt || null,
        districtApprovedAt: application.districtApprovedAt || null,
        stateApprovedAt: application.stateApprovedAt || null,
        rejectionReason: application.rejectionReason || '',
        rejectedBy: application.rejectedBy
            ? {
                adminType: application.rejectedBy.adminType || '',
                rejectedAt: application.rejectedBy.rejectedAt || null
            }
            : null,
        personalDetails: {
            fullName: firstOf(application.fullName, personal.fullName, member.fullName),
            block: firstOf(application.block, personal.block, member.block),
            city: firstOf(personal.city, member.city),
            district: firstOf(application.district, personal.district, member.district),
            phone: firstOf(application.phone, personal.phoneNumber, personal.phone, member.phoneNumber),
            email: firstOf(application.email, personal.email, member.email),
            dateOfBirth: firstOf(personal.dateOfBirth, personal.dob, member.dateOfBirth),
            aadhaarNumber: firstOf(personal.aadhaarNumber, personal.aadhaar, member.aadhaarNumber),
            streetName: firstOf(personal.streetName, personal.street, personal.addressLine1, member.streetName),
            education: firstOf(personal.education, personal.educationalQualification, member.educationalQualification),
            religion: firstOf(personal.religion, member.religion),
            socialCategory: firstOf(personal.socialCategory, member.socialCategory)
        },
        businessInfo: {
            doingBusiness,
            organizationName: firstOf(business.organizationName, business.businessName),
            constitutionType: firstOf(business.constitutionType),
            businessTypes: business.businessTypes || [],
            businessActivities: firstOf(business.businessActivities),
            businessCommencementYear: firstOf(business.businessCommencementYear),
            numberOfEmployees: firstOf(business.numberOfEmployees),
            memberOfOtherChamber: business.memberOfOtherChamber,
            otherChamber: firstOf(business.otherChamber),
            govtOrganizations: business.govtOrganizations || []
        },
        financialInfo: {
            panNumber: firstOf(financial.panNumber),
            gstNumber: firstOf(financial.gstNumber),
            udyamNumber: firstOf(financial.udyamNumber),
            itrFiled: firstOf(financial.itrFiled, financial.filedITR),
            turnoverRange: firstOf(financial.turnoverRange, financial.lastYearTurnover),
            govtSchemeBenefit: financial.govtSchemeBenefit || financial.govtSchemes
        },
        declaration: {
            sisterConcerns: firstOf(declaration.sisterConcerns),
            companyNames: declaration.companyNames || [],
            agreeToDeclaration: declaration.agreeToDeclaration || declaration.agreeToTerms
        }
    };
};

/**
 * Resolve the geofence an admin is allowed to see.
 *
 * The JWT is the first source, but tokens issued before the login payload carried
 * location fields have none — so fall back to the `admins` collection by email.
 * Without this, a district admin silently inherits the hardcoded default and sees
 * another district's applications.
 */
const resolveAdminScope = async(user = {}) => {
    let blockName = user.block;
    let districtName = user.district;
    let stateName = user.state;

    /*
     * Ask the database only for what this admin's tier actually has.
     *
     * The test was `!block || !district || !state`, which is true for every
     * admin above block level *by design* — a state admin has no district and
     * no block, and never will. So a state admin whose token already carried
     * "Tamil Nadu" still ran the cross-collection email lookup on every single
     * dashboard load, to be told the thing it already knew.
     *
     * Against the live cluster that lookup measured 6.3s–19.2s before it was
     * parallelised, and it is on the path of both `/admin/profile` and
     * `/admin/{tier}/dashboard` — so a state dashboard paid it twice.
     */
    const role = adminRepository.normalizeRole(user.role || user.adminType || '');
    const required = {
        block_admin: () => blockName && districtName && stateName,
        district_admin: () => districtName && stateName,
        state_admin: () => stateName,
        super_admin: () => true
    }[role];

    // An unrecognised role keeps the old conservative test: look everything up
    // rather than assume a tier needs less than it does.
    const satisfied = required ? required() : (blockName && districtName && stateName);

    const needsLookup = !satisfied;
    if (needsLookup && (user.email || user.userId)) {
        const email = String(user.email || '').toLowerCase();

        // Through the repository, which spans every admin collection. Reading
        // the unified `admins` collection directly — as this did — finds nothing
        // for any account created since the segregation, and the hardcoded
        // fallback below then quietly handed them somebody else's region.
        const hit = await adminRepository.findRawByEmail(email).catch(() => null);
        if (hit) {
            const row = adminRepository.toAdminRow(hit.doc, hit.source);
            blockName = blockName || row.block;
            districtName = districtName || row.district;
            stateName = stateName || row.state;
        }
    }

    // No defaults. A default region here is not a convenience, it is a
    // geofence failure that looks like data: an admin whose location could not
    // be resolved would be shown Ariyalur's applications and could approve them.
    // Empty is the honest answer, and every caller treats it as "no scope" and
    // returns nothing rather than guessing.
    return {
        blockName: blockName || '',
        districtName: districtName || '',
        stateName: stateName || '',
        unresolved: {
            block: !blockName,
            district: !districtName,
            state: !stateName
        }
    };
};

/**
 * The empty dashboard, returned when an admin's own region cannot be resolved.
 *
 * Showing zero applications is correct here and showing some is not: there is no
 * such thing as a safe guess about which region an admin belongs to.
 */
const emptyDashboard = (scope = {}, level = '') => ({
    stats: {
        blockName: scope.blockName || '',
        districtName: scope.districtName || '',
        stateName: scope.stateName || '',
        totalMembers: 0,
        pending: 0,
        approved: 0,
        rejected: 0
    },
    applicants: { pending: [], approved: [], rejected: [], all: [] },
    scopeUnresolved: true,
    message: `This account has no ${level || 'region'} on record, so no applications can be shown. `
        + 'Ask the Super Admin to set its region.'
});

/** Exact-match filter across the three places a location can live.
 * Using exact matches utilizes compound indexes. Case-insensitivity is not needed 
 * because the geofences are normalized exactly at application submission.
 */
const buildGeoFilter = (field, value) => {
    /*
     * Anchored, case-insensitive, metacharacters escaped.
     *
     * This was briefly reduced to plain string equality, which is faster to
     * index but silently case-sensitive - and case is exactly what this filter
     * cannot afford to care about. Region names reach an application from a
     * dropdown and reach an admin from the admin database, and the two spell
     * them independently: an admin on "Tamil Nadu" stops matching an
     * application stored as "tamil nadu", and the applicant vanishes from the
     * only queue that could have reviewed them. Nothing errors; they are simply
     * never seen.
     *
     * The cost is that the query cannot use the {state, district, block} index.
     * That is affordable here and only here: the tier dashboards are cached, so
     * this runs about once per region per cache window rather than once per
     * request, and the collection is small. If it ever stops being affordable,
     * the answer is a collation-strength-2 index - case-insensitive AND
     * indexable - not dropping the case-insensitivity.
     */
    const regex = new RegExp(`^${escapeRegex(value)}$`, 'i');
    return {
        $or: [
            { [field]: regex },
            { [`data.personalDetails.${field}`]: regex },
            { [`data.personal.${field}`]: regex }
        ]
    };
};

/**
 * Shared loader: geofenced application fetch + member-profile hydration.
 *
 * Staffing is resolved once per dashboard load and applied to every row. Asking
 * per application would mean one admin-collection scan per applicant; asking
 * once and reusing the resolver keeps a 300-row dashboard at a single scan.
 */
const loadApplicants = async(geoFilter, memberFilter, level, scope) => {
    const [totalMembers, applications] = await Promise.all([
        Member.countDocuments(memberFilter).catch(() => 0),
        Application.find(geoFilter)
            .sort({ createdAt: -1 })
            .limit(APPLICANT_FETCH_LIMIT)
            .lean()
            .catch(() => [])
    ]);

    const emails = [...new Set(
        applications.map(app => (app.email || '').toLowerCase()).filter(Boolean)
    )];

    const memberByEmail = {};
    if (emails.length > 0) {
        const memberDocs = await Member.find({ email: { $in: emails } })
            .select('+aadhaarNumber')
            .lean()
            .catch(() => []);

        memberDocs.forEach(doc => {
            memberByEmail[(doc.email || '').toLowerCase()] = doc;
        });
    }

    // A failure here must not take the dashboard down: an unresolvable coverage
    // map degrades to `null`, which disables fallback and leaves the plain
    // workflow intact rather than mis-bucketing anything.
    const coverageFor = await regionService.coverageResolver().catch(() => null);

    const applicants = applications.map((app, index) => buildApplicant(
        app,
        memberByEmail[(app.email || '').toLowerCase()] || {},
        index,
        level,
        scope,
        coverageFor ? coverageFor({ state: app.state, district: app.district, block: app.block }) : null
    ));

    return { totalMembers: totalMembers || 0, applications, applicants };
};

class AdminService {
    async getDashboardStats() {
        const [totalUsers, totalMembers, pendingApplications, approvedMembers] = await Promise.all([
            User.countDocuments(),
            Member.countDocuments(),
            Application.countDocuments({ status: { $regex: /^pending/ } }),
            Member.countDocuments({ isApproved: true })
        ]);

        return { totalUsers, totalMembers, pendingApplications, approvedMembers };
    }

    async getUsers(filter = {}, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const users = await User.find(filter).select('-password').skip(skip).limit(limit).sort({ createdAt: -1 });
        const total = await User.countDocuments(filter);

        return { users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }

    async updateUserRole(userId, role) {
        const user = await User.findByIdAndUpdate(userId, { role }, { new: true });
        if (!user) throw ApiError.notFound('User not found');
        return user;
    }

    async toggleUserStatus(userId) {
        const user = await User.findById(userId);
        if (!user) throw ApiError.notFound('User not found');

        user.isActive = !user.isActive;
        await user.save();
        return user;
    }
    /**
     * The three tier dashboards, cached.
     *
     * Each load is roughly ten Mongo round trips — scope, member count,
     * application scan, member hydration, coverage — and the cluster this runs
     * against is remote: measured RTT is 74–265ms *per round trip*, so the cost
     * is dominated by distance, not by work. There are 12 applications in the
     * database; no index will help, because nothing here is CPU- or scan-bound.
     * Not repeating the trips is the only lever that moves.
     *
     * Keyed by tier and region rather than by admin, because co-admins on one
     * region share one queue and therefore one answer. Short TTL, and every
     * approve/reject clears the pattern outright, so the queue an admin acts on
     * is never the stale one.
     */
    async cachedDashboard(tier, user, build) {
        const scope = await resolveAdminScope(user);
        const region = scope[`${tier}Name`];

        // No region means the empty dashboard, which is cheap and must never be
        // cached — an admin whose scope resolves a moment later would keep
        // being handed the blank one.
        if (!region) return build.call(this, user, scope);

        const cacheKey = CACHE_KEYS.ADMIN_DASHBOARD(tier, region);

        const hit = await cacheClient.get(cacheKey).catch(() => null);
        if (hit) return hit;

        const payload = await build.call(this, user, scope);
        await cacheClient.set(cacheKey, payload, DASHBOARD_TTL_SECONDS).catch(() => null);
        return payload;
    }

    getBlockDashboard(user = {}) {
        return this.cachedDashboard('block', user, this.computeBlockDashboard);
    }

    getDistrictDashboard(user = {}) {
        return this.cachedDashboard('district', user, this.computeDistrictDashboard);
    }

    getStateDashboard(user = {}) {
        return this.cachedDashboard('state', user, this.computeStateDashboard);
    }

    async computeBlockDashboard(user = {}, preResolved = null) {
        // The cached wrapper has already resolved this; re-resolving would
        // repeat the cross-collection lookup for any admin whose token does
        // not carry its region claims.
        const scope = preResolved || await resolveAdminScope(user);
        if (!scope.blockName) return emptyDashboard(scope, 'block');
        const { blockName, districtName, stateName } = scope;

        // Geofenced query: strictly retrieve applications assigned to THIS block.
        const blockFilter = buildGeoFilter('block', blockName);

        const { totalMembers, applications, applicants } = await loadApplicants(
            blockFilter,
            { block: blockName },
            LEVELS.BLOCK,
            scope
        );

        // Block Admin buckets:
        // - pending:  awaiting this block's decision ('Pending-Block' or 'PENDING')
        // - approved: this block signed off (now at district/state, or fully approved)
        // - rejected: rejected at any tier
        const pending = applicants.filter(a => a.stage === 'pending');
        const approved = applicants.filter(a => a.stage === 'approved');
        const rejected = applicants.filter(a => a.stage === 'rejected');

        const recentActivities = applications.slice(0, 10).map(app => {
            const dateStr = app.createdAt ? new Date(app.createdAt).toLocaleDateString() : 'Recently';
            return {
                id: app._id.toString(),
                type: 'application',
                message: `Applicant: ${app.fullName || app.email || 'Member'} (${app.status || 'Pending-Block'})`,
                timestamp: dateStr
            };
        });

        return {
            stats: {
                totalMembers: approved.length > 0 ? approved.length : applicants.length,
                pendingApplications: pending.length,
                approvedApplications: approved.length,
                rejectedApplications: rejected.length,
                totalApplications: applicants.length,
                activeBusinesses: applicants.filter(a => a.businessInfo.doingBusiness).length,
                totalRevenue: 0,
                blockName,
                districtName,
                stateName
            },
            members: buildMemberDirectory(approved, rejected),
            applicants: {
                pending,
                approved,
                rejected,
                all: applicants
            },
            recentActivities: recentActivities.length > 0 ? recentActivities : [
                { id: '1', type: 'application', message: `No applications found for block: ${blockName}`, timestamp: 'Just now' }
            ]
        };
    }

    async computeDistrictDashboard(user = {}, preResolved = null) {
        // The cached wrapper has already resolved this; re-resolving would
        // repeat the cross-collection lookup for any admin whose token does
        // not carry its region claims.
        const scope = preResolved || await resolveAdminScope(user);
        if (!scope.districtName) return emptyDashboard(scope, 'district');
        const { districtName, stateName } = scope;

        // Geofenced query: strictly retrieve applications assigned to THIS district.
        const districtFilter = buildGeoFilter('district', districtName);

        const { totalMembers, applicants } = await loadApplicants(
            districtFilter,
            { district: districtName },
            LEVELS.DISTRICT,
            scope
        );

        // District Admin buckets:
        // - pending:  ONLY files the block has already approved ('Pending-District')
        // - approved: this district signed off ('districtApprovedAt', 'Pending-State' or 'Approved')
        // - rejected: rejected *by a district admin* — block-stage rejections were
        //             never this tier's to act on, so they stay out of the queue
        const pending = applicants.filter(a => a.stage === 'pending');
        const approved = applicants.filter(a => a.stage === 'approved');
        const rejected = applicants.filter(a => a.stage === 'rejected');

        // Everything else on this screen counts what the district can see, so it
        // agrees with the list rather than reporting a larger total beside it.
        const visible = reachedThisTier(applicants);

        // One row per block feeding this district, derived from the real data
        // instead of the previous hardcoded single-block placeholder.
        const blockRollup = new Map();
        visible.forEach(a => {
            const name = a.block || 'Unassigned';
            const row = blockRollup.get(name) || { id: name, name, members: 0, pendingApplications: 0 };
            row.members += 1;
            if (a.stage === 'pending') row.pendingApplications += 1;
            blockRollup.set(name, row);
        });

        return {
            stats: {
                totalMembers: approved.length > 0 ? approved.length : visible.length,
                totalBlocks: blockRollup.size,
                pendingApplications: pending.length,
                approvedApplications: approved.length,
                rejectedApplications: rejected.length,
                totalApplications: visible.length,
                activeBusinesses: visible.filter(a => a.businessInfo.doingBusiness).length,
                totalRevenue: 0,
                districtName,
                stateName
            },
            members: buildMemberDirectory(approved, rejected),
            applicants: {
                pending,
                approved,
                rejected,
                all: visible
            },
            blocks: blockRollup.size > 0
                ? [...blockRollup.values()]
                : [{ id: '1', name: `${districtName} Block`, members: totalMembers || 0, pendingApplications: 0 }]
        };
    }

    async computeStateDashboard(user = {}, preResolved = null) {
        // The cached wrapper has already resolved this; re-resolving would
        // repeat the cross-collection lookup for any admin whose token does
        // not carry its region claims.
        const scope = preResolved || await resolveAdminScope(user);
        if (!scope.stateName) return emptyDashboard(scope, 'state');
        const { stateName } = scope;

        // Geofenced query: strictly retrieve applications assigned to THIS state.
        const stateFilter = buildGeoFilter('state', stateName);

        const { totalMembers, applicants } = await loadApplicants(
            stateFilter,
            { state: stateName },
            LEVELS.STATE,
            scope
        );

        // State Admin buckets:
        // - pending:  ONLY files the district has already approved ('Pending-State')
        // - approved: final approval granted ('Approved')
        // - rejected: rejected *by a state admin*
        const pending = applicants.filter(a => a.stage === 'pending');
        const approved = applicants.filter(a => a.stage === 'approved');
        const rejected = applicants.filter(a => a.stage === 'rejected');

        // See the district dashboard: the rollups and totals below count what
        // has reached the state, so they agree with the list they sit above.
        const visible = reachedThisTier(applicants);

        const districtRollup = new Map();
        visible.forEach(a => {
            const name = a.district || 'Unassigned';
            const row = districtRollup.get(name) || {
                id: name,
                name,
                members: 0,
                blocks: new Set(),
                pendingApplications: 0,
                approvedCount: 0
            };
            row.members += 1;
            if (a.block) row.blocks.add(a.block);
            if (a.stage === 'pending') row.pendingApplications += 1;
            if (a.status === 'Approved') row.approvedCount += 1;
            districtRollup.set(name, row);
        });

        const districts = [...districtRollup.values()].map(row => ({
            id: row.id,
            name: row.name,
            members: row.members,
            blocks: row.blocks.size,
            pendingApplications: row.pendingApplications,
            performance: row.members > 0 ? Math.round((row.approvedCount / row.members) * 100) : 0
        }));

        return {
            stats: {
                totalMembers: approved.length > 0 ? approved.length : visible.length,
                totalDistricts: districts.length,
                totalBlocks: new Set(visible.map(a => a.block).filter(Boolean)).size,
                pendingApplications: pending.length,
                approvedApplications: approved.length,
                rejectedApplications: rejected.length,
                totalApplications: visible.length,
                activeBusinesses: visible.filter(a => a.businessInfo.doingBusiness).length,
                totalRevenue: 0,
                stateName
            },
            members: buildMemberDirectory(approved, rejected),
            applicants: {
                pending,
                approved,
                rejected,
                all: visible
            },
            districts: districts.length > 0
                ? districts
                : [{ id: '1', name: `${stateName} District`, members: totalMembers || 0, blocks: 0, pendingApplications: 0, performance: 0 }]
        };
    }

    async getSuperDashboard() {
        const [totalUsers, totalMembers, pendingApplications, approvedMembers] = await Promise.all([
            User.countDocuments().catch(() => 0),
            Member.countDocuments().catch(() => 0),
            Application.countDocuments({ status: { $regex: /^Pending/i } }).catch(() => 0),
            Member.countDocuments().catch(() => 0)
        ]);

        return {
            stats: {
                totalUsers: totalUsers || 0,
                totalMembers: totalMembers || 0,
                pendingApplications: pendingApplications || 0,
                approvedMembers: approvedMembers || 0,
                activeBusinesses: 0,
                totalRevenue: 0
            }
        };
    }

    /**
     * Analytics for the admin AnalyticsScreen, in exactly the shape it renders.
     * Scoped to the caller's geofence so a district admin sees their district.
     */
    async getAnalytics(user = {}, period = 'month') {
        const scope = await resolveAdminScope(user);
        const role = user.role || '';

        let geoFilter = {};
        if (role === 'block_admin') geoFilter = buildGeoFilter('block', scope.blockName);
        else if (role === 'district_admin') geoFilter = buildGeoFilter('district', scope.districtName);
        else if (role === 'state_admin') geoFilter = buildGeoFilter('state', scope.stateName);

        const days = period === 'week' ? 7 : period === 'year' ? 365 : 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const applications = await Application.find(geoFilter)
            .select('status createdAt state district block data')
            .limit(2000)
            .lean()
            .catch(() => []);

        const trends = { pending: 0, approved: 0, rejected: 0 };
        const stateTally = new Map();
        const genderTally = {};
        const ageTally = {};

        applications.forEach(app => {
            const s = normalizeStatus(app.status);
            if (s === 'Approved') trends.approved += 1;
            else if (s === 'Rejected') trends.rejected += 1;
            else trends.pending += 1;

            const stateName = app.state || 'Unknown';
            const row = stateTally.get(stateName) || { name: stateName, members: 0, revenue: 0 };
            row.members += 1;
            stateTally.set(stateName, row);

            const personal = (app.data && (app.data.personalDetails || app.data.personal)) || {};
            const gender = personal.gender;
            if (gender) genderTally[gender] = (genderTally[gender] || 0) + 1;
            const ageBand = personal.ageGroup || personal.ageBand;
            if (ageBand) ageTally[ageBand] = (ageTally[ageBand] || 0) + 1;
        });

        // Bucket submissions per period slice for the growth chart.
        const slices = period === 'week' ? 7 : period === 'year' ? 12 : 4;
        const sliceMs = (days * 24 * 60 * 60 * 1000) / slices;
        const labels = [];
        const values = new Array(slices).fill(0);

        for (let i = 0; i < slices; i += 1) {
            labels.push(period === 'year' ? `M${i + 1}` : period === 'week' ? `D${i + 1}` : `W${i + 1}`);
        }
        applications.forEach(app => {
            if (!app.createdAt) return;
            const t = new Date(app.createdAt).getTime();
            if (t < since.getTime()) return;
            const idx = Math.min(slices - 1, Math.floor((t - since.getTime()) / sliceMs));
            values[idx] += 1;
        });

        const asPercent = (tally) => {
            const total = Object.values(tally).reduce((a, b) => a + b, 0);
            if (!total) return {};
            return Object.fromEntries(
                Object.entries(tally).map(([k, v]) => [k, Math.round((v / total) * 100)])
            );
        };

        return {
            userGrowth: { labels, values },
            applicationTrends: trends,
            // No payment ledger is wired up yet, so revenue is reported as zero
            // rather than fabricated.
            revenueData: { total: 0, thisMonth: 0, lastMonth: 0, growth: 0 },
            topStates: [...stateTally.values()].sort((a, b) => b.members - a.members).slice(0, 5),
            demographics: { gender: asPercent(genderTally), age: asPercent(ageTally) },
            period,
            scope: {
                blockName: scope.blockName,
                districtName: scope.districtName,
                stateName: scope.stateName
            }
        };
    }

    /**
     * Report generation for ReportsScreen. Returns real aggregated figures for
     * the requested report, scoped to the caller's geofence.
     */
    async generateReport(user = {}, options = {}) {
        const { reportType = 'applications', dateRange = 'month' } = options;
        const scope = await resolveAdminScope(user);
        const role = user.role || '';

        let geoFilter = {};
        if (role === 'block_admin') geoFilter = buildGeoFilter('block', scope.blockName);
        else if (role === 'district_admin') geoFilter = buildGeoFilter('district', scope.districtName);
        else if (role === 'state_admin') geoFilter = buildGeoFilter('state', scope.stateName);

        const days = dateRange === 'week' ? 7 : dateRange === 'year' ? 365 : 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const applications = await Application.find(geoFilter).lean().catch(() => []);
        const inRange = applications.filter(a => a.createdAt && new Date(a.createdAt) >= since);

        const countBy = (list, fn) => list.reduce((acc, item) => {
            const key = fn(item) || 'Unknown';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        const rows = [];
        if (reportType === 'applications' || reportType === 'performance') {
            const byStatus = countBy(inRange, a => normalizeStatus(a.status));
            Object.entries(byStatus).forEach(([k, v]) => rows.push({ label: k, value: v }));
        } else if (reportType === 'users' || reportType === 'demographics') {
            const byBlock = countBy(inRange, a => a.block);
            Object.entries(byBlock).forEach(([k, v]) => rows.push({ label: k, value: v }));
        } else if (reportType === 'revenue') {
            rows.push({ label: 'Revenue recorded', value: 0 });
        }

        return {
            reportType,
            dateRange,
            generatedAt: new Date().toISOString(),
            scope: {
                blockName: scope.blockName,
                districtName: scope.districtName,
                stateName: scope.stateName
            },
            totals: {
                applicationsInRange: inRange.length,
                applicationsAllTime: applications.length
            },
            rows,
            // No file is produced — the client renders `rows` directly rather
            // than being handed a download URL that does not exist.
            downloadUrl: null
        };
    }

    /**
     * Resolve whatever id a Members row carries into the documents behind it.
     *
     * The rows an admin sees are applications, so their `id` is an application
     * id — but the same payload also exposes `memberId`, and that field is
     * `application.userId` when it is set and the MemberDetails `_id` otherwise.
     * `application.userId` references **MemberAuth**, not MemberDetails, so the
     * two ids point into different collections depending on the row. The old
     * lookup was a bare `Member.findById(id)`, which therefore returned null for
     * every row that had an auth record, and the action reported "User not
     * found" against a member plainly listed on screen.
     *
     * All three ids are accepted here and the member is reached by whichever
     * link exists, falling back to the email the application carries — the same
     * fallback `hydrateApplicationSections` needs, and for the same reason.
     */
    async resolveMemberTarget(id) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw ApiError.badRequest('Invalid id');
        }

        const application = await Application.findById(id).catch(() => null);
        let member = null;
        let auth = null;

        if (application) {
            const rawUserId = application.userId ? application.userId.toString() : '';
            if (rawUserId) {
                auth = await User.findById(rawUserId).catch(() => null);
                member = await Member.findById(rawUserId).catch(() => null);
            }
            if (!member && application.email) {
                member = await Member.findOne({ email: String(application.email).toLowerCase() }).catch(() => null);
            }
            if (!auth && application.email) {
                auth = await User.findOne({ email: String(application.email).toLowerCase() }).catch(() => null);
            }
        } else {
            member = await Member.findById(id).catch(() => null);
            auth = await User.findById(id).catch(() => null);
            if (!member && auth && auth.email) {
                member = await Member.findOne({ email: String(auth.email).toLowerCase() }).catch(() => null);
            }
        }

        if (!application && !member && !auth) {
            throw ApiError.notFound('Member not found');
        }

        return { application, member, auth };
    }

    /**
     * The geofence, applied to a Members-screen action.
     *
     * `POST /admin/users/:id/:action` was role-gated but never scope-checked: any
     * block admin who knew an id could suspend or delete any member in the
     * country. Reads have been geofenced all along and approve/reject re-check
     * via `assertWithinScope`; this write had been left out of that rule, and it
     * is the most destructive of the three.
     *
     * The region is taken from the application when there is one and from the
     * member record otherwise, so a member with no application is still fenced.
     */
    async assertMemberWithinScope(target, user = {}) {
        if (user.role === 'super_admin') return;

        const scope = await resolveAdminScope(user);
        const app = target.application;
        const personal = (app && app.data && (app.data.personalDetails || app.data.personal)) || {};
        const member = target.member || {};

        const matches = (a, b) =>
            String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

        const region = {
            block: firstOf(app && app.block, personal.block, member.block),
            district: firstOf(app && app.district, personal.district, member.district),
            state: firstOf(app && app.state, personal.state, member.state)
        };

        const gate = {
            block_admin: ['block', scope.blockName],
            district_admin: ['district', scope.districtName],
            state_admin: ['state', scope.stateName]
        }[user.role];

        if (!gate) throw ApiError.forbidden('Your role cannot act on members');

        const [field, mine] = gate;
        if (!mine) throw ApiError.forbidden('Your admin region could not be resolved');
        if (!matches(region[field], mine)) {
            throw ApiError.forbidden('This member belongs to a different ' + field);
        }
    }

    /**
     * Activate, suspend or delete a member.
     *
     * Delete is a real cascade. It used to be `Member.findByIdAndDelete(id)`,
     * which removed the MemberDetails row and nothing else — the application,
     * the login credential and the four additional-form documents all survived,
     * so the member vanished from the directory while still being able to sign
     * in, and the orphaned rows kept their unique indexes claimed. Registering
     * again with the same email then failed with a duplicate-key error against
     * an account the admin had been told was deleted.
     *
     * Every collection keyed to the member is cleared, using the key each one
     * actually stores: `userId` for business, declaration and personal-info,
     * `memberId` for financial. They differ, and a wrong guess deletes nothing
     * while still reporting success.
     */
    async memberAction(id, action, user = {}) {
        const allowed = ['activate', 'suspend', 'delete'];
        if (!allowed.includes(action)) {
            throw ApiError.badRequest("Unknown action '" + action + "'. Use " + allowed.join(', '));
        }

        const target = await this.resolveMemberTarget(id);
        await this.assertMemberWithinScope(target, user);

        const { application, member, auth } = target;

        if (action !== 'delete') {
            if (!member) throw ApiError.notFound('This applicant has no member record to update');
            member.isActive = action === 'activate';
            await member.save();

            logger.info('Member status changed by admin', {
                memberId: member._id.toString(),
                action,
                adminId: user.userId || user.id || '',
                role: user.role || ''
            });

            return {
                id,
                action,
                isActive: member.isActive,
                memberStatus: member.isActive ? 'Active' : 'Inactive',
                status: member.isActive ? 'active' : 'suspended'
            };
        }

        const BusinessInfo = require('../members/businessinfo.model');
        const FinancialInfo = require('../members/memberfinancialinfo.model');
        const Declaration = require('../members/memberdeclaration.model');
        const PersonalInfo1 = require('../members/personalinfo1.model');
        const Company = require('../members/company.model');
        const Product = require('../../models/Product');

        // Every id the member is known by. The additional forms key off the auth
        // id on records written during registration and the member id on records
        // written from the profile screens, so both have to be swept.
        const ownerIds = [member && member._id, auth && auth._id, application && application.userId]
            .filter(Boolean)
            .map(v => v.toString());
        const byOwner = ownerIds.length ? { $in: [...new Set(ownerIds)] } : null;

        const removed = {};
        const drop = async (label, model, filter) => {
            if (!filter) { removed[label] = 0; return; }
            const result = await model.deleteMany(filter).catch(() => null);
            removed[label] = (result && result.deletedCount) || 0;
        };

        // Products first: they hang off a company that is about to go, and a
        // product whose company no longer exists is unreachable rather than
        // deleted.
        const companies = byOwner
            ? await Company.find({ userId: byOwner }).select('_id').lean().catch(() => [])
            : [];
        const companyIds = companies.map(c => c._id);
        await drop('products', Product,
            companyIds.length
                ? { $or: [{ companyId: { $in: companyIds } }, byOwner ? { userId: byOwner } : { _id: null }] }
                : (byOwner ? { userId: byOwner } : null));

        await drop('companies', Company, byOwner ? { userId: byOwner } : null);
        await drop('businessInfo', BusinessInfo, byOwner ? { userId: byOwner } : null);
        await drop('financialInfo', FinancialInfo, byOwner ? { memberId: byOwner } : null);
        await drop('declarations', Declaration, byOwner ? { $or: [{ userId: byOwner }, { memberId: byOwner }] } : null);
        await drop('personalInfo', PersonalInfo1, byOwner ? { userId: byOwner } : null);

        // The credential goes before the application. If the process dies
        // between the two, what is left is an application with no login — a row
        // the admin can see and retry — rather than a login with no application,
        // which is a live account invisible to every dashboard.
        if (member) await Member.deleteOne({ _id: member._id }).catch(() => null);
        removed.member = member ? 1 : 0;
        if (auth) await User.deleteOne({ _id: auth._id }).catch(() => null);
        removed.auth = auth ? 1 : 0;
        if (application) await Application.deleteOne({ _id: application._id }).catch(() => null);
        removed.application = application ? 1 : 0;

        logger.warn('Member deleted by admin', {
            id,
            removed,
            adminId: user.userId || user.id || '',
            role: user.role || ''
        });

        return { id, action, status: 'deleted', removed };
    }

    /** Backwards-compatible alias; `memberAction` is the implementation. */
    async userAction(id, action, user = {}) {
        return this.memberAction(id, action, user);
    }

    /**
     * The signed-in admin's own record, read from wherever it actually lives.
     *
     * The settings screen used to render entirely from the user object cached at
     * login, which meant it could only ever show what login happened to include
     * — and login did not include the phone number, so the field was blank even
     * when the account had one. Reading it here also means a number the Super
     * Admin sets afterwards appears without the admin logging out and back in.
     */
    /**
     * The signed-in admin's own record.
     *
     * Cached because it is on the critical path of every admin screen and the
     * answer is one small, near-static document. Uncached it measured 1.0s–2.2s
     * per call over HTTP against the production cluster — `findRawByEmail` has
     * to ask every admin collection, and the round trips dominate. That made it
     * the slowest thing on a dashboard load once the dashboard itself was cached.
     *
     * Cleared by `updateAdminProfile`, so an admin never reads back a stale copy
     * of an edit they just made.
     */
    async getAdminProfile(user = {}) {
        const email = String(user.email || '').toLowerCase();

        if (email) {
            const cacheKey = CACHE_KEYS.ADMIN(email);
            const cached = await cacheClient.get(cacheKey).catch(() => null);
            if (cached) return cached;

            /*
             * The warm roster first, the eight-collection lookup only if it misses.
             *
             * `findRawByEmail` fans out across every admin collection in both
             * databases. It is indexed and parallel, but it is still eight round
             * trips to a remote cluster — measured at 1.3–2.2s, and this endpoint
             * is called on every admin screen load. The roster the repository
             * already keeps warm carries exactly the seven fields below, so a hit
             * there answers with no query at all.
             *
             * A miss falls through deliberately rather than 404ing: the roster
             * excludes the unstamped scaffold accounts, and one of those can
             * still legitimately sign in.
             */
            const roster = await adminRepository.findAll().catch(() => []);
            const known = (roster || []).find(r => String(r.email || '').toLowerCase() === email);
            if (known) {
                const profile = {
                    fullName: known.fullName,
                    email: known.email,
                    phoneNumber: known.phoneNumber,
                    state: known.state,
                    district: known.district,
                    block: known.block,
                    role: known.role || user.role || ''
                };
                await cacheClient.set(cacheKey, profile, ADMIN_PROFILE_TTL_SECONDS).catch(() => null);
                return profile;
            }

            const hit = await adminRepository.findRawByEmail(email).catch(() => null);
            if (hit) {
                const row = adminRepository.toAdminRow(hit.doc, hit.source);
                const profile = {
                    fullName: row.fullName,
                    email: row.email,
                    phoneNumber: row.phoneNumber,
                    state: row.state,
                    district: row.district,
                    block: row.block,
                    role: row.role || user.role || ''
                };
                await cacheClient.set(cacheKey, profile, ADMIN_PROFILE_TTL_SECONDS).catch(() => null);
                return profile;
            }
        }

        // No admin document (a super admin authenticated off the User collection,
        // say). Fall back rather than 404 — the screen still has a profile to show.
        const fallback = email ? await User.findOne({ email }).catch(() => null) : null;
        return {
            fullName: fallback?.fullName || fallback?.name || user.fullName || '',
            email: email || String(fallback?.email || '').toLowerCase(),
            phoneNumber: fallback?.phoneNumber || fallback?.phone || '',
            state: fallback?.state || user.state || '',
            district: fallback?.district || user.district || '',
            block: fallback?.block || user.block || '',
            role: user.role || fallback?.role || ''
        };
    }

    async updateAdminProfile(user = {}, profileData = {}) {
        const { fullName, email, phoneNumber, block, district, state } = profileData;

        // Both the old and the new address: an edit that changes the email must
        // not leave the record still readable under the one it moved away from.
        await Promise.all([
            cacheClient.del(CACHE_KEYS.ADMIN(String(user.email || '').toLowerCase())).catch(() => null),
            cacheClient.del(CACHE_KEYS.ADMIN(String(email || '').toLowerCase())).catch(() => null),
            // A region change moves this admin's whole queue.
            cacheClient.delPattern(CACHE_KEYS.PATTERNS.ADMIN_DASHBOARD).catch(() => null)
        ]);

        let query = {};
        if (user.userId && mongoose.Types.ObjectId.isValid(user.userId)) {
            query = { _id: user.userId };
        } else if (user.email) {
            query = { email: user.email.toLowerCase() };
        }

        let updatedUser = null;
        if (Object.keys(query).length > 0) {
            updatedUser = await User.findOneAndUpdate(
                query,
                {
                    $set: {
                        ...(fullName ? { fullName, name: fullName } : {}),
                        ...(email ? { email: email.toLowerCase() } : {}),
                        // A truthiness test here would make an emptied field mean
                        // "unchanged", so an admin could never remove a number they
                        // had once saved. Presence of the key is the signal.
                        ...(typeof phoneNumber === 'string' ? { phoneNumber, phone: phoneNumber } : {}),
                        ...(block ? { block } : {}),
                        ...(district ? { district } : {}),
                        ...(state ? { state } : {})
                    }
                },
                { new: true }
            ).catch(() => null);
        }

        // The admin account itself, wherever it actually lives.
        //
        // This used to write straight into the unified `admins` collection. Since
        // the segregation that collection no longer holds the accounts the rest
        // of the platform reads: an account created through the Super Admin UI or
        // the pilot seed exists only in `adminsdb.{block,district,state}admins`,
        // so an admin editing their own profile updated a document that was not
        // there and the save reported success having changed nothing.
        //
        // The repository locates the record in whichever collection holds it and
        // translates the field names per collection — `phoneNumber` is stored as
        // `phone` in the unified collection and `phoneNumber` in the segregated
        // ones, and writing the wrong spelling is dropped silently by strict mode.
        const identifyingEmail = (user.email || email || '').toLowerCase();
        if (identifyingEmail) {
            try {
                const hit = await adminRepository.findRawByEmail(identifyingEmail);
                if (hit) {
                    await adminRepository.updateById(hit, {
                        ...(fullName ? { fullName } : {}),
                        ...(email ? { email: email.toLowerCase() } : {}),
                        ...(typeof phoneNumber === 'string' ? { phoneNumber } : {}),
                        ...(block ? { block } : {}),
                        ...(district ? { district } : {}),
                        ...(state ? { state } : {})
                    });
                }
            } catch (err) {
                // A profile edit must not 500 because the admin database is
                // momentarily unreachable — the User document above already
                // carries the change for the session.
                logger.warn('Admin profile update could not be written to the admin collections', {
                    email: identifyingEmail,
                    error: err && err.message
                });
            }
        }

        // Read the saved record back rather than echoing the request.
        //
        // What stood here assembled a reply from the payload with hardcoded
        // fallbacks — 'Block Admin', 'Ariyalur', 'Tamil Nadu'. Update only your
        // phone number and the response claimed you were the Block Admin for
        // Ariyalur, whichever district you actually run. Nothing consumed it
        // closely enough to break, which is precisely how a default region
        // survives long enough to be believed.
        return this.getAdminProfile({
            email: (email || user.email || '').toLowerCase(),
            role: user.role,
            state: user.state,
            district: user.district,
            block: user.block,
            fullName: fullName || user.fullName
        });
    }
}

module.exports = new AdminService();

// Exported so the approval workflow can enforce the same geofence on write
// actions that the dashboards enforce on reads.
module.exports.resolveAdminScope = resolveAdminScope;
module.exports.LEVELS = LEVELS;
// Exported for tests: the bucket rules are the heart of the workflow.
module.exports.classifyForLevel = classifyForLevel;
module.exports.reachedThisTier = reachedThisTier;
module.exports.buildMemberDirectory = buildMemberDirectory;
module.exports.buildGeoFilter = buildGeoFilter;
// Exported so the super-admin service can render the same applicant shape
// without a second, divergent flattener.
module.exports.buildApplicant = buildApplicant;
module.exports.classifyForLevel = classifyForLevel;
module.exports.escapeRegex = escapeRegex;
