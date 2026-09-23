const mongoose = require('mongoose');
/* ONE expression for the membership number, for the reason the model's
   own comment gives: four copies of it is how the dashboard and the
   certificate came to print different numbers for the same member. */
const { membershipNumberFor } = require('./memberNumber');
const asyncHandler = require('../../core/utils/asyncHandler');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

const Company = require('./company.model');
const Activity = require('../common/activity.model');
const MembershipPlan = require('./membershipplan.model');
const MemberDetails = require('./memberdetails.model');
const membershipPlanService = require('./membershipplan.service');
// Where the commencement year lives. Keyed by `userId` — see the collection
// table in CLAUDE.md; the wrong key here returns null and nothing reports it.
const BusinessInfo = require('./businessinfo.model');
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
    // Seeded on the way through, so a database that has never been written to
    // answers with the plans the platform shipped rather than with nothing.
    await membershipPlanService.listActive().catch(() => []);

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

/**
 * THE PLANS THIS APPLICANT IS ACTUALLY OFFERED.
 *
 * Separate from the public listing above, and deliberately so. That one is
 * "what does membership cost" and has to answer before anybody signs in; this
 * one is "what do *I* pay", which cannot be answered without knowing who is
 * asking and how long their company has traded.
 *
 * THE BAND IS RESOLVED ON THE SERVER, from the commencement year on the
 * member's own business record. Doing it in the browser would mean the price a
 * client shows is a client's opinion — and the two clients would drift the
 * moment one of them shipped a different threshold.
 *
 * `reason` travels with the answer so the screen can say WHY it is showing one
 * price or several: matched a band, no commencement year on file, no band
 * covers it, or the Super Admin has asked for every plan to be shown.
 */
const listMyPlans = asyncHandler(async(req, res) => {
    const user = req.user || {};
    const userId = user.userId || user.id;

    /*
     * Business record first, member profile second.
     *
     * `BusinessInfo` is where the commencement year is captured, and it is
     * keyed by `userId` — see the collection table in CLAUDE.md, where getting
     * this wrong fails silently. A member with no business record is an
     * aspirant as far as pricing is concerned, which is the same conclusion
     * `doingBusiness: false` reaches.
     */
    const business = await BusinessInfo.findOne({ userId: String(userId) }).lean().catch(() => null);

    const declaredAspirant = business
        ? business.doingBusiness === false
        : true;

    const commencementYear = business
        ? (business.businessCommencementYear || business.commencementYear || '')
        : '';

    const resolved = await membershipPlanService.resolveForMember({
        commencementYear,
        isAspirant: declaredAspirant
    });

    res.json(ApiResponse.success(resolved));
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
 * ============================================================================
 * AN ANNUAL MEMBERSHIP ENDS ON 31 MARCH
 * ============================================================================
 *
 * Not on the anniversary of the payment. The association's certificates are
 * taken to a tax officer, and the year a tax officer counts in is the Indian
 * financial year: 1 April to 31 March.
 *
 * The old fallback added a calendar year to the activation date, so a member
 * who paid on 12 November 2025 was certified to 12 November 2026 — a date
 * spanning two financial years and matching nothing in the association's own
 * books.
 *
 *     activated 12 Nov 2025  ->  31 Mar 2026
 *     activated 02 Feb 2026  ->  31 Mar 2026   (still 2025-26)
 *     activated 05 Apr 2026  ->  31 Mar 2027
 *
 * 23:59:59 on the day rather than midnight at the start of it. A certificate
 * valid “until 31 March” is valid ON 31 March, and a bare date is midnight,
 * which expires it a day early for anything comparing timestamps.
 */
/* Today, for a row with no activation date at all — the old fallback skipped
   those and left the certificate with no end date, which on a tax document
   reads as an exemption with no year attached to it. */
const issuedAtForYear = () => new Date();

/**
 * India is UTC+5:30. Both halves of the rule below are computed in it.
 *
 * Not the server's own timezone, and not the reader's: the financial year this
 * certificate names is an INDIAN one, and it begins and ends at midnight in
 * Chennai whatever clock the machine or the browser happens to be on.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const endOfFinancialYear = (from) => {
    const start = new Date(from);
    if (Number.isNaN(start.getTime())) return null;

    /*
     * WHICH YEAR, read in IST.
     *
     * Shifting the instant and then reading it with the UTC accessors is how
     * you ask “what was the date in India?” without a timezone library. On a
     * UTC server the plain `getMonth()` reads an activation at 01:30 IST on 1
     * April as 20:00 on 31 March — the PREVIOUS financial year — for the few
     * hours a year when the two disagree.
     *
     * getUTCMonth() is 0-based, so 3 is April. On or after April the year ends
     * next March; before it, this March.
     */
    const ist = new Date(start.getTime() + IST_OFFSET_MS);
    const endYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() + 1 : ist.getUTCFullYear();

    /*
     * WHEN IT ENDS — 23:59:59.999 IST on 31 March, written as the UTC instant
     * that is: 18:29:59.999Z.
     *
     * `new Date(endYear, 2, 31, 23, 59, 59, 999)` built that in the SERVER's
     * timezone. On a UTC server it serialised as `2027-03-31T23:59:59.999Z`,
     * and a browser in India rendered it as 1 April 2027 — which is what the
     * certificate printed, on the one date it exists to state.
     *
     * This instant reads as 31 March on every clock from UTC−11 to UTC+12, and
     * it still keeps what the original was reaching for: valid ON 31 March,
     * right up to midnight where the association is, so a comparison made at
     * nine in the evening in Chennai does not call it expired.
     */
    return new Date(Date.UTC(endYear, 2, 31, 18, 29, 59, 999));
};

/**
 * “2026-27” — the form the year is actually quoted in.
 *
 * Derived here and sent to the clients rather than computed in each of them:
 * the website and the mobile app deriving it separately is how the two would
 * come to print different years on the same certificate.
 */
const financialYearLabel = (endsAt) => {
    if (!endsAt) return '';
    const end = new Date(endsAt);
    if (Number.isNaN(end.getTime())) return '';
    /* In IST, like everything else about this year — read on the server's own
       clock, an expiry of 18:29:59.999Z on 31 March is still 31 March in UTC
       but 31 March 13:29 in New York, and one of those rolls over the year on a
       machine in a timezone nobody thought about. */
    const endYear = new Date(end.getTime() + IST_OFFSET_MS).getUTCFullYear();
    return `${endYear - 1}-${String(endYear).slice(2)}`;
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

    /*
     * ======================================================================
     * HOW LONG IT IS GOOD FOR — AND THE TWO CERTIFICATES DISAGREE
     * ======================================================================
     *
     * They are answering different questions, and answering both with the same
     * number is what put “17 September 2027” on a tax document:
     *
     *   MEMBERSHIP     when does this person stop being a member? That is the
     *                  association's own commercial term, and it is stored on
     *                  the member as `membershipExpiresAt`.
     *
     *   TAX EXEMPTION  which financial year may this be claimed against? 1
     *                  April to 31 March, which is not the association's to
     *                  decide. It is DERIVED, always, and the stored expiry is
     *                  deliberately not read — it is the answer to the other
     *                  question.
     *
     * The tax certificate also ignores `membershipType`. A lifetime member's
     * exemption is still claimed one financial year at a time, and printing
     * “Lifetime” on a document a tax officer reads would be a claim nobody made.
     *
     * For the membership certificate the stored expiry is preferred and the
     * financial-year end is the fallback, because `membershipExpiresAt` was
     * undeclared for a long time (see the note on it in `memberdetails.model.js`)
     * and rows written in that window have an activation date and no expiry. A
     * LIFETIME membership returns null there, and the client prints “Lifetime”
     * rather than an invented date far in the future.
     */
    const type = String(member.membershipType || '').toLowerCase();
    const activatedAt = member.membershipActivatedAt || member.approvedAt || member.createdAt || null;

    let validUntil;
    if (kind === 'tax-exemption') {
        validUntil = endOfFinancialYear(activatedAt || issuedAtForYear());
    } else {
        validUntil = member.membershipExpiresAt || null;
        if (!validUntil && type === 'annual' && activatedAt) {
            validUntil = endOfFinancialYear(activatedAt);
        }
    }

    const issuedAt = new Date();

    res.json(ApiResponse.success({
        kind,
        title: spec.title,
        body: spec.body,
        member: {
            name: member.fullName || '',
            membershipNumber: membershipNumberFor(member),
            email: member.email || '',
            block: member.block || '',
            district: member.district || '',
            state: member.state || '',
            /* Outside India: no region; the certificate prints the place. */
            isInternational: member.isInternational === true,
            place: member.place || '',
            country: member.country || '',
        },
        /** `annual` | `lifetime` | `''`. The client words it. */
        membershipType: type === 'annual' || type === 'lifetime' ? type : '',
        memberSince: member.approvedAt || member.createdAt || null,
        activatedAt,
        /**
         * Null means it does not lapse — a lifetime MEMBERSHIP.
         *
         * Never null on a tax certificate: that one is bounded by the financial
         * year whatever kind of membership is behind it.
         */
        validUntil,
        /** “2026-27” on a tax certificate, empty on the other. */
        financialYear: kind === 'tax-exemption' ? financialYearLabel(validUntil) : '',
        /*
         * ==================================================================
         * WHAT WAS ACTUALLY RECEIVED — the tax certificate only
         * ==================================================================
         *
         * The exemption certificate is laid out as a Form 10BE, which names a
         * sum and the transaction it came in on. Those two facts are on the
         * member document already (`paymentAmount`, `paymentId`) and were not
         * being sent, so the client had nothing to put in the rows and would
         * have had to either invent a figure or drop the rows.
         *
         * `amount` IS NULLABLE AND THE CLIENT MUST TREAT IT SO. Both fields
         * were undeclared on the schema for a long time (see the note on them
         * in `memberdetails.model.js`) and Mongoose strict mode dropped them on
         * every payment in that window — so a member activated then has a paid
         * membership and no record of the sum. A certificate that fills that
         * gap with a plausible number is a tax document carrying a figure
         * nobody can reconcile.
         *
         * Empty on the membership certificate: what a member paid is not part
         * of a statement about who they are.
         */
        contribution: kind === 'tax-exemption'
            ? {
                amount: typeof member.paymentAmount === 'number' ? member.paymentAmount : null,
                reference: member.paymentId || '',
                receivedOn: member.lastPaymentDate || member.membershipActivatedAt || null,
            }
            : null,
        /*
         * A reference somebody can quote back.
         *
         * Derived, not stored: a certificate is generated on demand and two
         * prints of the same membership on the same day should carry the same
         * reference, so it is built from the membership number and the issue
         * DATE rather than from a random id or the time of day.
         */
        reference: [
            'ACTIV',
            kind === 'membership' ? 'MEM' : 'TAX',
            membershipNumberFor(member),
            issuedAt.toISOString().slice(0, 10).replace(/-/g, ''),
        ].join('-'),
        // Stamped at read time rather than stored: the certificate is generated
        // on demand, and the date on it should be the date it was issued.
        issuedAt,
        issuedBy: 'Adidravidar Confederation of Trade and Industrial Vision',
    }));
});

module.exports = {
    browseMembers, searchMembers,
    listCompanies, getCompany, createCompany, updateCompany, deleteCompany,
    listPlans, listMyPlans,
    listActivity, recordActivity,
    getCertificate,
};
