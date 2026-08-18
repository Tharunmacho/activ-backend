const Company = require('../members/company.model');
const MemberDetails = require('../members/memberdetails.model');
const Product = require('../../models/Product');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const asyncHandler = require('../../core/utils/asyncHandler');
const mongoose = require('mongoose');

console.log('=== Company Model Check ===');
console.log('Model name:', Company.modelName);
console.log('Collection name:', Company.collection.name);
console.log('Schema paths:', Object.keys(Company.schema.paths));

/**
 * Create a new business profile (stores in companies collection and uploads folder)
 */
const createBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    console.log('Received request body:', req.body);
    console.log('Received file:', req.file);

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

    // Parse businessTypes if it's a JSON string or plain string
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
        finalType = Array.isArray(types) ? (types[0] || 'Manufacturing') : String(types);
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
        console.log('Uploaded company logo saved to disk:', logoUrl);
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

    console.log('Business profile created successfully:', businessProfile);

    res.status(201).json(
        ApiResponse.created(businessProfile, 'Business profile created successfully')
    );
});

/**
 * Get business profile by member ID
 */
const getBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const userMember = await MemberDetails.findById(userId);
    const userEmail = userMember ? userMember.email : null;

    const queryConditions = [
        { userId }
    ];
    if (userEmail) queryConditions.push({ email: userEmail });

    const businessProfile = await Company.findOne({ 
        $or: queryConditions,
        businessName: { $exists: true, $ne: null, $ne: '' }
    }).sort({ createdAt: -1 }).lean();
    
    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    console.log('=== Backend: Business Profile ===');
    console.log('userId:', userId);

    res.json(
        ApiResponse.success(businessProfile, 'Business profile fetched successfully')
    );
});

/**
 * Get all business profiles for a user
 */
const getAllBusinessProfiles = asyncHandler(async (req, res) => {
    const userId = req.user.userId;
    const userMember = await MemberDetails.findById(userId);
    const userEmail = userMember ? userMember.email : null;

    const queryConditions = [
        { userId }
    ];
    if (userEmail) queryConditions.push({ email: userEmail });

    const businessProfiles = await Company.find({ 
        $or: queryConditions,
        businessName: { $exists: true, $ne: null, $ne: '' }
    }).sort({ createdAt: -1 }).lean();

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

    let businessProfile;
    if (id === 'me' || !mongoose.Types.ObjectId.isValid(id)) {
        businessProfile = await Company.findOne({ 
            userId,
            businessName: { $exists: true, $ne: null, $ne: '' }
        }).sort({ createdAt: -1 }).lean();
    } else {
        businessProfile = await Company.findOne({ 
            _id: id,
            userId,
            businessName: { $exists: true, $ne: null, $ne: '' }
        }).lean();
        if (!businessProfile) {
            businessProfile = await Company.findOne({ _id: id }).lean() || await Company.findOne({ userId }).sort({ createdAt: -1 }).lean();
        }
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

    const businessProfile = await Company.findOne({ userId });
    
    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    const name = businessName || organizationName;
    const mobile = mobileNumber || phone;
    const rawType = businessType || businessTypes;

    // Parse businessTypes if it's a JSON string or plain string
    if (rawType) {
        let types = rawType;
        if (typeof rawType === 'string') {
            try {
                types = JSON.parse(rawType);
            } catch (e) {
                types = [rawType];
            }
        }
        businessProfile.businessType = Array.isArray(types) ? (types[0] || businessProfile.businessType) : String(types);
    }

    // Process uploaded logo file saved in local /uploads directory
    if (req.file) {
        // Relative path only - see the note in createBusinessProfile.
        businessProfile.logo = `/uploads/${req.file.filename}`;
        console.log('Updated logo saved to disk:', businessProfile.logo);
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
        businessProfile = await Company.findOne({ userId }).sort({ createdAt: -1 });
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

    // Parse businessTypes if it's a JSON string or plain string
    if (rawType) {
        let types = rawType;
        if (typeof rawType === 'string') {
            try {
                types = JSON.parse(rawType);
            } catch (e) {
                types = [rawType];
            }
        }
        businessProfile.businessType = Array.isArray(types) ? (types[0] || businessProfile.businessType) : String(types);
    }

    // Process uploaded logo file saved in local /uploads directory
    if (req.file) {
        // Relative path only - see the note in createBusinessProfile.
        businessProfile.logo = `/uploads/${req.file.filename}`;
        console.log('Updated logo saved to disk:', businessProfile.logo);
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

    const remaining = await Company.countDocuments({ userId });
    await MemberDetails.findByIdAndUpdate(userId, {
        hasBusinessProfile: remaining > 0
    });

    res.json(
        ApiResponse.success({ _id: id }, 'Business profile deleted successfully')
    );
});

const deleteBusinessProfile = asyncHandler(async (req, res) => {
    const userId = req.user.userId;

    const businessProfile = await Company.findOne({ userId });
    
    if (!businessProfile) {
        throw ApiError.notFound('Business profile not found');
    }

    await businessProfile.deleteOne();
    await Product.deleteMany({ companyId: businessProfile._id });

    // Update member details
    await MemberDetails.findByIdAndUpdate(userId, {
        hasBusinessProfile: false
    });

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
        businessName: { $exists: true, $ne: null, $ne: '' },
        // Members can delist a company from the directory; `$ne: false` keeps
        // legacy rows that predate the flag visible.
        isActive: { $ne: false }
    };

    let companyFilter = baseFilter;
    let searchRegex = null;

    if (term) {
        searchRegex = new RegExp(escapeRegex(term), 'i');

        // Companies whose catalog contains a matching product
        const matchedProducts = await Product.find({
            isActive: true,
            $or: [
                { name: searchRegex },
                { category: searchRegex },
                { sku: searchRegex }
            ]
        }).select('companyId').lean();

        const companyIdsFromProducts = (matchedProducts || [])
            .map((p) => p.companyId)
            .filter(Boolean);

        // Match the company's own identity only. `description` / `location` /
        // `area` are prose fields - including them made a short term match
        // nearly every row, so the search read as "shows everything".
        companyFilter = {
            ...baseFilter,
            $or: [
                { businessName: searchRegex },
                { businessType: searchRegex },
                { _id: { $in: companyIdsFromProducts } }
            ]
        };
    }

    const companies = await Company.find(companyFilter)
        .select('businessName email description businessType mobileNumber area location logo isActive status createdAt')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

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
