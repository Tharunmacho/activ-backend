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
