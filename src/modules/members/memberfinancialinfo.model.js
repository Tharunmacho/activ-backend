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