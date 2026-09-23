const memberService = require('./member.service');
/* ONE expression for the membership number, for the reason the model's
   own comment gives: four copies of it is how the dashboard and the
   certificate came to print different numbers for the same member. */
const { membershipNumberFor } = require('./memberNumber');
const MemberDetails = require('./memberdetails.model');
const PersonalInfo1 = require('./personalinfo1.model');
const BusinessInfo = require('./businessinfo.model');
const MemberFinancialInfo = require('./memberfinancialinfo.model');
const MemberDeclaration = require('./memberdeclaration.model');
const MemberAuth = require('../auth/auth.model');
const ApiResponse = require('../../core/utils/ApiResponse');
const { invalidateMemberContext } = require('../common/memberContext');
const asyncHandler = require('../../core/utils/asyncHandler');
const bcrypt = require('bcrypt');
const { internationalFromPhone, validateMobile } = require('../common/phoneNumber');
const { ALL_SOCIAL_CATEGORIES, GENDERS } = require('./demographicOptions');

/**
 * The short names every client actually sends, mapped to the schema's names.
 *
 * This is the single biggest source of silent data loss on this endpoint, and
 * it fails in the worst possible way: the request answers 200, the client shows
 * "saved successfully", and Mongoose strict mode has dropped the field on the
 * floor. The member then opens their profile and the answer they typed is gone,
 * with nothing anywhere reporting an error.
 *
 * Measured against the live clients, EVERY ONE of these was being lost:
 *
 *   web "Complete your profile" wizard  organization, constitution, businessYear,
 *                                       employees, chamber, chamberDetails,
 *                                       govtOrgs, pan, gst, udyam, scheme1..3
 *   web Settings                        the same set again
 *   mobile                              lastYearTurnover, itrFiled
 *
 * The alternative fix — correcting each client to send canonical names — was
 * done too, but it cannot be the only fix. There are three clients and any
 * future one will guess the short name just as readily; a released mobile build
 * cannot be corrected retroactively at all. Normalising here is the only place
 * that covers all of them, and it is cheap: a rename before anything reads the
 * body.
 *
 * Canonical always wins. A client sending both `panNumber` and `pan` means the
 * first, and an alias must never overwrite a value the caller stated properly.
 */
const FIELD_ALIASES = {
    // business
    organizationName: ['organization', 'organisationName', 'organisation'],
    constitutionType: ['constitution'],
    businessCommencementYear: ['businessYear', 'commencementYear'],
    numberOfEmployees: ['employees', 'employeeCount'],
    memberOfOtherChamber: ['chamber'],
    otherChamber: ['chamberDetails', 'otherChamberName'],
    govtOrganizations: ['govtOrgs'],
    // financial
    panNumber: ['pan'],
    gstNumber: ['gst'],
    udyamNumber: ['udyam'],
    turnoverRange: ['lastYearTurnover'],
    filedITR: ['itrFiled'],
    // declaration
    agreeToDeclaration: ['agreeToTerms', 'declarationAccepted']
};

/**
 * Apply the table above, in place, and fold the scheme fields together.
 *
 * `scheme1`, `scheme2` and `scheme3` are three inputs behind one schema field:
 * the wizard asks "which other schemes?" as three boxes and the model stores
 * one free-text line. They are joined rather than aliased because none of them
 * is `schemeDetails` on its own, and taking only the first would lose the other
 * two just as silently as dropping all three did.
 */
const normalizeProfileAliases = (data) => {
    Object.entries(FIELD_ALIASES).forEach(([canonical, aliases]) => {
        if (data[canonical] !== undefined && data[canonical] !== '') return;

        const alias = aliases.find((name) => data[name] !== undefined && data[name] !== '');
        if (alias !== undefined) data[canonical] = data[alias];
    });

    if (data.schemeDetails === undefined) {
        const joined = [data.scheme1, data.scheme2, data.scheme3]
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .join(', ');

        if (joined) data.schemeDetails = joined;
    }

    return data;
};

const updateMember = asyncHandler(async(req, res) => {
    const { password, confirmPassword, currentPassword, email, ...rawProfileData } = req.body;

    // Before anything reads the body: see `FIELD_ALIASES` above.
    const profileData = normalizeProfileAliases(rawProfileData);
    
    /*
     * THE TWO READS GO OUT TOGETHER.
     *
     * Measured against the live cluster, every round trip from this app
     * server costs ~65 ms, and this handler was making six or seven of them
     * strictly one after another — which is most of the "saving is slow" a
     * member feels, before a single document has been written.
     *
     * `MemberDetails` and `PersonalInfo1` are read by id and by `userId`;
     * neither read depends on the other, so they are issued at once. The
     * `BusinessInfo` read further down stays where it is: it runs only when
     * the request carries business answers, and starting it eagerly would
     * add a round trip to every save that does not.
     *
     *   scripts/time-profile-update.js prints the timings this is based on.
     */
    const [member, existingPersonalInfo] = await Promise.all([
        MemberDetails.findById(req.user.userId),
        PersonalInfo1.findOne({ userId: req.user.userId }),
    ]);
    
    if (!member) {
        return res.status(404).json(ApiResponse.error('Member not found', 404));
    }

    /*
     * A MEMBER OUTSIDE INDIA has no state, district or block — whatever a
     * client sends for them is dropped here, before any write reads it — and
     * gives a free-text place instead. The flag comes from the stored record
     * or the stored number, never from this request.
     */
    const abroad = member.isInternational === true
        ? { international: true, country: member.country || '' }
        : internationalFromPhone(member.phoneNumber);
    if (abroad.international) {
        delete profileData.state;
        delete profileData.district;
        delete profileData.block;
        const place = String(profileData.place || profileData.city || '').trim().slice(0, 200);
        if (place) {
            profileData.place = place;
            profileData.city = place;
        }
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
    
    /*
     * The two enum-constrained demographic fields, checked before anything is
     * written.
     *
     * Both `PersonalInfo1` and `MemberDetails` constrain them, and a value
     * outside the enum does not come back as "that is not a choice" — it throws
     * inside `.save()` and turns a profile update into a 500 with a Mongoose
     * sentence for a message. `undefined` means "not a usable answer", and
     * every assignment below reads it as "leave the stored value alone" rather
     * than as "blank it".
     *
     * Declared here because the PersonalInfo1 block immediately below is the
     * first thing that writes them.
     */
    const safeSocialCategory = ALL_SOCIAL_CATEGORIES.includes(profileData.socialCategory)
        ? profileData.socialCategory
        : undefined;
    const safeGender = GENDERS.includes(profileData.gender)
        ? profileData.gender
        : undefined;

    // Read at the top of the handler, alongside the member — see the note there.
    let personalInfo = existingPersonalInfo;
    
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
        gender: member.gender,
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
            isInternational: abroad.international,
            place: abroad.international ? (profileData.place || personalInfo.place || member.place || '') : '',
            religion: profileData.religion || personalInfo.religion,
            socialCategory: profileData.socialCategory || personalInfo.socialCategory,
            gender: safeGender !== undefined ? safeGender : personalInfo.gender,
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
            isInternational: abroad.international,
            place: abroad.international ? (profileData.place || member.place || '') : '',
            religion: profileData.religion || personalFallback.religion,
            socialCategory: profileData.socialCategory || personalFallback.socialCategory,
            gender: safeGender !== undefined ? safeGender : personalFallback.gender,
            isLocked: true // Lock the form after first save
        });
    }
    
    await personalInfo.save();

    // Mirror the personal details onto the member's own record in "web users".
    // Previously only PersonalInfo1 was written, so a member could complete the
    // whole profile form and their canonical record would still hold the values
    // captured at registration — which is what the admin dashboards, the
    // geofenced block/district/state queries and getMyProfile all read.
    // `socialCategory` and `gender` were whitelisted above, before the first
    // write that uses them.

    /*
     * Both numbers are normalised on the way in, exactly as registration does.
     *
     * Without this a member who edits their profile and types `+91 98765 43210`
     * overwrites the ten-digit value registration stored with a spaced one, and
     * every lookup keyed on the number stops finding them. `undefined` for an
     * unusable value so the loop below leaves the existing number alone rather
     * than replacing a good number with a blank.
     */
    const normalisedPhone = validateMobile(profileData.phoneNumber);
    const normalisedWhatsapp = validateMobile(profileData.whatsappNumber);

    const coreUpdates = {
        fullName: profileData.fullName,
        phoneNumber: normalisedPhone.ok ? normalisedPhone.stored : profileData.phoneNumber,
        whatsappNumber: normalisedWhatsapp.ok ? normalisedWhatsapp.stored : undefined,
        state: profileData.state,
        district: profileData.district,
        block: profileData.block,
        city: profileData.city,
        place: abroad.international ? profileData.place : undefined,
        religion: profileData.religion,
        socialCategory: safeSocialCategory,
        gender: safeGender,
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

    /* Recorded once and kept: a member found abroad by their number stays so. */
    if (abroad.international && member.isInternational !== true) {
        member.isInternational = true;
        member.country = abroad.country;
        coreChanged = true;
    }

    if (coreChanged) {
        member.profileCompleted = true;
        await member.save();
    }

    /*
     * THE APPLICATION MIRROR IS BEST EFFORT, SO IT NO LONGER HOLDS THE REPLY.
     *
     * This copies the member's name, email, phone and region onto their
     * Application rows so the admin queues show current details. It has
     * always been wrapped in a `try` that swallows its own failure — which
     * says plainly that the save is not considered to depend on it — and yet
     * the member waited for it before their own screen came back.
     *
     * `void (async () => …)()` runs it after this handler has replied. A
     * failure is logged rather than silently dropped, which is a change: it
     * was invisible before.
     *
     * THE FILTER IS DEDUPED. It listed `email` twice (the current one and the
     * original, identical whenever the email did not change) and could carry
     * empty strings, and an `$or` branch that matches nothing still has to be
     * planned. Only the predicates that can actually match are sent.
     */
    void (async () => {
      try {
        const Application = require('../applications/application.model');
        const searchEmail = (member.email || originalEmail || '').toLowerCase();
        const emails = [...new Set([searchEmail, String(originalEmail || '').toLowerCase()])]
            .filter(Boolean);
        const or = [{ userId: req.user.userId }, ...emails.map((value) => ({ email: value }))];
        await Application.updateMany(
            { $or: or },
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
                    'data.personalDetails.socialCategory': profileData.socialCategory || member.socialCategory,
                    'data.personalDetails.gender': safeGender || member.gender || ''
                }
            }
        );
      } catch (syncErr) {
        // Logged, not swallowed: the mirror going stale is a real fault, it
        // is just not one the member should wait for.
        console.error('Error syncing member updates to Application collection:', syncErr);
      }
    })();

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
     * The rename itself now happens in `normalizeProfileAliases` above; the
     * `??` here is kept because it costs nothing and this must not depend on
     * the order of those two steps.
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

    // `lastYearTurnover` — mobile's legacy name for `turnoverRange` — is
    // handled by `normalizeProfileAliases`, along with the rest of them.

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
        profileData.govtSchemes !== undefined || profileData.schemeDetails !== undefined ||
        profileData.itrYears !== undefined || profileData.turnoverLast3Years !== undefined) {
        
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
                /*
                 * `''` is what an emptied number box sends, and Number('') is 0
                 * — "I cleared this" would be stored as "I have filed for zero
                 * years". Blank leaves the stored answer alone; an actual
                 * number, including 0, replaces it.
                 */
                itrYears: profileData.itrYears === undefined || profileData.itrYears === ''
                    ? financialInfo.itrYears
                    : Number(profileData.itrYears),
                /* An explicit empty array clears the three boxes — same
                   reasoning as `govtSchemes` above. */
                turnoverLast3Years: Array.isArray(profileData.turnoverLast3Years)
                    ? profileData.turnoverLast3Years
                    : financialInfo.turnoverLast3Years,
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
                itrYears: profileData.itrYears === undefined || profileData.itrYears === ''
                    ? undefined
                    : Number(profileData.itrYears),
                turnoverLast3Years: Array.isArray(profileData.turnoverLast3Years)
                    ? profileData.turnoverLast3Years
                    : [],
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
        gender: personalInfo.gender || member.gender || '',
        email: member.email,
        isLocked: personalInfo.isLocked
    };
    
    /* The member context caches the region and the membership status for
       fifteen seconds, and a profile save is one of the two things that can
       make it wrong. A delete from a Map costs nothing and the worst it can
       do is make the next request pay for a read it would have paid for
       fifteen seconds later anyway. */
    invalidateMemberContext(req.user.userId);

    res.json(ApiResponse.success(responseData, 'Profile updated successfully'));
});

const getMyProfile = asyncHandler(async(req, res) => {
    // Get personal details from PersonalInfo1 collection and member from web users collection concurrently
    const [personalInfo, member] = await Promise.all([
        PersonalInfo1.findOne({ userId: req.user.userId }),
        MemberDetails.findById(req.user.userId).select('-password')
    ]);
    
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
        /* Members outside India: no region, a place instead — see `internationalFromPhone`. */
        isInternational: member.isInternational === true,
        country: member.country || '',
        place: member.place || '',
        religion: personalInfo.religion,
        socialCategory: personalInfo.socialCategory,
        /* `personalInfo` predates this field for every member who filled the
           form in before it was asked; their answer, if any, is on the member
           record. */
        gender: personalInfo.gender || member.gender || '',
        email: member.email,
        profilePhoto: member.profilePhoto || null,
        membershipStatus: member.membershipStatus || 'pending',
        /*
         * TWO DIFFERENT QUESTIONS, AND ONLY ONE OF THEM WAS ANSWERED HERE.
         *
         * `membershipType` is the PLAN somebody has paid for — 'annual' on a
         * paid member, and the literal string 'none' until the payment
         * clears. `memberType` is WHAT KIND OF APPLICANT they are —
         * 'business' or 'aspirant' — decided at registration and true from
         * the moment they apply.
         *
         * Only the first was returned, and the profile screen printed it
         * under the heading "Membership Type". So a business applicant
         * looking at their own profile was told their membership type was
         * "none" — which is not their type, it is the plan they have not
         * bought yet. The data was correct on the record the whole time:
         * `memberType: 'business'` was sitting one field away and never left
         * the server.
         *
         * `registrationType` is the fallback because the two are written
         * together by `applicationService.createApplication` and a legacy row
         * may carry only the second.
         */
        memberType: member.memberType || member.registrationType || '',

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
        membershipNumber: membershipNumberFor(member),
        membershipActivatedAt: member.membershipActivatedAt || null,

        /*
         * WHAT WAS PAID, AND AGAINST WHAT.
         *
         * The member record has carried `paymentAmount` and `paymentId` since
         * the gateway started writing them — `payment.service` sets both on a
         * successful capture — but this response never included them, so the
         * receipt screen, the plan screen and the member's own dashboard all
         * printed a dash where the amount should be. There was nothing wrong
         * with the data; it simply never left the server.
         *
         * `lastPayment*` are the names the client asks for first, and they do
         * not exist on this model — the stored fields answer to them here so
         * one shape reaches every screen.
         */
        paymentAmount: member.paymentAmount ?? null,
        lastPaymentAmount: member.paymentAmount ?? null,
        paymentId: member.paymentId || '',
        lastPaymentDate: member.lastPaymentDate || member.membershipActivatedAt || null,
        paymentMethod: member.paymentMethod || '',
        isLocked: personalInfo.isLocked || false
    } : {
        fullName: member.fullName,
        phoneNumber: member.phoneNumber,
        state: member.state,
        district: member.district,
        block: member.block,
        city: member.city,
        /* Members outside India: no region, a place instead — see `internationalFromPhone`. */
        isInternational: member.isInternational === true,
        country: member.country || '',
        place: member.place || '',
        religion: member.religion,
        socialCategory: member.socialCategory,
        gender: member.gender || '',
        email: member.email,
        profilePhoto: member.profilePhoto || null,
        membershipStatus: member.membershipStatus || 'pending',
        /*
         * TWO DIFFERENT QUESTIONS, AND ONLY ONE OF THEM WAS ANSWERED HERE.
         *
         * `membershipType` is the PLAN somebody has paid for — 'annual' on a
         * paid member, and the literal string 'none' until the payment
         * clears. `memberType` is WHAT KIND OF APPLICANT they are —
         * 'business' or 'aspirant' — decided at registration and true from
         * the moment they apply.
         *
         * Only the first was returned, and the profile screen printed it
         * under the heading "Membership Type". So a business applicant
         * looking at their own profile was told their membership type was
         * "none" — which is not their type, it is the plan they have not
         * bought yet. The data was correct on the record the whole time:
         * `memberType: 'business'` was sitting one field away and never left
         * the server.
         *
         * `registrationType` is the fallback because the two are written
         * together by `applicationService.createApplication` and a legacy row
         * may carry only the second.
         */
        memberType: member.memberType || member.registrationType || '',

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
        membershipNumber: membershipNumberFor(member),
        membershipActivatedAt: member.membershipActivatedAt || null,

        /*
         * WHAT WAS PAID, AND AGAINST WHAT.
         *
         * The member record has carried `paymentAmount` and `paymentId` since
         * the gateway started writing them — `payment.service` sets both on a
         * successful capture — but this response never included them, so the
         * receipt screen, the plan screen and the member's own dashboard all
         * printed a dash where the amount should be. There was nothing wrong
         * with the data; it simply never left the server.
         *
         * `lastPayment*` are the names the client asks for first, and they do
         * not exist on this model — the stored fields answer to them here so
         * one shape reaches every screen.
         */
        paymentAmount: member.paymentAmount ?? null,
        lastPaymentAmount: member.paymentAmount ?? null,
        paymentId: member.paymentId || '',
        lastPaymentDate: member.lastPaymentDate || member.membershipActivatedAt || null,
        paymentMethod: member.paymentMethod || '',
        isLocked: false
    };
    
    // Disable caching to ensure fresh data
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(ApiResponse.success(profileData));
});

const getBusinessInfo = asyncHandler(async(req, res) => {
    // Get business info from BusinessInfo collection and member from web users collection concurrently
    const [businessInfo, member] = await Promise.all([
        BusinessInfo.findOne({ userId: req.user.userId }),
        MemberDetails.findById(req.user.userId)
    ]);
    
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
    // Get financial info from MemberFinancialInfo collection and member from web users collection concurrently
    const [financialInfo, member] = await Promise.all([
        MemberFinancialInfo.findOne({ memberId: req.user.userId }).select('+panNumber'),
        MemberDetails.findById(req.user.userId)
    ]);
    
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
        itrYears: financialInfo.itrYears,
        turnoverLast3Years: financialInfo.turnoverLast3Years || [],
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
        itrYears: null,
        turnoverLast3Years: [],
        status: 'draft'
    };
    
    // Disable caching
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(ApiResponse.success(financialData));
});

const getDeclarationInfo = asyncHandler(async(req, res) => {
    // Get declaration info from MemberDeclaration collection and member from web users collection concurrently
    const [declarationInfo, member] = await Promise.all([
        MemberDeclaration.findOne({
            $or: [{ userId: req.user.userId }, { memberId: req.user.userId }]
        }),
        MemberDetails.findById(req.user.userId)
    ]);
    
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