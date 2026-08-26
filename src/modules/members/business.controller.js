const Company = require('../members/company.model');
const MemberDetails = require('../members/memberdetails.model');
const Product = require('../../models/Product');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const asyncHandler = require('../../core/utils/asyncHandler');
const mongoose = require('mongoose');
const { normalizeBusinessType, businessTypeError } = require('./businessTypes');

/**
 * The one filter every owner-scoped company query starts from.
 *
 * It was written inline as `{ $exists: true, $ne: null, $ne: '' }`, which is a
 * JavaScript object literal with a duplicate key: `$ne: null` is discarded
 * before Mongo ever sees it, so rows with a null businessName passed a guard
 * that was written to exclude them. `$nin` states both in one key.
 */
const NAMED = { businessName: { $exists: true, $nin: [null, ''] } };

/**
 * Which company "me" means when a member owns several.
 *
 * Declared once because read and write must agree: they did not, and the
 * disagreement was invisible until a member created a second company.
 */
const NEWEST_FIRST = { createdAt: -1 };

/**
 * Create a new business profile (stores in companies collection and uploads folder)
 */
const createBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    const {
        organizationName,
        businessName,
        description,
        businessTypes,
        businessType,
        phone,
        mobileNumber,
        email,
        area,
        location
    } = req.body;

    const name = (businessName || organizationName || '').trim();
    const mobile = (mobileNumber || phone || '').trim();
    const loc = (location || '').trim();
    const rawType = businessType || businessTypes;

    // Validate required fields
    if (!name) {
        throw ApiError.badRequest('Business name is required');
    }
    if (!mobile) {
        throw ApiError.badRequest('Mobile number is required');
    }
    if (!loc) {
        throw ApiError.badRequest('Location is required');
    }

    /**
     * Business type, checked here rather than at the schema.
     *
     * Reaching the enum meant the request had already been accepted, the logo
     * already written to disk, and the failure came back as a 500 with a
     * Mongoose sentence in it ("`Wholesaler` is not a valid enum value for
     * path `businessType`"). That is a server error for what is a choice the
     * form should not have offered. Checked here it is a 400 that names the
     * values that would work.
     *
     * `businessTypes` may arrive as a JSON array (the mobile profile screen
     * sends `["Manufacturing"]`) or as a bare string; both are handled.
     */
    let finalType = 'Manufacturing';
    if (rawType) {
        let types = rawType;
        if (typeof rawType === 'string') {
            try {
                types = JSON.parse(rawType);
            } catch (e) {
                types = [rawType];
            }
        }
        const picked = Array.isArray(types) ? types[0] : types;
        finalType = normalizeBusinessType(picked);
        if (!finalType) {
            throw ApiError.badRequest(businessTypeError(picked));
        }
    }

    // Process uploaded logo file saved in local /uploads directory
    let logoUrl = '';
    if (req.file) {
        // Store a relative path, never an absolute URL. req.get('host') is
        // whatever the *uploading* device dialled (localhost / 10.0.2.2 / a LAN
        // IP), so baking it into the document makes the image unreachable from
        // every other device and breaks whenever that IP changes. The client
        // resolves this against the API origin it is actually talking to.
        logoUrl = `/uploads/${req.file.filename}`;
    }

    // Create business profile in companies collection
    const businessProfile = new Company({
        userId,
        businessName: name,
        email: email ? email.trim() : '',
        description: description ? description.trim() : '',
        businessType: finalType,
        mobileNumber: mobile,
        area: area ? area.trim() : '',
        location: loc,
        logo: logoUrl,
        status: 'pending'
    });

    await businessProfile.save();

    res.status(201).json(
        ApiResponse.created(businessProfile, 'Business profile created successfully')
    );
});

/**
 * Get business profile by member ID
 */
const getBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // Ownership is `userId` and nothing else.
    //
    // This used to also match `{ email: <the member's login address> }` against
    // the company's own contact address. Those are different things: the
    // company email is free text the member types, so any member who happened
    // to enter another member's address — or who shared a shop address with
    // them — was handed that member's company. Nothing keeps the two in step,
    // and a business profile is not something to hand out on a coincidence.
    const businessProfile = await Company.findOne({ userId, ...NAMED })
        .sort(NEWEST_FIRST)
        .lean();

    if (!businessProfile) {
        return res.json(ApiResponse.success(null, 'Business profile not found'));
    }

    res.json(
        ApiResponse.success(businessProfile, 'Business profile fetched successfully')
    );
});

/**
 * Get all business profiles for a user
 */
const getAllBusinessProfiles = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // Owner-scoped only; see the note in getBusinessProfile.
    const businessProfiles = await Company.find({ userId, ...NAMED })
        .sort(NEWEST_FIRST)
        .lean();

    res.json(
        ApiResponse.success(businessProfiles, 'Business profiles fetched successfully')
    );
});

/**
 * Get business profile by ID
 */
const getBusinessProfileById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    /**
     * Owner-scoped, with no fallback.
     *
     * What stood here fell back to `findOne({ _id: id })` when the owner-scoped
     * lookup missed — which is to say, precisely when the company belonged to
     * somebody else. Any signed-in member could read any other member's
     * business profile by id: name, contact number, email, address. The second
     * fallback was its own bug, quietly answering with the caller's newest
     * company when the id matched nothing, so a stale link rendered the wrong
     * company as though it were the one asked for.
     *
     * The write paths beside this one were corrected already; this read was
     * missed. A miss is a 404 now, in every case.
     */
    let businessProfile;
    if (id === 'me' || !mongoose.Types.ObjectId.isValid(id)) {
        businessProfile = await Company.findOne({ userId, ...NAMED })
            .sort(NEWEST_FIRST)
            .lean();
    } else {
        businessProfile = await Company.findOne({ _id: id, userId, ...NAMED }).lean();
    }

    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    res.json(
        ApiResponse.success(businessProfile, 'Business profile fetched successfully')
    );
});

/**
 * Update business profile
 */
const updateBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const {
        organizationName,
        businessName,
        description,
        businessTypes,
        businessType,
        phone,
        mobileNumber,
        email,
        area,
        location
    } = req.body;

    // Same row GET /me returns.
    //
    // The read sorted newest-first and this did not, so for a member with more
    // than one company the dashboard showed one and the save was written to
    // another. There is one such member in the data today: the sidebar reads
    // "Local host" while this handler would have written to "Activ".
    const businessProfile = await Company.findOne({ userId }).sort(NEWEST_FIRST);

    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    const name = businessName || organizationName;
    const mobile = mobileNumber || phone;
    const rawType = businessType || businessTypes;

    // Same check as createBusinessProfile — an edit can send a bad type too.
    if (rawType) {
        let types = rawType;
        if (typeof rawType === 'string') {
            try {
                types = JSON.parse(rawType);
            } catch (e) {
                types = [rawType];
            }
        }
        const picked = Array.isArray(types) ? types[0] : types;
        const normalized = normalizeBusinessType(picked);
        if (!normalized) {
            throw ApiError.badRequest(businessTypeError(picked));
        }
        businessProfile.businessType = normalized;
    }

    // Process uploaded logo file saved in local /uploads directory
    if (req.file) {
        // Relative path only - see the note in createBusinessProfile.
        businessProfile.logo = `/uploads/${req.file.filename}`;
    }

    // Update fields
    if (name) businessProfile.businessName = name.trim();
    if (description !== undefined) businessProfile.description = description.trim();
    if (mobile) businessProfile.mobileNumber = mobile.trim();
    if (email !== undefined) businessProfile.email = email.trim();
    if (area !== undefined) businessProfile.area = area.trim();
    if (location) businessProfile.location = location.trim();

    // Listing visibility in the Discover directory.
    if (req.body.isActive !== undefined) {
        businessProfile.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    await businessProfile.save();

    res.json(
        ApiResponse.success(businessProfile, 'Business profile updated successfully')
    );
});

/**
 * Update business profile by ID
 */
const updateBusinessProfileById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;
    const {
        organizationName,
        businessName,
        description,
        businessTypes,
        businessType,
        phone,
        mobileNumber,
        email,
        area,
        location
    } = req.body;

    let businessProfile;
    if (id === 'me' || !mongoose.Types.ObjectId.isValid(id)) {
        businessProfile = await Company.findOne({ userId }).sort(NEWEST_FIRST);
    } else {
        // Owner-scoped only. Falling back to "any company with this id", then
        // to the member's newest company, meant an edit could be written to a
        // different record than the one the user opened.
        businessProfile = await Company.findOne({ _id: id, userId });
    }

    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    if (!businessProfile.userId) {
        businessProfile.userId = userId;
    }

    const name = businessName || organizationName;
    const mobile = mobileNumber || phone;
    const rawType = businessType || businessTypes;

    // Same check as createBusinessProfile — an edit can send a bad type too.
    if (rawType) {
        let types = rawType;
        if (typeof rawType === 'string') {
            try {
                types = JSON.parse(rawType);
            } catch (e) {
                types = [rawType];
            }
        }
        const picked = Array.isArray(types) ? types[0] : types;
        const normalized = normalizeBusinessType(picked);
        if (!normalized) {
            throw ApiError.badRequest(businessTypeError(picked));
        }
        businessProfile.businessType = normalized;
    }

    // Process uploaded logo file saved in local /uploads directory
    if (req.file) {
        // Relative path only - see the note in createBusinessProfile.
        businessProfile.logo = `/uploads/${req.file.filename}`;
    }

    // Update fields
    if (name) businessProfile.businessName = name.trim();
    if (description !== undefined) businessProfile.description = description.trim();
    if (mobile) businessProfile.mobileNumber = mobile.trim();
    if (email !== undefined) businessProfile.email = email.trim();
    if (area !== undefined) businessProfile.area = area.trim();
    if (location) businessProfile.location = location.trim();

    // Listing visibility in the Discover directory.
    if (req.body.isActive !== undefined) {
        businessProfile.isActive = req.body.isActive === true || req.body.isActive === 'true';
    }

    await businessProfile.save();

    res.json(
        ApiResponse.success(businessProfile, 'Business profile updated successfully')
    );
});

/**
 * Delete business profile
 */
const deleteBusinessProfileById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest('Invalid company id');
    }

    // Scoped to the owner - an id alone must not authorise a delete.
    const businessProfile = await Company.findOne({ _id: id, userId });

    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    await businessProfile.deleteOne();

    // The company's catalog would otherwise be orphaned and keep showing up
    // in product queries.
    await Product.deleteMany({ companyId: businessProfile._id });

    /**
     * `hasBusinessProfile` is derived, not stored.
     *
     * These two handlers used to write it onto the member document. It is not
     * declared on the MemberDetails schema, so Mongoose strict mode dropped the
     * path without error — no member document has ever carried it, and nothing
     * reads it back. Keeping the write would be worse than useless: it reads as
     * a maintained flag while create, transfer and bulk paths never touched it.
     * Whether a member has a company is one count away
     * (`Company.countDocuments({ userId })`) and cannot fall out of step.
     */
    res.json(
        ApiResponse.success({ _id: id }, 'Business profile deleted successfully')
    );
});

const deleteBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    // Newest-first, matching GET /me — deleting a different company than the
    // one on screen is not a mistake that can be undone.
    const businessProfile = await Company.findOne({ userId }).sort(NEWEST_FIRST);

    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    await businessProfile.deleteOne();
    await Product.deleteMany({ companyId: businessProfile._id });

    // See the note in deleteBusinessProfileById: the flag is derived.
    res.json(
        ApiResponse.success(null, 'Business profile deleted successfully')
    );
});

/**
 * Escape regex metacharacters so a raw search term cannot break the query
 */
const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Get all companies for discovery (network wide - every registered company).
 *
 * This is the ONLY company endpoint that is not scoped to req.user: the buyer
 * side of the network has to be able to find a supplier they do not own.
 * Optional ?q= matches company fields OR any of the company's product fields,
 * so searching "chairs" surfaces every company that actually sells chairs.
 */
const discoverCompanies = asyncHandler(async (req, res) => {
    const term = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

    const baseFilter = {
        ...NAMED,
        // Members can delist a company from the directory; `$ne: false` keeps
        // legacy rows that predate the flag visible.
        isActive: { $ne: false }
    };

    const COMPANY_FIELDS =
        'businessName email description businessType mobileNumber area location logo isActive status createdAt';

    let companies;
    let searchRegex = null;

    if (!term) {
        companies = await Company.find(baseFilter)
            .select(COMPANY_FIELDS)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
    } else {
        searchRegex = new RegExp(escapeRegex(term), 'i');

        /**
         * Two independent lookups, run together.
         *
         * This was three requests in a row: find matching products, then find
         * companies whose id was in that result OR whose own name matched, then
         * find the catalogs. Against a remote cluster each step is its own
         * ~100ms round trip, and the first two do not actually depend on each
         * other — only the *combination* does. Issuing them in parallel and
         * merging the ids here turns three sequential waits into two.
         *
         * Company identity is matched on name and type only. `description` /
         * `location` / `area` are prose fields, and including them made a short
         * term match nearly every row, so the search read as "shows everything".
         */
        const [matchedProducts, companiesByName] = await Promise.all([
            Product.find({
                isActive: true,
                $or: [
                    { name: searchRegex },
                    { category: searchRegex },
                    { sku: searchRegex }
                ]
            }).select('companyId').lean(),
            Company.find({
                ...baseFilter,
                $or: [
                    { businessName: searchRegex },
                    { businessType: searchRegex }
                ]
            }).select(COMPANY_FIELDS).sort({ createdAt: -1 }).limit(limit).lean(),
        ]);

        const seen = new Set((companiesByName || []).map((c) => String(c._id)));

        // Sellers of a matching product that the name search did not already
        // return. Only these need a second lookup.
        const extraIds = [...new Set(
            (matchedProducts || [])
                .map((p) => p.companyId)
                .filter(Boolean)
                .map(String)
                .filter((id) => !seen.has(id))
        )];

        const extraCompanies = extraIds.length
            ? await Company.find({ ...baseFilter, _id: { $in: extraIds } })
                .select(COMPANY_FIELDS)
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean()
            : [];

        companies = [...(companiesByName || []), ...extraCompanies].slice(0, limit);
    }

    const companyIds = (companies || []).map((c) => c._id);

    const products = companyIds.length
        ? await Product.find({ companyId: { $in: companyIds }, isActive: true })
            .select('name category price stock sku description imageUrl isFeatured companyId')
            .sort({ isFeatured: -1, createdAt: -1 })
            .lean()
        : [];

    const productsByCompany = new Map();
    (products || []).forEach((p) => {
        const key = String(p.companyId || '');
        if (!productsByCompany.has(key)) productsByCompany.set(key, []);
        productsByCompany.get(key).push(p);
    });

    const matchesTerm = (product) => {
        if (!searchRegex) return false;
        return (
            searchRegex.test(product.name || '') ||
            searchRegex.test(product.category || '') ||
            searchRegex.test(product.sku || '')
        );
    };

    const data = (companies || []).map((company) => {
        const catalog = productsByCompany.get(String(company._id)) || [];
        return {
            ...company,
            products: catalog,
            matchedProducts: searchRegex ? catalog.filter(matchesTerm) : []
        };
    });

    res.json(
        ApiResponse.success(data, 'Companies fetched successfully')
    );
});

module.exports = {
    createBusinessProfile,
    getBusinessProfile,
    getAllBusinessProfiles,
    getBusinessProfileById,
    updateBusinessProfile,
    updateBusinessProfileById,
    deleteBusinessProfile,
    deleteBusinessProfileById,
    discoverCompanies
};
