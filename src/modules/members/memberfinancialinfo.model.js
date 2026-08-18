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