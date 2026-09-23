const Company = require('../members/company.model');
const TrustedCompany = require('../members/trustedcompany.model');
const MemberDetails = require('../members/memberdetails.model');
/* Which membership statuses count as PAID, from the one place that decides
   it. A second copy is how two screens come to disagree about who is a
   member — see the note where the star is built. */
const { isPaidStatus } = require('../common/memberContext');
const Product = require('../../models/Product');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const asyncHandler = require('../../core/utils/asyncHandler');
const mongoose = require('mongoose');
const { normalizeBusinessType, businessTypeError } = require('./businessTypes');
const { listedOwnerIds } = require('../common/regionOwners');
const {
    CONSTITUTION_TYPES,
    GOVT_REGISTRATIONS,
    TURNOVER_SLABS,
    ALL_TURNOVER_RANGES,
} = require('./businessOptions');

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
 * The company's own business and financial details, applied from a request body.
 *
 * ONE function for create and both update paths. It was going to be three
 * copies of the same twenty assignments, and three copies is how the
 * `doingBusiness` / `registrationType` disagreement documented in
 * `member.controller.js` came about — two places deriving one answer, and
 * whichever ran last won.
 *
 * Two shapes of body reach here. A save with a new logo is `multipart/form-data`
 * and EVERY field of it is a string: `filedITR` arrives as `"false"`, and
 * `govtSchemes` as `'["MUDRA"]'` or as a bare `"MUDRA"`. A save without one is
 * JSON with real Booleans and real arrays. Both are normalised below, because
 * a flag that survives a text-only save and vanishes the moment an image is
 * attached is the exact failure this file already carries a note about for
 * `logo`.
 *
 * An ABSENT field means untouched, never blank. Re-saving from a screen that
 * does not render a control must not clear what another screen set.
 */
const asBool = (value) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'yes' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 'no' || value === 0 || value === '0') return false;
    return undefined;
};

/** A list out of JSON, a repeated field, a comma string, or a single value. */
const asList = (value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
    const raw = String(value).trim();
    if (raw.startsWith('[')) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
        } catch (e) {
            /* not JSON after all — fall through to the comma split */
        }
    }
    return raw.split(',').map((v) => v.trim()).filter(Boolean);
};

/** Trimmed text fields that are copied across as-is. */
const COMPANY_TEXT_FIELDS = [
    'businessActivities',
    'numberOfEmployees',
    'otherChamber',
    'panNumber',
    'gstNumber',
    'turnoverOther',
    'msmeUdyamNumber',
    'exportCouncilName',
    'exportCouncilRegNumber',
    'otherRegistrationDetails',
    'schemeDetails',
];

/**
 * Product categories, out of a body that may be JSON or multipart.
 *
 * A list of objects cannot survive `FormData.append` as anything but a string,
 * so the client sends it JSON-encoded when a logo is attached and as a real
 * array otherwise. Both are read here — a field that survives a text-only save
 * and vanishes the moment an image is picked is the failure this file already
 * carries a note about for `logo` itself.
 *
 * Each entry is trimmed and capped rather than validated against the NIC
 * catalogue: an entry with an empty `code` is a category NIC does not list, and
 * that is a legitimate answer. See the note on the schema field.
 */
const MAX_PRODUCT_CATEGORIES = 10;

const parseProductCategories = (value) => {
    if (value === undefined) return undefined;

    let list = value;
    if (typeof list === 'string') {
        const raw = list.trim();
        if (!raw) return [];
        try {
            list = JSON.parse(raw);
        } catch (e) {
            // A bare string is one category, typed by hand.
            list = [{ description: raw }];
        }
    }
    if (!Array.isArray(list)) return [];

    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const item = (entry && typeof entry === 'object') ? entry : { description: entry };
        const description = String(item.description ?? '').trim().slice(0, 300);
        if (!description) continue;

        const code = String(item.code ?? '').trim().slice(0, 8);
        // One row per category. The picker already refuses a duplicate, but a
        // request does not have to come from the picker.
        const key = code || description.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
            code,
            description,
            industryType: String(item.industryType ?? '').trim().slice(0, 40)
        });
        if (out.length >= MAX_PRODUCT_CATEGORIES) break;
    }
    return out;
};

const applyCompanyDetails = (company, body) => {
    COMPANY_TEXT_FIELDS.forEach((field) => {
        if (body[field] !== undefined) company[field] = String(body[field] ?? '').trim();
    });

    if (body.constitutionType !== undefined) {
        const value = String(body.constitutionType || '').trim();
        // Checked here rather than at the enum: reaching Mongoose means the
        // request was already accepted and the logo already written to disk,
        // and the member gets a 500 with a Mongoose sentence in it for what is
        // a choice the form should not have offered.
        if (value && !CONSTITUTION_TYPES.includes(value)) {
            throw ApiError.badRequest(
                `"${value}" is not a valid constitution. Choose one of: ${CONSTITUTION_TYPES.join(', ')}.`
            );
        }
        company.constitutionType = value;
    }

    const chamber = asBool(body.memberOfOtherChamber);
    if (chamber !== undefined) company.memberOfOtherChamber = chamber;

    const itr = asBool(body.filedITR);
    if (itr !== undefined) company.filedITR = itr;

    if (body.turnoverRange !== undefined) {
        const value = String(body.turnoverRange || '').trim();
        if (value && !ALL_TURNOVER_RANGES.includes(value)) {
            throw ApiError.badRequest(
                `"${value}" is not a valid turnover range. Choose one of: ${TURNOVER_SLABS.join(', ')}.`
            );
        }
        company.turnoverRange = value;
        // The manual figure belongs to exactly one slab. Leaving it behind when
        // the member moves off "Other / Manual Entry" stores two turnovers that
        // disagree, and nothing on screen shows the stale one.
        if (value !== 'Other / Manual Entry' && body.turnoverOther === undefined) {
            company.turnoverOther = '';
        }
    }

    // An explicit empty array is a real answer — "I cleared my selection" — so
    // these test for `undefined`, not for emptiness.
    const registrations = body.govtRegistrations === undefined
        ? undefined
        : (asList(body.govtRegistrations) || []);
    if (registrations !== undefined) {
        const unknown = registrations.find((r) => !GOVT_REGISTRATIONS.includes(r));
        if (unknown) {
            throw ApiError.badRequest(
                `"${unknown}" is not a valid government registration. Choose from: ${GOVT_REGISTRATIONS.join(', ')}.`
            );
        }
        company.govtRegistrations = registrations;
    }

    const schemes = body.govtSchemes === undefined ? undefined : (asList(body.govtSchemes) || []);
    if (schemes !== undefined) company.govtSchemes = schemes;

    // An explicit empty array clears the field — the member removed every chip.
    const categories = parseProductCategories(body.productCategories);
    if (categories !== undefined) company.productCategories = categories;
};

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

    // Store a relative path, never an absolute URL. req.get('host') is whatever
    // the *uploading* device dialled (localhost / 10.0.2.2 / a LAN IP), so
    // baking it into the document makes the image unreachable from every other
    // device and breaks whenever that IP changes. The client resolves this
    // against the API origin it is actually talking to.
    const logoUrl = pickUpload(req, 'logo') || '';

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
        banner: pickUpload(req, 'banner') || '',
        status: 'pending'
    });

    // Constitution, affiliations, turnover, registrations — everything the
    // Business Creation Account asks for beyond identity and contact.
    applyCompanyDetails(businessProfile, req.body);

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
    // `+panNumber` — it is `select: false` on the schema so it cannot leak
    // through a listing, and the owner reading their own company is the one
    // caller entitled to it. Without this the edit form opens with the PAN box
    // empty and saving the form erases the stored number.
    const businessProfile = await Company.findOne({ userId, ...NAMED })
        .select('+panNumber')
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
            .select('+panNumber')
            .sort(NEWEST_FIRST)
            .lean();
    } else {
        // Owner-scoped, so `+panNumber` is safe here — see getBusinessProfile.
        businessProfile = await Company.findOne({ _id: id, userId, ...NAMED })
            .select('+panNumber')
            .lean();
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
    const businessProfile = await Company.findOne({ userId })
        .select('+panNumber')
        .sort(NEWEST_FIRST);

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
    // Relative paths only - see the note in createBusinessProfile. An image
    // that was not re-sent keeps whatever is stored.
    const nextLogo = pickUpload(req, 'logo');
    if (nextLogo) businessProfile.logo = nextLogo;
    const nextBanner = pickUpload(req, 'banner');
    if (nextBanner) businessProfile.banner = nextBanner;

    // Update fields
    if (name) businessProfile.businessName = name.trim();
    if (description !== undefined) businessProfile.description = description.trim();
    if (mobile) businessProfile.mobileNumber = mobile.trim();
    if (email !== undefined) businessProfile.email = email.trim();
    if (area !== undefined) businessProfile.area = area.trim();
    if (location) businessProfile.location = location.trim();

    applyCompanyDetails(businessProfile, req.body);

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
        businessProfile = await Company.findOne({ userId }).select('+panNumber').sort(NEWEST_FIRST);
    } else {
        // Owner-scoped only. Falling back to "any company with this id", then
        // to the member's newest company, meant an edit could be written to a
        // different record than the one the user opened.
        businessProfile = await Company.findOne({ _id: id, userId }).select('+panNumber');
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
    // Relative paths only - see the note in createBusinessProfile. An image
    // that was not re-sent keeps whatever is stored.
    const nextLogo = pickUpload(req, 'logo');
    if (nextLogo) businessProfile.logo = nextLogo;
    const nextBanner = pickUpload(req, 'banner');
    if (nextBanner) businessProfile.banner = nextBanner;

    // Update fields
    if (name) businessProfile.businessName = name.trim();
    if (description !== undefined) businessProfile.description = description.trim();
    if (mobile) businessProfile.mobileNumber = mobile.trim();
    if (email !== undefined) businessProfile.email = email.trim();
    if (area !== undefined) businessProfile.area = area.trim();
    if (location) businessProfile.location = location.trim();

    applyCompanyDetails(businessProfile, req.body);

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

    /*
     * Region, resolved through the OWNER — a company's own `location` is prose.
     *
     * `location` and `area` are free text the member typed; "Hosur", "hosur
     * sipcot" and "Near Bus Stand, Hosur" are three values for one place, so
     * filtering on them would answer a different question every time. The
     * region tree lives on the member record and is reconciled to one spelling
     * per region by the admin database, which is why the join goes through the
     * owner. See `regionOwners.js`.
     *
     * `null` means no region was asked for. `[]` means nobody is registered in
     * the region that WAS asked for, and must return nothing rather than
     * falling through to a network-wide listing.
     */
    /*
     * PAID OWNERS ONLY, AND NEVER THE VIEWER — `listedOwnerIds`.
     *
     * This listed every company whatever its owner's membership, and used
     * payment only for the star; a business account nobody had paid for
     * appeared in a paying member's grid, in their own region. The region is
     * applied in the same lookup. `[]` means nobody qualifies and must return
     * nothing rather than falling through to a network-wide listing.
     */
    const listedOwners = await listedOwnerIds(req.query, { excludeId: req.user?.userId });
    if (!listedOwners.length) {
        return res.json(ApiResponse.success([], 'Companies fetched successfully'));
    }
    baseFilter.userId = { $in: listedOwners };

    /*
     * An explicit projection, and it stays explicit.
     *
     * This is the one handler that hands a company to somebody who does not own
     * it, so what it selects is a decision rather than a default —
     * `panNumber` is `select: false` for the same reason. `productCategories`
     * is added because industry is exactly what a buyer browsing the directory
     * is looking for; nothing else from the financial or registration sections
     * belongs here.
     */
    /*
     * `userId` joins this company to its owner's member record, which is what
     * decides the star. It is SELECTED but never sent: `stripOwner` takes it
     * off on the way out of every other public handler, and the mapper below
     * turns it into a boolean rather than passing the id along.
     */
    const COMPANY_FIELDS =
        'userId businessName email description businessType productCategories mobileNumber area location logo isActive status createdAt';

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

    /*
     * THE CATALOGUE, THE STARS AND THE TRUST COUNTS — ONE ROUND TRIP.
     *
     * All three take the SAME list of company ids and none of them reads
     * another's result, so there was never a reason for them to be two awaits
     * in a row. Against this cluster a round trip costs 400–500ms whatever it
     * asks for — a bare ping is the same price — so a second `await` on this
     * path was half a second of wall clock spent on nothing.
     *
     * The star: anybody may open a business account, only a PAID member carries
     * the mark. The trust count: how many members keep each company, counted
     * and never listed — who trusts whom is those members' own business. Both
     * are scoped to the companies on THIS page, so the cost follows the page
     * size rather than the size of the network.
     *
     * `isPaidStatus` is the shared test (`active` or `completed`); a second copy
     * of which statuses count as paid is how two screens come to disagree about
     * who is a member.
     */
    const ownerIds = [...new Set(
        (companies || []).map((c) => String(c.userId || '')).filter(Boolean),
    )];

    const [products, paidOwners, trustCounts] = await Promise.all([
        companyIds.length
            ? Product.find({ companyId: { $in: companyIds }, isActive: true })
                .select('name category price stock sku description imageUrl isFeatured companyId')
                .sort({ isFeatured: -1, createdAt: -1 })
                .lean()
            : [],
        ownerIds.length
            ? MemberDetails.find({ userId: { $in: ownerIds } })
                .select('userId membershipStatus')
                .lean()
                .catch(() => [])
            : [],
        companyIds.length
            ? TrustedCompany.aggregate([
                { $match: { companyId: { $in: companyIds } } },
                { $group: { _id: '$companyId', n: { $sum: 1 } } },
            ]).catch(() => [])
            : [],
    ]);

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

    const paidByOwner = new Set(
        (paidOwners || [])
            .filter((m) => isPaidStatus(m.membershipStatus))
            .map((m) => String(m.userId)),
    );
    const trustByCompany = new Map(
        (trustCounts || []).map((row) => [String(row._id), Number(row.n || 0)]),
    );

    const data = (companies || []).map((company) => {
        const catalog = productsByCompany.get(String(company._id)) || [];
        return {
            ...company,
            products: catalog,
            matchedProducts: searchRegex ? catalog.filter(matchesTerm) : [],
            /* The star. `false` where the owner is unknown or unpaid — never
               absent, so a client cannot read “not sent” as “yes”. */
            ownerIsMember: paidByOwner.has(String(company.userId || '')),
            trustedBy: trustByCompany.get(String(company._id)) || 0,
        };
    });

    res.json(
        ApiResponse.success(data, 'Companies fetched successfully')
    );
});

/**
 * A company as ANOTHER MEMBER sees it — the "View as member" page.
 *
 * Not owner-scoped, and that is the point: this is the one read that answers
 * "what does the rest of the network see when they find us?". Every other
 * company read on this controller is deliberately locked to the owner (see the
 * note on `getBusinessProfileById`, which used to fall back to "any company
 * with this id" and leaked every member's contact details).
 *
 * What makes it safe is the PROJECTION, not the caller. `PUBLIC_FIELDS` is a
 * whitelist and has to stay one: `panNumber`, `gstNumber`, `turnoverRange`,
 * `filedITR` and every government registration number are business records the
 * member gave the association, not directory entries, and none of them appears
 * here. `panNumber` is `select: false` on the schema as a second lock, but a
 * schema default is not what is protecting the rest — this list is.
 *
 * A delisted company (`isActive: false`) is served only to its own owner, who
 * needs the page to keep working in order to see what delisting did. To anyone
 * else it is a 404: a listing that cannot be withdrawn is not a listing.
 */
const PUBLIC_FIELDS = [
    'userId',
    'businessName',
    'businessType',
    'description',
    'businessActivities',
    'constitutionType',
    'numberOfEmployees',
    'productCategories',
    'memberOfOtherChamber',
    'otherChamber',
    'mobileNumber',
    'email',
    'area',
    'location',
    'logo',
    'banner',
    /*
     * The BODIES and SCHEMES, but never their numbers.
     *
     * "Registered with MSME / Udyam" and "availed PMEGP" are credentials a
     * company wants a buyer to see — they are the reason it ticked them. The
     * Udyam number, the NSIC number and the RCMC number are not: they identify
     * the registration rather than announce it, and sit beside PAN and GSTIN on
     * the form under "kept private". Listing the bodies without the numbers is
     * the same distinction the form already draws.
     */
    'govtRegistrations',
    'govtSchemes',
    'status',
    'isActive',
    'createdAt'
].join(' ');

/** The same whitelist minus the owner id, for rows handed back in a list. */
const stripOwner = (doc) => {
    if (!doc) return doc;
    const { userId, ...rest } = doc;
    return rest;
};

/**
 * The stored path for one uploaded image, or `undefined` when none was sent.
 *
 * `upload.fields` files arrive as `req.files[field][0]`, where `upload.single`
 * put a single file on `req.file`. `undefined` and not `''` is the point: an
 * ABSENT image means "leave what is there", and a blank string would wipe it.
 */
const pickUpload = (req, field) => {
    const file = req.files && req.files[field] && req.files[field][0];
    return file ? `/uploads/${file.filename}` : undefined;
};

const getPublicCompany = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.userId;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw ApiError.notFound('Company not found');
    }

    const company = await Company.findOne({ _id: id, ...NAMED })
        .select(PUBLIC_FIELDS)
        .lean();

    const isOwner = company && String(company.userId) === String(userId);
    if (!company || (company.isActive === false && !isOwner)) {
        throw ApiError.notFound('Company not found');
    }

    /*
     * The same line Discover draws: another member sees a company only if its
     * owner has paid. Without it the grid would hide an unpaid business and a
     * copied link would still open it. The owner always sees their own page.
     */
    if (!isOwner) {
        const owner = await MemberDetails.findById(company.userId)
            .select('membershipStatus isActive')
            .lean()
            .catch(() => null);
        if (!owner || owner.isActive === false || !isPaidStatus(owner.membershipStatus)) {
            throw ApiError.notFound('Company not found');
        }
    }

    const [products, trustedBy, isTrusted] = await Promise.all([
        Product.find({ companyId: company._id, isActive: true })
            .select('name category price stock sku description imageUrl isFeatured')
            .sort({ isFeatured: -1, createdAt: -1 })
            .lean(),
        TrustedCompany.countDocuments({ companyId: company._id }),
        TrustedCompany.exists({ companyId: company._id, userId })
    ]);

    res.json(ApiResponse.success({
        ...stripOwner(company),
        products: products || [],
        /* Both numbers, because the page asks two different questions: how many
           members keep this company, and whether YOU are one of them. */
        trustedBy,
        isTrusted: Boolean(isTrusted),
        isOwner: Boolean(isOwner)
    }, 'Company fetched successfully'));
});

/* ------------------------------------------------------------------ */
/* TRUST LIST                                                          */
/* ------------------------------------------------------------------ */

/**
 * The member's trust list, newest first.
 *
 * Populated through the SAME whitelist the public page uses. A trust-list row
 * is a company card, and a card carrying more than the directory shows would be
 * a way to read a competitor's GSTIN by trusting them.
 *
 * A company deleted since it was trusted leaves a row whose `companyId`
 * populates to `null`. Those are dropped from the answer rather than rendered
 * as a blank card — and they are not deleted here, because a read must not
 * write.
 */
const getTrustList = asyncHandler(async (req, res) => {
    const rows = await TrustedCompany.find({ userId: req.user.userId })
        .sort({ createdAt: -1 })
        .populate({ path: 'companyId', select: PUBLIC_FIELDS })
        .lean();

    const data = (rows || [])
        .filter((row) => row.companyId)
        .map((row) => ({
            ...stripOwner(row.companyId),
            trustedAt: row.createdAt,
            note: row.note || ''
        }));

    res.json(ApiResponse.success(data, 'Trust list fetched successfully'));
});

/** Just the ids, so the Discover cards can draw their button state. */
const getTrustListIds = asyncHandler(async (req, res) => {
    const rows = await TrustedCompany.find({ userId: req.user.userId })
        .select('companyId')
        .lean();

    res.json(ApiResponse.success(
        (rows || []).map((row) => String(row.companyId)),
        'Trust list fetched successfully'
    ));
});

/**
 * Add a company to the trust list.
 *
 * An upsert, so it is idempotent — a double-click, a retry or a stale button
 * cannot produce a second row, and the unique index would reject that one with
 * an E11000 the member could do nothing about.
 */
const addToTrustList = asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const userId = req.user.userId;

    if (!mongoose.Types.ObjectId.isValid(companyId)) {
        throw ApiError.badRequest('Invalid company id');
    }

    const company = await Company.findOne({ _id: companyId, ...NAMED })
        .select('_id userId')
        .lean();
    if (!company) {
        throw ApiError.notFound('Company not found');
    }
    if (String(company.userId) === String(userId)) {
        throw ApiError.badRequest('This is your own company');
    }

    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);

    await TrustedCompany.updateOne(
        { userId, companyId },
        { $set: { note }, $setOnInsert: { userId, companyId } },
        { upsert: true }
    );

    const trustedBy = await TrustedCompany.countDocuments({ companyId });

    res.json(ApiResponse.success(
        { companyId, isTrusted: true, trustedBy },
        'Added to your trust list'
    ));
});

/** Remove it. Removing what is not there is a success, not a 404. */
const removeFromTrustList = asyncHandler(async (req, res) => {
    const { companyId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(companyId)) {
        throw ApiError.badRequest('Invalid company id');
    }

    await TrustedCompany.deleteOne({ userId: req.user.userId, companyId });
    const trustedBy = await TrustedCompany.countDocuments({ companyId });

    res.json(ApiResponse.success(
        { companyId, isTrusted: false, trustedBy },
        'Removed from your trust list'
    ));
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
    discoverCompanies,
    getPublicCompany,
    getTrustList,
    getTrustListIds,
    addToTrustList,
    removeFromTrustList
};
