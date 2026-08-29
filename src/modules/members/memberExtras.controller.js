const mongoose = require('mongoose');
const asyncHandler = require('../../core/utils/asyncHandler');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

const Company = require('./company.model');
const Activity = require('../common/activity.model');
const MembershipPlan = require('./membershipplan.model');
const MemberDetails = require('./memberdetails.model');
const memberService = require('./member.service');
const { isPaidStatus } = require('../common/memberContext');

/**
 * The endpoints the mobile app calls that this backend never served.
 *
 * `/browse-members`, `/browse-members/search`, `/companies` and
 * `/membership/plans` are all declared in the mobile app's endpoint map and all
 * answered 404, so Explore Members, My Companies and the plans screen were dead
 * on the phone. The data existed the whole time — `companies` holds records,
 * `membershipPlans` holds three tiers — there was simply no route to it.
 *
 * Recent activity and the two certificates are here for the same reason: the
 * mobile paid dashboard shows them as `Alert.alert` placeholders because there
 * was nothing to call. `activity.model.js` has existed, fully specified and
 * entirely unused, all along.
 *
 * Everything is scoped to the caller. A member reads their own companies and
 * their own activity, never anyone else's, and the scoping is done from the
 * token rather than from a parameter the caller supplies.
 */

/** The caller's own id, whatever the token generation stamped it as. */
const callerId = (req) => String((req.user || {}).userId || (req.user || {}).id || '');

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ''));

// ============================================================ browse members

/**
 * The member directory.
 *
 * A thin alias over the same service `/members` uses, because the two are the
 * same question asked by two clients. Reimplementing it would be two listings
 * to keep in step, and they would drift.
 */
const browseMembers = asyncHandler(async(req, res) => {
    const { page = 1, limit = 20, ...filter } = req.query;
    const result = await memberService.getMembers(filter, parseInt(page, 10) || 1, parseInt(limit, 10) || 20);
    res.json(ApiResponse.success(result));
});

/**
 * Search the directory.
 *
 * `q` is escaped before it reaches a regex. Without that a member typing `(`
 * into the search box gets a 500, and one typing a pathological pattern makes
 * the database do the work of matching it.
 */
const searchMembers = asyncHandler(async(req, res) => {
    const { q = '', page = 1, limit = 20 } = req.query;
    const term = String(q).trim();

    if (!term) {
        const result = await memberService.getMembers({}, parseInt(page, 10) || 1, parseInt(limit, 10) || 20);
        return res.json(ApiResponse.success(result));
    }

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    const size = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * size;

    const filter = {
        $or: [
            { fullName: pattern },
            { email: pattern },
            { organizationName: pattern },
            { district: pattern },
            { block: pattern },
            { state: pattern },
        ],
    };

    const [members, total] = await Promise.all([
        MemberDetails.find(filter).skip(skip).limit(size).lean().catch(() => []),
        MemberDetails.countDocuments(filter).catch(() => 0),
    ]);

    res.json(ApiResponse.success({
        members,
        pagination: { page: Number(page), limit: size, total, pages: Math.ceil(total / size) || 0 },
    }));
});

// ============================================================ companies

const listCompanies = asyncHandler(async(req, res) => {
    const owner = callerId(req);
    if (!owner) throw ApiError.unauthorized('No member on this token');

    const companies = await Company.find({ userId: owner, isActive: { $ne: false } })
        .sort({ createdAt: -1 })
        .lean()
        .catch(() => []);

    res.json(ApiResponse.success({ companies, total: companies.length }));
});

const getCompany = asyncHandler(async(req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('That is not a valid company id');

    const company = await Company.findById(req.params.id).lean();
    if (!company) throw ApiError.notFound('Company not found');

    // Reading someone else's company is refused rather than filtered, so the
    // caller learns nothing about whether the id exists.
    if (String(company.userId) !== callerId(req)) throw ApiError.notFound('Company not found');

    res.json(ApiResponse.success(company));
});

const createCompany = asyncHandler(async(req, res) => {
    const owner = callerId(req);
    if (!owner) throw ApiError.unauthorized('No member on this token');

    const businessName = String(req.body.businessName || '').trim();
    if (!businessName) throw ApiError.badRequest('A company needs a business name');

    const company = await Company.create({
        userId: owner,
        businessName,
        email: String(req.body.email || '').trim(),
        description: String(req.body.description || '').trim(),
        businessType: String(req.body.businessType || '').trim(),
        mobileNumber: String(req.body.mobileNumber || '').trim(),
        area: String(req.body.area || '').trim(),
        location: String(req.body.location || '').trim(),
        // An uploaded file wins over a pasted URL: it is the more deliberate act.
        logo: req.file ? `/uploads/${req.file.filename}` : String(req.body.logo || '').trim(),
        status: 'active',
        isActive: true,
    });

    await recordActivity(owner, 'profile_update', 'Profile', company._id, `Added company ${businessName}`);
    res.status(201).json(ApiResponse.created(company, 'Company created'));
});

const updateCompany = asyncHandler(async(req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('That is not a valid company id');

    const existing = await Company.findById(req.params.id).lean();
    if (!existing || String(existing.userId) !== callerId(req)) throw ApiError.notFound('Company not found');

    const update = {};
    ['businessName', 'email', 'description', 'businessType', 'mobileNumber', 'area', 'location', 'status']
        .forEach((field) => {
            if (req.body[field] !== undefined) update[field] = String(req.body[field]).trim();
        });

    if (req.file) update.logo = `/uploads/${req.file.filename}`;
    else if (req.body.logo !== undefined) update.logo = String(req.body.logo).trim();

    const company = await Company.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
    await recordActivity(callerId(req), 'profile_update', 'Profile', company._id, `Updated company ${company.businessName}`);

    res.json(ApiResponse.success(company, 'Company updated'));
});

/**
 * Retire a company rather than erase it.
 *
 * Products reference their company, and a hard delete leaves them pointing at
 * nothing. `isActive: false` takes it out of every listing while keeping those
 * references intact.
 */
const deleteCompany = asyncHandler(async(req, res) => {
    if (!isObjectId(req.params.id)) throw ApiError.badRequest('That is not a valid company id');

    const existing = await Company.findById(req.params.id).lean();
    if (!existing || String(existing.userId) !== callerId(req)) throw ApiError.notFound('Company not found');

    await Company.findByIdAndUpdate(req.params.id, { $set: { isActive: false, status: 'inactive' } });
    res.json(ApiResponse.success({ id: req.params.id }, 'Company removed'));
});

// ============================================================ plans

/**
 * The membership tiers, cheapest first.
 *
 * Public: someone deciding whether to join needs to see what it costs before
 * they have an account to sign in with.
 */
const listPlans = asyncHandler(async(req, res) => {
    const plans = await MembershipPlan.find({ isActive: { $ne: false } })
        .sort({ displayOrder: 1, amountPaise: 1 })
        .lean()
        .catch(() => []);

    res.json(ApiResponse.success({
        plans: plans.map(p => ({
            ...p,
            // Both units, because the payment call needs paise and the screen
            // needs rupees, and every client converting it itself is every
            // client getting a chance to divide by the wrong number.
            amount: (p.amountPaise || 0) / 100,
            entitlements: p.entitlements || [],
        })),
        total: plans.length,
    }));
});

// ============================================================ activity

/**
 * Write one activity row.
 *
 * Never throws. An activity feed is a record of what happened, not part of
 * making it happen, and a failure to log must not fail the action that was
 * being logged.
 */
const recordActivity = async(memberId, activityType, entityType, entityId, description, metadata) => {
    try {
        if (!memberId || !isObjectId(memberId)) return null;
        return await Activity.create({ memberId, activityType, entityType, entityId, description, metadata });
    } catch (err) {
        logger.warn('Could not record activity', { activityType, error: err && err.message });
        return null;
    }
};

const listActivity = asyncHandler(async(req, res) => {
    const owner = callerId(req);
    if (!owner) throw ApiError.unauthorized('No member on this token');

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const activities = await Activity.find({ memberId: owner })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
        .catch(() => []);

    res.json(ApiResponse.success({
        activities: activities.map(a => ({
            id: String(a._id),
            type: a.activityType,
            description: a.description || '',
            entityType: a.entityType || '',
            at: a.createdAt,
        })),
        total: activities.length,
    }));
});

// ============================================================ certificates

const CERTIFICATES = {
    membership: {
        title: 'Certificate of Membership',
        body: 'is a registered member of the Adidravidar Confederation of Trade and Industrial Vision.',
    },
    'tax-exemption': {
        title: 'Tax Exemption Certificate',
        body: 'Contributions made to ACTIV by the member named above are eligible for exemption under the applicable provisions of the Income Tax Act.',
    },
};

/**
 * The data behind a certificate, and nothing more.
 *
 * No PDF is generated here on purpose. Rendering one server-side means a new
 * dependency and a font bundle to produce a document whose only job is to be
 * printed, and the two clients already have a renderer each — a browser that
 * prints, and a native share sheet. Returning the fields lets both draw a
 * certificate that matches the rest of their design.
 *
 * Issued only to a member whose membership is actually active. A certificate is
 * a claim about status, and one issued to someone who has not paid is a false
 * claim this server put its name to.
 */
const getCertificate = asyncHandler(async(req, res) => {
    const kind = String(req.params.kind || '').toLowerCase();
    const spec = CERTIFICATES[kind];
    if (!spec) throw ApiError.notFound('No such certificate');

    const owner = callerId(req);
    if (!owner) throw ApiError.unauthorized('No member on this token');

    const member = await MemberDetails.findById(owner).lean();
    if (!member) throw ApiError.notFound('No member profile for this account');

    // Paid, not merely approved — a certificate names someone as a paid-up
    // member. `PAID_STATUSES` is the one list every such check reads.
    const active = isPaidStatus(member.membershipStatus)
        || String(member.paymentStatus || '').toLowerCase() === 'completed';

    if (!active) {
        throw ApiError.forbidden('A certificate is issued once membership is active');
    }

    res.json(ApiResponse.success({
        kind,
        title: spec.title,
        body: spec.body,
        member: {
            name: member.fullName || '',
            membershipNumber: member.membershipNumber || String(member._id).slice(-8).toUpperCase(),
            email: member.email || '',
            block: member.block || '',
            district: member.district || '',
            state: member.state || '',
        },
        memberSince: member.approvedAt || member.createdAt || null,
        // Stamped at read time rather than stored: the certificate is generated
        // on demand, and the date on it should be the date it was issued.
        issuedAt: new Date(),
        issuedBy: 'Adidravidar Confederation of Trade and Industrial Vision',
    }));
});

module.exports = {
    browseMembers, searchMembers,
    listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
    listPlans,
    listActivity, recordActivity,
    getCertificate,
};
