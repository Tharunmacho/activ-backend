const mongoose = require('mongoose');

/**
 * A membership tier a member can buy.
 *
 * The collection already held three plans and had no model behind it, so the
 * mobile app's `/membership/plans` call answered 404 and the plans screen had
 * nothing to render. This describes what is already stored rather than
 * inventing a new shape.
 *
 * Amounts are in paise, not rupees. Instamojo takes paise, floating-point
 * rupees lose money to rounding, and a schema that stores 499.00 as a Number is
 * one arithmetic operation away from 498.99999999.
 */
const membershipPlanSchema = new mongoose.Schema({
    /**
     * The stable id a client sends when it buys — `basic`, `aspirant`, and so on.
     *
     * THIS IS THE FIELD THAT MOVED PRICING INTO THE DATABASE. Payment resolves a
     * plan by key and charges what the row says, so the Super Admin editing an
     * amount here changes what is actually taken, not merely what is displayed.
     * Before this, the price lived in a frozen table in `payment/membershipPlans.js`
     * and nothing in the product could change it.
     *
     * `sparse` on the unique index: rows written before the field existed carry
     * no key, and a plain unique index would let exactly one of them exist.
     */
    key: {
        type: String,
        trim: true,
        lowercase: true,
        default: '',
        index: { unique: true, sparse: true }
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    /** Which kind of member this plan is for, e.g. aspirant or business. */
    memberType: {
        type: String,
        trim: true,
        default: '',
        index: true
    },

    /**
     * WHO THE PLAN IS FOR, and it is the first half of choosing one.
     *
     *   business   priced by how long the applicant's company has traded — the
     *              band below decides which one of these they are offered.
     *   aspirant   an applicant who declared no business. Bands do not apply;
     *              there is one such plan and everybody without a company gets
     *              it, at whatever the Super Admin has set.
     */
    audience: {
        type: String,
        enum: ['business', 'aspirant'],
        default: 'business',
        index: true
    },

    /**
     * THE COMMENCEMENT-YEAR BAND, in years traded, as a HALF-OPEN interval
     * `[minYears, maxYears)`.
     *
     * Half-open so the bands the Super Admin types cannot overlap or leave a
     * gap. "0 to 5" and "5 to 10" read as touching to a person and as
     * overlapping to a computer; with `max` exclusive, a company at exactly five
     * years lands in the second band and in only one band, without anybody
     * having to think about it.
     *
     * `maxYears: null` is the open-ended top band — "10 and above". Null and not
     * a large number, because a sentinel like 999 is a number somebody
     * eventually edits.
     *
     * Ignored for `audience: 'aspirant'`, which has no company to date.
     */
    minYears: {
        type: Number,
        default: 0,
        min: 0
    },
    maxYears: {
        type: Number,
        default: null,
        min: 0
    },

    /** Drawn with the "most popular" flourish. At most one, by convention. */
    popular: {
        type: Boolean,
        default: false
    },
    tagline: {
        type: String,
        trim: true,
        default: ''
    },
    amountPaise: {
        type: Number,
        required: true,
        min: 0
    },
    currency: {
        type: String,
        trim: true,
        default: 'INR'
    },
    /** 0 means the plan does not expire — the lifetime tier. */
    durationMonths: {
        type: Number,
        default: 0,
        min: 0
    },
    /** What the plan includes, one line each, in the order shown. */
    entitlements: [{
        type: String,
        trim: true
    }],
    /** Explicit, so plans can be reordered without renaming or re-pricing. */
    displayOrder: {
        type: Number,
        default: 0,
        index: true
    },
    /**
     * Retired rather than deleted.
     *
     * A member who bought a plan keeps a reference to it, and deleting the
     * document would leave their record pointing at nothing.
     */
    isActive: {
        type: Boolean,
        default: true,
        index: true
    }
}, {
    collection: 'membershipPlans',
    timestamps: true
});

membershipPlanSchema.index({ isActive: 1, displayOrder: 1 });

module.exports = mongoose.model('MembershipPlan', membershipPlanSchema);
