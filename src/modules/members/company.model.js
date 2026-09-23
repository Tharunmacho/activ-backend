const mongoose = require('mongoose');
const { BUSINESS_TYPES } = require('./businessTypes');
const {
    CONSTITUTION_TYPES,
    GOVT_REGISTRATIONS,
    ALL_TURNOVER_RANGES,
} = require('./businessOptions');

// Company Schema - for business accounts created from dashboard
const companySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberDetails',
        required: true
    },
    /**
     * Required — a company record with no name cannot be found, switched to or
     * listed, and every other screen in the business area is addressed to it by
     * name. It is one of four the form insists on; everything about money and
     * registrations is optional, because that is what a member has to go and
     * look up. `companyName()` in `BusinessUI` still guards the render path, for
     * rows that predate this rule.
     */
    businessName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        lowercase: true
    },
    description: {
        type: String,
        trim: true
    },
    businessType: {
        type: String,
        enum: BUSINESS_TYPES,
        required: true
    },
    mobileNumber: {
        type: String,
        required: true,
        trim: true
    },
    area: {
        type: String,
        trim: true
    },
    location: {
        type: String,
        required: true,
        trim: true
    },
    /**
     * The cover image across the top of the public profile.
     *
     * Separate from `logo` and stored the same way (a relative `/uploads/<file>`
     * path, re-anchored at render). They are two different pictures doing two
     * different jobs — the mark that identifies the company, and the band it
     * sits on — and one field could only ever hold one of them.
     *
     * Optional, like everything else about a company bar four fields. With none
     * the public page draws its own; see the note there.
     */
    banner: {
        type: String,
        trim: true,
        default: ''
    },
    logo: {
        type: String,
        default: ''
    },
    /*
     * ------------------------------------------------------------------
     * BUSINESS INFORMATION — moved here from the registration forms.
     * ------------------------------------------------------------------
     *
     * These used to live on `BusinessInfo`, one document per MEMBER. A member
     * who trades through two companies has one constitution type, one employee
     * count and one set of affiliations there, describing whichever company was
     * filled in last — so the second company's details had nowhere to go and
     * the first company's were overwritten by them.
     *
     * `businessCommencementYear` is deliberately NOT here. It stays on the
     * member's `BusinessInfo` record because it is what resolves the membership
     * band and therefore the price of the membership itself (see MEMBERSHIP
     * PRICING in CLAUDE.md) — a per-company copy would give one applicant
     * several answers to a question that has one.
     */
    constitutionType: {
        type: String,
        enum: [...CONSTITUTION_TYPES, ''],
        default: ''
    },
    businessActivities: {
        type: String,
        trim: true,
        default: ''
    },
    /**
     * What this company makes or does, as NIC categories.
     *
     * `code` is the zero-padded NIC code — 2 digits division, 3 group, 4 class,
     * 5 sub-class — and it is what makes the answer countable. Free-typed
     * product names are not: "Rice milling", "rice mill" and "Rice Mills" are
     * three industries to anything totalling them up.
     *
     * NOT AN ENUM, and not validated against the catalogue. The NIC list is a
     * reference, not a census: a member whose product it genuinely does not name
     * must still be able to record it, and such an entry is stored with an empty
     * `code` and the text they typed. Refusing the unknown case makes the field
     * unanswerable, and an unanswerable field gets filled with nonsense. Same
     * reasoning as the `+` on `RegionInput` — see ADMIN-FIRST REGION
     * ARCHITECTURE in CLAUDE.md.
     *
     * A subdocument rather than three parallel arrays, because the code, the
     * description and the industry type are one answer and have to stay
     * together: three arrays drift out of step the first time one is edited.
     */
    productCategories: [{
        _id: false,
        code: { type: String, trim: true, default: '' },
        description: { type: String, trim: true, default: '' },
        industryType: { type: String, trim: true, default: '' }
    }],
    numberOfEmployees: {
        type: String,
        trim: true,
        default: ''
    },
    memberOfOtherChamber: {
        type: Boolean,
        default: false
    },
    otherChamber: {
        type: String,
        trim: true,
        default: ''
    },

    /*
     * ------------------------------------------------------------------
     * FINANCIAL INFORMATION
     * ------------------------------------------------------------------
     */

    /**
     * `select: false`, and it matters here more than on the member record.
     *
     * Company documents are what `discoverCompanies` lists to every signed-in
     * member. That handler projects an explicit field list, so a PAN would not
     * leak through it today — but "today's projection happens to exclude it" is
     * not a protection, it is a coincidence that the next field added to that
     * string would end. Excluded by default, and asked for by name on the two
     * owner-scoped reads that legitimately need it.
     */
    panNumber: {
        type: String,
        trim: true,
        uppercase: true,
        select: false,
        default: ''
    },
    gstNumber: {
        type: String,
        trim: true,
        uppercase: true,
        default: ''
    },
    filedITR: {
        type: Boolean,
        default: false
    },
    /**
     * Which years were filed — the question "yes" invites.
     *
     * `filedITR` on its own records that returns exist and nothing about them,
     * so answering Yes changed nothing on screen and the member was left
     * wondering whether the click had registered. Free text rather than a year
     * list: "last 3 years", "2021-22 to 2023-24" and "since inception" are all
     * real answers, and a picker would force the first of them into a shape it
     * does not have.
     */
    itrYears: {
        type: String,
        trim: true,
        default: ''
    },
    turnoverRange: {
        type: String,
        enum: ALL_TURNOVER_RANGES,
        trim: true,
        default: ''
    },
    /** The figure typed when the slab chosen is `Other / Manual Entry`. */
    turnoverOther: {
        type: String,
        trim: true,
        default: ''
    },
    /**
     * Which government bodies this company is registered with.
     *
     * A list, not a single value — a manufacturer is routinely both an MSME and
     * a member of an export promotion council, and asking them to pick one
     * loses the other.
     */
    govtRegistrations: [{
        type: String,
        enum: GOVT_REGISTRATIONS
    }],
    /** One detail field per answer above, so which number is which survives. */
    msmeUdyamNumber: {
        type: String,
        trim: true,
        uppercase: true,
        default: ''
    },
    /**
     * NSIC's own number, kept apart from the Udyam one.
     *
     * They are two registrations, not two names for one: Udyam is what the
     * Ministry issues to make a firm an MSME, and NSIC — a Government of India
     * enterprise under that same ministry — issues its Single Point Registration
     * (SPRS) to MSMEs that apply for it. A firm commonly holds both, and storing
     * them in one column would make it impossible to say later which number was
     * which, or to quote the right one on a tender.
     */
    nsicRegistrationNumber: {
        type: String,
        trim: true,
        uppercase: true,
        default: ''
    },
    exportCouncilName: {
        type: String,
        trim: true,
        default: ''
    },
    exportCouncilRegNumber: {
        type: String,
        trim: true,
        uppercase: true,
        default: ''
    },
    otherRegistrationDetails: {
        type: String,
        trim: true,
        default: ''
    },
    /**
     * Schemes availed. Not an enum, for the reason given on the same field in
     * `memberfinancialinfo.model.js`: a new government scheme must be
     * recordable without shipping a server.
     */
    govtSchemes: {
        type: [String],
        default: []
    },
    /** Free text, shown only when "Others" is among the schemes above. */
    schemeDetails: {
        type: String,
        trim: true,
        default: ''
    },

    status: {
        type: String,
        enum: ['pending', 'active', 'inactive'],
        default: 'pending'
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    collection: 'companies',
    timestamps: true
});

// Index for faster queries
companySchema.index({ userId: 1 });
companySchema.index({ businessName: 1 });
companySchema.index({ status: 1 });

const Company = mongoose.model('Company', companySchema);

module.exports = Company;
