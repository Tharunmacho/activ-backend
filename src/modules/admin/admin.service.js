const mongoose = require('mongoose');
const User = require('../auth/auth.model');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const ApiError = require('../../core/utils/ApiError');
const { normalizeStatus } = require('../common/applicationStatus');

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
const classifyForLevel = (application, level) => {
    const status = normalizeStatus(application.status);
    const isRejected = status === 'Rejected';

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
const buildApplicant = (application, member = {}, index = 0, level = LEVELS.BLOCK, scope = {}) => {
    const data = application.data || {};
    const personal = data.personalDetails || data.personal || data;
    const business = data.businessInfo || data.business || data;
    const financial = data.financialInfo || data.financial || data;
    const declaration = data.declaration || data;

    const stage = classifyForLevel(application, level);
    const id = application._id.toString();
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

    const needsLookup = !blockName || !districtName || !stateName;
    if (needsLookup && (user.email || user.userId)) {
        const email = String(user.email || '').toLowerCase();
        const adminDoc = await mongoose.connection.db.collection('admins').findOne({
            $or: [
                { email: user.email },
                { email }
            ]
        }).catch(() => null);

        if (adminDoc) {
            blockName = blockName || adminDoc.block;
            districtName = districtName || adminDoc.district;
            stateName = stateName || adminDoc.state;
        }
    }

    return {
        blockName: blockName || 'Ariyalur',
        districtName: districtName || 'Ariyalur',
        stateName: stateName || 'Tamil Nadu',
        // True when we never found a real value and fell back to a default —
        // callers can log this, since it means the geofence is not trustworthy.
        resolvedFromDefault: {
            block: !blockName,
            district: !districtName,
            state: !stateName
        }
    };
};

/** Case-insensitive exact-match filter across the three places a location can live. */
const buildGeoFilter = (field, value) => {
    const regex = new RegExp(`^${escapeRegex(value)}$`, 'i');
    return {
        $or: [
            { [field]: regex },
            { [`data.personalDetails.${field}`]: regex },
            { [`data.personal.${field}`]: regex }
        ]
    };
};

/** Shared loader: geofenced application fetch + member-profile hydration. */
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

    const applicants = applications.map((app, index) =>
        buildApplicant(app, memberByEmail[(app.email || '').toLowerCase()] || {}, index, level, scope)
    );

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
    async getBlockDashboard(user = {}) {
        const scope = await resolveAdminScope(user);
        const { blockName, districtName, stateName } = scope;

        // Geofenced query: strictly retrieve applications assigned to THIS block.
        const blockFilter = buildGeoFilter('block', blockName);
        const blockRegex = new RegExp(`^${escapeRegex(blockName)}$`, 'i');

        const { totalMembers, applications, applicants } = await loadApplicants(
            blockFilter,
            { block: blockRegex },
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

    async getDistrictDashboard(user = {}) {
        const scope = await resolveAdminScope(user);
        const { districtName, stateName } = scope;

        // Geofenced query: strictly retrieve applications assigned to THIS district.
        const districtFilter = buildGeoFilter('district', districtName);
        const districtRegex = new RegExp(`^${escapeRegex(districtName)}$`, 'i');

        const { totalMembers, applicants } = await loadApplicants(
            districtFilter,
            { district: districtRegex },
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

        // One row per block feeding this district, derived from the real data
        // instead of the previous hardcoded single-block placeholder.
        const blockRollup = new Map();
        applicants.forEach(a => {
            const name = a.block || 'Unassigned';
            const row = blockRollup.get(name) || { id: name, name, members: 0, pendingApplications: 0 };
            row.members += 1;
            if (a.stage === 'pending') row.pendingApplications += 1;
            blockRollup.set(name, row);
        });

        return {
            stats: {
                totalMembers: approved.length > 0 ? approved.length : applicants.length,
                totalBlocks: blockRollup.size,
                pendingApplications: pending.length,
                approvedApplications: approved.length,
                rejectedApplications: rejected.length,
                totalApplications: applicants.length,
                activeBusinesses: applicants.filter(a => a.businessInfo.doingBusiness).length,
                totalRevenue: 0,
                districtName,
                stateName
            },
            applicants: {
                pending,
                approved,
                rejected,
                all: applicants
            },
            blocks: blockRollup.size > 0
                ? [...blockRollup.values()]
                : [{ id: '1', name: `${districtName} Block`, members: totalMembers || 0, pendingApplications: 0 }]
        };
    }

    async getStateDashboard(user = {}) {
        const scope = await resolveAdminScope(user);
        const { stateName } = scope;

        // Geofenced query: strictly retrieve applications assigned to THIS state.
        const stateFilter = buildGeoFilter('state', stateName);
        const stateRegex = new RegExp(`^${escapeRegex(stateName)}$`, 'i');

        const { totalMembers, applicants } = await loadApplicants(
            stateFilter,
            { state: stateRegex },
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

        const districtRollup = new Map();
        applicants.forEach(a => {
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
                totalMembers: approved.length > 0 ? approved.length : applicants.length,
                totalDistricts: districts.length,
                totalBlocks: new Set(applicants.map(a => a.block).filter(Boolean)).size,
                pendingApplications: pending.length,
                approvedApplications: approved.length,
                rejectedApplications: rejected.length,
                totalApplications: applicants.length,
                activeBusinesses: applicants.filter(a => a.businessInfo.doingBusiness).length,
                totalRevenue: 0,
                stateName
            },
            applicants: {
                pending,
                approved,
                rejected,
                all: applicants
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
     * Activate / suspend / delete a user, used by UserManagementScreen.
     */
    async userAction(userId, action) {
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            throw ApiError.badRequest('Invalid user id');
        }

        const allowed = ['activate', 'suspend', 'delete'];
        if (!allowed.includes(action)) {
            throw ApiError.badRequest(`Unknown action '${action}'. Use ${allowed.join(', ')}`);
        }

        if (action === 'delete') {
            const removed = await Member.findByIdAndDelete(userId).catch(() => null);
            if (!removed) throw ApiError.notFound('User not found');
            return { id: userId, action, status: 'deleted' };
        }

        const member = await Member.findById(userId);
        if (!member) throw ApiError.notFound('User not found');

        member.isActive = action === 'activate';
        await member.save();

        return { id: userId, action, status: member.isActive ? 'active' : 'suspended' };
    }

    async updateAdminProfile(user = {}, profileData = {}) {
        const { fullName, email, phoneNumber, block, district, state } = profileData;

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
                        ...(phoneNumber ? { phoneNumber, phone: phoneNumber } : {}),
                        ...(block ? { block } : {}),
                        ...(district ? { district } : {}),
                        ...(state ? { state } : {})
                    }
                },
                { new: true }
            ).catch(() => null);
        }

        if (user.email || email) {
            const targetEmail = (email || user.email || '').toLowerCase();
            await mongoose.connection.db.collection('admins').updateOne(
                { $or: [{ email: targetEmail }, { email: (user.email || '').toLowerCase() }] },
                {
                    $set: {
                        ...(fullName ? { fullName, name: fullName } : {}),
                        ...(email ? { email: email.toLowerCase() } : {}),
                        ...(phoneNumber ? { phone: phoneNumber } : {}),
                        ...(block ? { block } : {}),
                        ...(district ? { district } : {}),
                        ...(state ? { state } : {})
                    }
                }
            ).catch(() => null);
        }

        return {
            fullName: fullName || updatedUser?.fullName || user.fullName || 'Block Admin',
            email: (email || updatedUser?.email || user.email || 'admin@activ.com').toLowerCase(),
            phoneNumber: phoneNumber || updatedUser?.phoneNumber || '',
            block: block || updatedUser?.block || 'Ariyalur',
            district: district || updatedUser?.district || 'Ariyalur',
            state: state || updatedUser?.state || 'Tamil Nadu',
            role: user.role || 'block_admin'
        };
    }
}

module.exports = new AdminService();

// Exported so the approval workflow can enforce the same geofence on write
// actions that the dashboards enforce on reads.
module.exports.resolveAdminScope = resolveAdminScope;
module.exports.LEVELS = LEVELS;
// Exported for tests: the bucket rules are the heart of the workflow.
module.exports.classifyForLevel = classifyForLevel;
module.exports.buildGeoFilter = buildGeoFilter;