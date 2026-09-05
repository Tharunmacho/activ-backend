const mongoose = require('mongoose');

// MemberFinancialInfo Schema - matches memberfinancialinfos collection
const memberFinancialInfoSchema = new mongoose.Schema({
    memberId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberDetails',
        required: true,
        unique: true
    },
    panNumber: {
        type: String,
        trim: true,
        uppercase: true,
        select: false
    },
    gstNumber: {
        type: String,
        trim: true,
        uppercase: true
    },
    udyamNumber: {
        type: String,
        trim: true,
        uppercase: true
    },
    filedITR: {
        type: Boolean,
        default: false
    },
    turnoverRange: {
        type: String,
        enum: ['Below 1 Lakh', '1-5 Lakhs', '5-10 Lakhs', '10-50 Lakhs', '50 Lakhs - 1 Crore', 'Above 1 Crore'],
        trim: true
    },
    govtSchemeBenefit: {
        type: Boolean,
        default: false
    },
    /**
     * Which schemes, not merely whether any.
     *
     * Both clients have always asked "which government schemes have you
     * availed?" and sent the answer as `govtSchemes`. The field did not exist
     * here, so Mongoose strict mode discarded it on every save — silently, with
     * a 200 and a "saved successfully" toast. All that survived was the derived
     * `govtSchemeBenefit` boolean, which records *that* a member is a
     * beneficiary and loses *what of*.
     *
     * The list is deliberately not an enum. `businessType` and `turnoverRange`
     * are enums because a wrong value there breaks routing or reporting; a
     * scheme name does neither, and pinning the list in the schema would mean a
     * new government scheme could not be recorded until the server shipped.
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
    /**
     * How many continuous years the member has filed ITR.
     *
     * The financial form has asked this since it was written — it appears the
     * moment "Have you filed ITR?" is answered yes — and there was nowhere to
     * put the answer, so Mongoose strict mode dropped it on every save. The
     * member typed a number, was told the step had saved, and found the field
     * empty when they came back. Same failure as `govtSchemes` above, one
     * question along.
     */
    itrYears: {
        type: Number,
        min: 0
    },
    /**
     * Turnover for the last three years, most recent FIRST.
     *
     * Ordered rather than keyed by financial year on purpose: the form's labels
     * are "FY 2024-25 / 2023-24 / 2022-23", which move every April. Storing
     * `fy2024_25` would mean a schema change each year and a stored key that
     * stops meaning "last year" the moment the labels roll. Position is what is
     * actually being asked — most recent, the one before, the one before that.
     *
     * Strings, not numbers: the field is a free-text box and members write
     * "45,00,000" and "45 lakh". Parsing that into a number here would turn an
     * answer the association can read into a zero.
     */
    turnoverLast3Years: {
        type: [String],
        default: []
    },
    status: {
        type: String,
        enum: ['draft', 'submitted', 'verified', 'rejected'],
        default: 'draft',
        index: true
    }
}, {
    collection: 'additional form for financial 3',
    timestamps: true
});

module.exports = mongoose.model('MemberFinancialInfo', memberFinancialInfoSchema);