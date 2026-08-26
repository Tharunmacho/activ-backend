const mongoose = require('mongoose');
const { BUSINESS_TYPES } = require('./businessTypes');

// Company Schema - for business accounts created from dashboard
const companySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberDetails',
        required: true
    },
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
    logo: {
        type: String,
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
