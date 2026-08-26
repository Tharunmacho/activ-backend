const memberService = require('./member.service');
const MemberDetails = require('./memberdetails.model');
const PersonalInfo1 = require('./personalinfo1.model');
const BusinessInfo = require('./businessinfo.model');
const MemberFinancialInfo = require('./memberfinancialinfo.model');
const MemberDeclaration = require('./memberdeclaration.model');
const MemberAuth = require('../auth/auth.model');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const bcrypt = require('bcrypt');

const updateMember = asyncHandler(async(req, res) => {
    const { password, confirmPassword, currentPassword, email, ...profileData } = req.body;
    
    // Get member from "web users" collection
    const member = await MemberDetails.findById(req.user.userId);
    
    if (!member) {
        return res.status(404).json(ApiResponse.error('Member not found', 404));
    }
    
    // Store original email before any updates (needed for finding auth record)
    const originalEmail = member.email;
    
    // Handle password update if new password is provided
    if (password && password.trim() && confirmPassword && confirmPassword.trim()) {
        // Get member auth record from "web auth" collection using ORIGINAL email
        const memberAuth = await MemberAuth.findOne({ email: originalEmail }).select('+password');
        
        if (!memberAuth) {
            return res.status(404).json(ApiResponse.error('Authentication record not found', 404));
        }
        
        // Verify current password ONLY if user already has a password set
        if (memberAuth.password) {
            // User already has a password, so current password is required
            if (!currentPassword || !currentPassword.trim()) {
                return res.status(400).json(ApiResponse.error('Current password is required to change password', 400));
            }
            
            const isPasswordValid = await memberAuth.comparePassword(currentPassword);
            if (!isPasswordValid) {
                return res.status(400).json(ApiResponse.error('Current password is incorrect', 400));
            }
        }
        
        if (password !== confirmPassword) {
            return res.status(400).json(ApiResponse.error('Passwords do not match', 400));
        }
        
        if (password.length < 6) {
            return res.status(400).json(ApiResponse.error('Password must be at least 6 characters', 400));
        }
        
        // Update password in "web auth" collection (used for login)
        memberAuth.password = password; // The model will hash it automatically
        await memberAuth.save();
    }
    
    // Handle email update if provided and different
    if (email && email.trim() && email.toLowerCase() !== originalEmail.toLowerCase()) {
        const normalizedEmail = email.toLowerCase();
        
        // Check if new email is already taken by another user
        const existingMember = await MemberDetails.findOne({ 
            email: normalizedEmail,
            _id: { $ne: req.user.userId }
        });
        
        if (existingMember) {
            return res.status(400).json(ApiResponse.error('Email already in use', 400));
        }
        
        // Update email in "web users" collection
        member.email = normalizedEmail;
        await member.save();
        
        // Update email in "web auth" collection using ORIGINAL email to find it
        const memberAuth = await MemberAuth.findOne({ email: originalEmail });
        if (memberAuth) {
            memberAuth.email = normalizedEmail;
            await memberAuth.save();
        }
    }
    
    // Save personal details to PersonalInfo1 collection (excluding email and password)
    let personalInfo = await PersonalInfo1.findOne({ userId: req.user.userId });
    
    /**
     * Fall back to the member's own record when this request carries no personal
     * fields.
     *
     * `PersonalInfo1` requires name, phoneNumber, state, district and block. This
     * block ran on EVERY profile update, including one that only carries
     * financial or declaration answers — so a member with no PersonalInfo1 row
     * yet submitting Form 3 or Form 4 got:
     *
     *   400  Path `name` is required. Path `phoneNumber` is required.
     *        Path `state` is required. ...
     *
     * on a form that asks for none of those, and their financial or declaration
     * answers were never written, because the throw happened before those blocks
     * ran. The happy path hid it: Form 1 normally runs first and creates the
     * record, after which the `|| personalInfo.name` fallbacks below carry it.
     *
     * `member` is the canonical row in "web users" and carries all five fields as
     * required values, so seeding from it is both safe and correct.
     */
    const personalFallback = {
        name: member.fullName,
        phoneNumber: member.phoneNumber,
        state: member.state,
        district: member.district,
        block: member.block,
        city: member.city,
        religion: member.religion,
        socialCategory: member.socialCategory,
    };

    if (personalInfo) {
        // Update existing record
        Object.assign(personalInfo, {
            name: profileData.fullName || personalInfo.name,
            phoneNumber: profileData.phoneNumber || personalInfo.phoneNumber,
            state: profileData.state || personalInfo.state,
            district: profileData.district || personalInfo.district,
            block: profileData.block || personalInfo.block,
            city: profileData.city || personalInfo.city,
            religion: profileData.religion || personalInfo.religion,
            socialCategory: profileData.socialCategory || personalInfo.socialCategory,
            isLocked: true, // Lock the form after save
            updatedAt: new Date()
        });
    } else {
        // Create new record, seeding anything this request did not carry from
        // the member's own row rather than letting a required path go missing.
        personalInfo = new PersonalInfo1({
            userId: req.user.userId,
            name: profileData.fullName || personalFallback.name,
            phoneNumber: profileData.phoneNumber || personalFallback.phoneNumber,
            state: profileData.state || personalFallback.state,
            district: profileData.district || personalFallback.district,
            block: profileData.block || personalFallback.block,
            city: profileData.city || personalFallback.city,
            religion: profileData.religion || personalFallback.religion,
            socialCategory: profileData.socialCategory || personalFallback.socialCategory,
            isLocked: true // Lock the form after first save
        });
    }
    
    await personalInfo.save();

    // Mirror the personal details onto the member's own record in "web users".
    // Previously only PersonalInfo1 was written, so a member could complete the
    // whole profile form and their canonical record would still hold the values
    // captured at registration — which is what the admin dashboards, the
    // geofenced block/district/state queries and getMyProfile all read.
    // `socialCategory` is enum-constrained on this model; an unrecognised value
    // would throw on save and turn a profile update into a 500.
    const SOCIAL_CATEGORIES = ['Christian ST', 'Christian SC', 'ST', 'SC', 'Others', ''];
    const safeSocialCategory = SOCIAL_CATEGORIES.includes(profileData.socialCategory)
        ? profileData.socialCategory
        : undefined;

    const coreUpdates = {
        fullName: profileData.fullName,
        phoneNumber: profileData.phoneNumber,
        state: profileData.state,
        district: profileData.district,
        block: profileData.block,
        city: profileData.city,
        religion: profileData.religion,
        socialCategory: safeSocialCategory,
        profilePhoto: profileData.profilePhoto
    };

    let coreChanged = false;
    Object.entries(coreUpdates).forEach(([key, value]) => {
        // Only overwrite with a real value — never blank out existing data.
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            member[key] = value;
            coreChanged = true;
        }
    });

    if (coreChanged) {
        member.profileCompleted = true;
        await member.save();
    }

    // Dynamically sync updated profile details & email to Application collection in MongoDB
    try {
        const Application = require('../applications/application.model');
        const searchEmail = (member.email || originalEmail || '').toLowerCase();
        await Application.updateMany(
            { $or: [{ userId: req.user.userId }, { email: searchEmail }, { email: (originalEmail || '').toLowerCase() }] },
            {
                $set: {
                    ...(profileData.fullName ? { fullName: profileData.fullName } : {}),
                    ...(member.email ? { email: member.email } : {}),
                    ...(profileData.phoneNumber ? { phone: profileData.phoneNumber } : {}),
                    ...(profileData.block ? { block: profileData.block } : {}),
                    ...(profileData.district ? { district: profileData.district } : {}),
                    ...(profileData.state ? { state: profileData.state } : {}),
                    'data.personalDetails.fullName': profileData.fullName || member.fullName,
                    'data.personalDetails.email': member.email || searchEmail,
                    'data.personalDetails.phone': profileData.phoneNumber || member.phoneNumber,
                    'data.personalDetails.phoneNumber': profileData.phoneNumber || member.phoneNumber,
                    'data.personalDetails.block': profileData.block || member.block,
                    'data.personalDetails.district': profileData.district || member.district,
                    'data.personalDetails.state': profileData.state || member.state,
                    'data.personalDetails.city': profileData.city || member.city,
                    'data.personalDetails.religion': profileData.religion || member.religion,
                    'data.personalDetails.socialCategory': profileData.socialCategory || member.socialCategory
                }
            }
        );
    } catch (syncErr) {
        console.error('Error syncing member updates to Application collection:', syncErr);
    }

    /**
     * One answer, not two.
     *
     * `registrationType` was derived as `doingBusiness ? 'business' : 'aspirant'`
     * straight off the request body. A client sending the string `"no"` — which
     * is truthy in JavaScript — produced a document Mongoose cast to
     * `doingBusiness: false` while the ternary wrote
     * `registrationType: 'business'`. The record then disagreed with itself, and
     * which half a screen believed decided whether an aspirant was treated as
     * one.
     *
     * Normalising here means no client can produce that document, whatever it
     * sends. Real Booleans — what the mobile app sends — pass through unchanged.
     */
    const asBool = (value) => {
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 'yes' || value === 1 || value === '1') return true;
        if (value === 'false' || value === 'no' || value === 0 || value === '0') return false;
        return undefined;   // `''` and anything else: not an answer
    };

    const doesBusiness = asBool(profileData.doingBusiness);
    if (doesBusiness !== undefined) profileData.doingBusiness = doesBusiness;

    const inOtherChamber = asBool(profileData.memberOfOtherChamber);
    if (inOtherChamber !== undefined) profileData.memberOfOtherChamber = inOtherChamber;
    else delete profileData.memberOfOtherChamber;

    /**
     * `itrFiled` is the same answer as `filedITR`, not a second one.
     *
     * The mobile financial screen sends both — `filedITR: itrFiled` and then
     * `itrFiled` again under "legacy keys" — from one variable, so they can
     * never disagree at the source. It is read here as a fallback so a client
     * sending only the old key still saves, but it is deliberately NOT given a
     * schema field of its own: two stored copies of one answer is the shape that
     * produced the `doingBusiness` / `registrationType` bug documented above,
     * where a document disagreed with itself and which half a screen read
     * decided how the member was treated. One question, one column.
     *
     * An unanswered Boolean reached Mongoose as `''`, which has no cast and
     * failed the whole save with a 500 no client could act on. Dropping it
     * leaves the stored value alone, which is what "unanswered" means.
     */
    const filedItr = asBool(profileData.filedITR ?? profileData.itrFiled);
    if (filedItr !== undefined) profileData.filedITR = filedItr;
    else delete profileData.filedITR;

    /**
     * Same again for `lastYearTurnover`, mobile's legacy name for
     * `turnoverRange`. It too is sent from the same variable as the canonical
     * key, so accepting it costs nothing and closes the case where only the old
     * name arrives.
     */
    if (profileData.turnoverRange === undefined && profileData.lastYearTurnover) {
        profileData.turnoverRange = profileData.lastYearTurnover;
    }

    const gotScheme = asBool(profileData.govtSchemeBenefit);
    if (gotScheme !== undefined) profileData.govtSchemeBenefit = gotScheme;
    else delete profileData.govtSchemeBenefit;

    // `turnoverRange` is an enum; the empty string is not a member of it.
    if (profileData.turnoverRange === '') delete profileData.turnoverRange;

    // Save business information to BusinessInfo collection if provided
    if (doesBusiness !== undefined) {
        let businessInfo = await BusinessInfo.findOne({ userId: req.user.userId });
        
        if (businessInfo) {
            // Update existing business record
            Object.assign(businessInfo, {
                doingBusiness: profileData.doingBusiness,
                registrationType: doesBusiness ? 'business' : 'aspirant',
                organizationName: profileData.organizationName || businessInfo.organizationName,
                constitutionType: profileData.constitutionType || businessInfo.constitutionType,
                businessTypes: profileData.businessTypes || businessInfo.businessTypes,
                businessActivities: profileData.businessActivities || businessInfo.businessActivities,
                businessCommencementYear: profileData.businessCommencementYear || businessInfo.businessCommencementYear,
                numberOfEmployees: profileData.numberOfEmployees || businessInfo.numberOfEmployees,
                memberOfOtherChamber: profileData.memberOfOtherChamber !== undefined ? profileData.memberOfOtherChamber : businessInfo.memberOfOtherChamber,
                otherChamber: profileData.otherChamber || businessInfo.otherChamber,
                govtOrganizations: profileData.govtOrganizations || businessInfo.govtOrganizations,
                isLocked: true,
                submittedAt: profileData.submittedAt || businessInfo.submittedAt,
                updatedAt: new Date()
            });
        } else {
            // Create new business record
            businessInfo = new BusinessInfo({
                userId: req.user.userId,
                doingBusiness: profileData.doingBusiness,
                registrationType: doesBusiness ? 'business' : 'aspirant',
                organizationName: profileData.organizationName,
                constitutionType: profileData.constitutionType,
                businessTypes: profileData.businessTypes,
                businessActivities: profileData.businessActivities,
                businessCommencementYear: profileData.businessCommencementYear,
                numberOfEmployees: profileData.numberOfEmployees,
                memberOfOtherChamber: profileData.memberOfOtherChamber,
                otherChamber: profileData.otherChamber,
                govtOrganizations: profileData.govtOrganizations,
                isLocked: true,
                submittedAt: profileData.submittedAt
            });
        }
        
        await businessInfo.save();
    }
    
    // Save financial information to MemberFinancialInfo collection if provided
    if (profileData.panNumber !== undefined || profileData.gstNumber !== undefined ||
        profileData.udyamNumber !== undefined || profileData.filedITR !== undefined ||
        profileData.turnoverRange !== undefined || profileData.govtSchemeBenefit !== undefined ||
        profileData.govtSchemes !== undefined || profileData.schemeDetails !== undefined) {
        
        // `+panNumber` so `profileData.panNumber || financialInfo.panNumber`
        // below can actually fall back to the stored value. Without it the
        // fallback was always undefined and saving the form without retyping
        // the PAN erased it.
        let financialInfo = await MemberFinancialInfo.findOne({ memberId: req.user.userId })
            .select('+panNumber');
        
        if (financialInfo) {
            // Update existing financial record
            Object.assign(financialInfo, {
                panNumber: profileData.panNumber || financialInfo.panNumber,
                gstNumber: profileData.gstNumber || financialInfo.gstNumber,
                udyamNumber: profileData.udyamNumber || financialInfo.udyamNumber,
                filedITR: profileData.filedITR !== undefined ? profileData.filedITR : financialInfo.filedITR,
                turnoverRange: profileData.turnoverRange || financialInfo.turnoverRange,
                govtSchemeBenefit: profileData.govtSchemeBenefit !== undefined ? profileData.govtSchemeBenefit : financialInfo.govtSchemeBenefit,
                /**
                 * An explicit empty array is a real answer — the member cleared
                 * their selection — so this checks for `undefined` rather than
                 * falling back on emptiness. `|| financialInfo.govtSchemes`
                 * would make deselecting every scheme impossible.
                 */
                govtSchemes: Array.isArray(profileData.govtSchemes)
                    ? profileData.govtSchemes
                    : financialInfo.govtSchemes,
                schemeDetails: profileData.schemeDetails !== undefined
                    ? profileData.schemeDetails
                    : financialInfo.schemeDetails,
                status: 'submitted',
                updatedAt: new Date()
            });
        } else {
            // Create new financial record
            financialInfo = new MemberFinancialInfo({
                memberId: req.user.userId,
                panNumber: profileData.panNumber,
                gstNumber: profileData.gstNumber,
                udyamNumber: profileData.udyamNumber,
                filedITR: profileData.filedITR,
                turnoverRange: profileData.turnoverRange,
                govtSchemeBenefit: profileData.govtSchemeBenefit,
                govtSchemes: Array.isArray(profileData.govtSchemes) ? profileData.govtSchemes : [],
                schemeDetails: profileData.schemeDetails || '',
                status: 'submitted'
            });
        }
        
        await financialInfo.save();
    }
    
    // Save declaration information to MemberDeclaration collection if provided
    if (profileData.sisterConcerns !== undefined || profileData.companyNames !== undefined || 
        profileData.agreeToDeclaration !== undefined || profileData.agreeToTerms !== undefined) {
        
        // Match on either key: rows written before the schema was aligned carry
        // only `memberId`, while the collection's unique index is on `userId`.
        let declarationInfo = await MemberDeclaration.findOne({
            $or: [{ userId: req.user.userId }, { memberId: req.user.userId }]
        });

        // Convert sisterConcerns to number
        const sisterConcernsNumber = profileData.sisterConcerns ? 
            (typeof profileData.sisterConcerns === 'string' ? parseInt(profileData.sisterConcerns) || 0 : profileData.sisterConcerns) : 
            0;
        
        // Convert companyNames string to array if needed
        const companyNamesArray = profileData.companyNames ? 
            (typeof profileData.companyNames === 'string' ? 
                profileData.companyNames.split(',').map(c => c.trim()).filter(c => c) : 
                profileData.companyNames) : 
            [];
        
        // Handle both agreeToDeclaration and agreeToTerms (frontend uses agreeToTerms)
        const agreed = profileData.agreeToDeclaration || profileData.agreeToTerms || false;
        
        if (declarationInfo) {
            // Update existing declaration record
            Object.assign(declarationInfo, {
                userId: declarationInfo.userId || req.user.userId,
                memberId: declarationInfo.memberId || req.user.userId,
                sisterConcerns: sisterConcernsNumber,
                companyNames: companyNamesArray,
                agreeToDeclaration: agreed,
                status: 'pending',
                updatedAt: new Date()
            });
        } else {
            // Create new declaration record
            declarationInfo = new MemberDeclaration({
                userId: req.user.userId,
                memberId: req.user.userId,
                sisterConcerns: sisterConcernsNumber,
                companyNames: companyNamesArray,
                agreeToDeclaration: agreed,
                status: 'pending'
            });
        }
        
        await declarationInfo.save();
    }
    
    // Return combined data from both collections
    const responseData = {
        fullName: personalInfo.name,
        phoneNumber: personalInfo.phoneNumber,
        state: personalInfo.state,
        district: personalInfo.district,
        block: personalInfo.block,
        city: personalInfo.city,
        religion: personalInfo.religion,
        socialCategory: personalInfo.socialCategory,
        email: member.email,
        isLocked: personalInfo.isLocked
    };
    
    res.json(ApiResponse.success(responseData, 'Profile updated successfully'));
});

const getMyProfile = asyncHandler(async(req, res) => {
    // Get personal details from PersonalInfo1 collection
    const personalInfo = await PersonalInfo1.findOne({ userId: req.user.userId });
    
    // Get member from web users collection
    const member = await MemberDetails.findById(req.user.userId).select('-password');
    
    if (!member) {
        return res.status(404).json(ApiResponse.error('Profile not found', 404));
    }
    
    // If PersonalInfo1 has data, use it; otherwise fallback to web users data
    const profileData = personalInfo ? {
        fullName: personalInfo.name,
        phoneNumber: personalInfo.phoneNumber,
        state: personalInfo.state,
        district: personalInfo.district,
        block: personalInfo.block,
        city: personalInfo.city,
        religion: personalInfo.religion,
        socialCategory: personalInfo.socialCategory,
        email: member.email,
        profilePhoto: member.profilePhoto || null,
        membershipStatus: member.membershipStatus || 'pending',
        membershipType: member.membershipType || 'none',
        approvedAt: member.approvedAt || member.membershipActivatedAt || null,
        /*
         * Membership identity, for the paid dashboard.
         *
         * `membershipActivatedAt` is when `/payment/complete` activated the
         * account, and is what "Member since" means. The mobile paid dashboard
         * prints a hardcoded "January 15, 2020" for everyone because this was
         * not returned anywhere.
         *
         * `membershipNumber` is derived by the SAME expression
         * `memberExtras.getCertificate` uses, so the number on the dashboard
         * and the number on the certificate cannot differ. It is stable for a
         * given member — mobile generates its Member ID with `Math.random()`
         * and mints a different one on every screen load.
         */
        memberId: String(member._id),
        membershipNumber: member.membershipNumber || String(member._id).slice(-8).toUpperCase(),
        membershipActivatedAt: member.membershipActivatedAt || null,
        isLocked: personalInfo.isLocked || false
    } : {
        fullName: member.fullName,
        phoneNumber: member.phoneNumber,
        state: member.state,
        district: member.district,
        block: member.block,
        city: member.city,
        religion: member.religion,
        socialCategory: member.socialCategory,
        email: member.email,
        profilePhoto: member.profilePhoto || null,
        membershipStatus: member.membershipStatus || 'pending',
        membershipType: member.membershipType || 'none',
        approvedAt: member.approvedAt || member.membershipActivatedAt || null,
        /*
         * Membership identity, for the paid dashboard.
         *
         * `membershipActivatedAt` is when `/payment/complete` activated the
         * account, and is what "Member since" means. The mobile paid dashboard
         * prints a hardcoded "January 15, 2020" for everyone because this was
         * not returned anywhere.
         *
         * `membershipNumber` is derived by the SAME expression
         * `memberExtras.getCertificate` uses, so the number on the dashboard
         * and the number on the certificate cannot differ. It is stable for a
         * given member — mobile generates its Member ID with `Math.random()`
         * and mints a different one on every screen load.
         */
        memberId: String(member._id),
        membershipNumber: member.membershipNumber || String(member._id).slice(-8).toUpperCase(),
        membershipActivatedAt: member.membershipActivatedAt || null,
        isLocked: false
    };
    
    // Disable caching to ensure fresh data
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(ApiResponse.success(profileData));
});

const getBusinessInfo = asyncHandler(async(req, res) => {
    // Get business info from BusinessInfo collection
    const businessInfo = await BusinessInfo.findOne({ userId: req.user.userId });
    
    // Get member from web users collection
    const member = await MemberDetails.findById(req.user.userId);
    
    if (!member) {
        return res.status(404).json(ApiResponse.error('Profile not found', 404));
    }
    
    // Return business info or empty object if not found
    const businessData = businessInfo ? {
        doingBusiness: businessInfo.doingBusiness,
        registrationType: businessInfo.registrationType,
        organizationName: businessInfo.organizationName,
        constitutionType: businessInfo.constitutionType,
        businessTypes: businessInfo.businessTypes,
        businessActivities: businessInfo.businessActivities,
        businessCommencementYear: businessInfo.businessCommencementYear,
        numberOfEmployees: businessInfo.numberOfEmployees,
        memberOfOtherChamber: businessInfo.memberOfOtherChamber,
        otherChamber: businessInfo.otherChamber,
        govtOrganizations: businessInfo.govtOrganizations,
        isLocked: businessInfo.isLocked || false,
        submittedAt: businessInfo.submittedAt
    } : {
        doingBusiness: null,
        registrationType: 'aspirant',
        organizationName: '',
        constitutionType: '',
        businessTypes: [],
        businessActivities: '',
        businessCommencementYear: '',
        numberOfEmployees: '',
        memberOfOtherChamber: null,
        otherChamber: '',
        govtOrganizations: [],
        isLocked: false
    };
    
    // Disable caching
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(ApiResponse.success(businessData));
});

const getFinancialInfo = asyncHandler(async(req, res) => {
    // Get financial info from MemberFinancialInfo collection
    // `+panNumber` because the field is `select: false` in the schema and this
    // response is meant to carry it.
    const financialInfo = await MemberFinancialInfo.findOne({ memberId: req.user.userId })
        .select('+panNumber');
    
    // Get member from web users collection
    const member = await MemberDetails.findById(req.user.userId);
    
    if (!member) {
        return res.status(404).json(ApiResponse.error('Profile not found', 404));
    }
    
    // Return financial info or empty object if not found
    const financialData = financialInfo ? {
        panNumber: financialInfo.panNumber,
        gstNumber: financialInfo.gstNumber,
        udyamNumber: financialInfo.udyamNumber,
        filedITR: financialInfo.filedITR,
        turnoverRange: financialInfo.turnoverRange,
        govtSchemeBenefit: financialInfo.govtSchemeBenefit,
        // Storing these is only half the job: a field the read path omits comes
        // back blank, and the member sees an empty form after a successful save
        // exactly as they did when it was being dropped.
        govtSchemes: financialInfo.govtSchemes || [],
        schemeDetails: financialInfo.schemeDetails || '',
        status: financialInfo.status
    } : {
        panNumber: '',
        gstNumber: '',
        udyamNumber: '',
        filedITR: false,
        turnoverRange: '',
        govtSchemeBenefit: false,
        govtSchemes: [],
        schemeDetails: '',
        status: 'draft'
    };
    
    // Disable caching
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(ApiResponse.success(financialData));
});

const getDeclarationInfo = asyncHandler(async(req, res) => {
    // Get declaration info from MemberDeclaration collection
    const declarationInfo = await MemberDeclaration.findOne({
        $or: [{ userId: req.user.userId }, { memberId: req.user.userId }]
    });
    
    // Get member from web users collection
    const member = await MemberDetails.findById(req.user.userId);
    
    if (!member) {
        return res.status(404).json(ApiResponse.error('Profile not found', 404));
    }
    
    // Return declaration info or empty object if not found
    const declarationData = declarationInfo ? {
        sisterConcerns: declarationInfo.sisterConcerns,
        companyNames: declarationInfo.companyNames,
        agreeToDeclaration: declarationInfo.agreeToDeclaration,
        status: declarationInfo.status,
        reviewNotes: declarationInfo.reviewNotes,
        reviewedAt: declarationInfo.reviewedAt
    } : {
        sisterConcerns: 0,
        companyNames: [],
        agreeToDeclaration: false,
        status: 'pending',
        reviewNotes: '',
        reviewedAt: null
    };
    
    // Disable caching
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(ApiResponse.success(declarationData));
});

const getMembers = asyncHandler(async(req, res) => {
    const { page = 1, limit = 20, ...filter } = req.query;
    const result = await memberService.getMembers(filter, parseInt(page), parseInt(limit));
    res.json(ApiResponse.success(result));
});

const uploadProfilePhoto = asyncHandler(async (req, res) => {
    // The route uses `upload.any()`, so the file arrives on `req.files`
    // whatever the client named the field — the mobile app sends `photo`, the
    // web form sends `profilePhoto`. `req.file` is still honoured in case a
    // caller is routed through a `single()` upload elsewhere.
    const uploaded = req.file || (Array.isArray(req.files) ? req.files[0] : null);

    if (!uploaded) {
        return res.status(400).json(ApiResponse.error('No image file uploaded', 400));
    }

    // Relative path only — an absolute URL built from the request host points at
    // whatever network the uploading device was on and 404s everywhere else.
    const profilePhotoUrl = `/uploads/${uploaded.filename}`;

    const member = await MemberDetails.findById(req.user.userId);
    if (!member) {
        return res.status(404).json(ApiResponse.error('Member not found', 404));
    }

    // Update the profile photo
    member.profilePhoto = profilePhotoUrl;
    await member.save();

    // Also try to update the application collection just in case
    try {
        const Application = require('../applications/application.model');
        await Application.updateMany(
            { userId: req.user.userId },
            { $set: { 'data.personalDetails.profilePhoto': profilePhotoUrl, profilePhoto: profilePhotoUrl } }
        );
    } catch (err) {
        console.error('Error syncing photo to application:', err);
    }

    res.json(ApiResponse.success({ profilePhoto: profilePhotoUrl }, 'Profile photo uploaded successfully'));
});

module.exports = { updateMember, getMyProfile, getBusinessInfo, getFinancialInfo, getDeclarationInfo, getMembers, uploadProfilePhoto };