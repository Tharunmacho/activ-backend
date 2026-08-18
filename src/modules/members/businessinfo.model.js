const mongoose = require('mongoose');

// BusinessInfo Schema - for storing business information in additional form
const businessInfoSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberDetails',
        required: true,
        unique: true
    },
    doingBusiness: {
        type: Boolean,
        required: true,
        default: false
    },
    registrationType: {
        type: String,
        enum: ['aspirant', 'business'],
        default: 'aspirant'
    },
    // Business Details (only if doingBusiness = true)
    organizationName: {
        type: String,
        trim: true
    },
    constitutionType: {
        type: String,
        enum: ['OPC', 'TRUST', 'SOCIETY', 'Proprietorship', 'Partnership', 'Private Limited', ''],
        default: ''
    },
    businessTypes: [{
        type: String,
        enum: ['Manufacturing', 'Trader', 'Service Provider', 'Others']
    }],
    businessActivities: {
        type: String,
        trim: true
    },
    businessCommencementYear: {
        type: String,
        trim: true
    },
    numberOfEmployees: {
        type: String,
        trim: true
    },
    memberOfOtherChamber: {
        type: Boolean,
        default: false
    },
    otherChamber: {
        type: String,
        trim: true
    },
    govtOrganizations: [{
        type: String,
        enum: ['MSME', 'KVIC', 'NABARD', 'None', 'Others']
    }],
    isLocked: {
        type: Boolean,
        default: false
    },
    submittedAt: {
        type: Date
    }
}, {
    collection: 'additional form for bussiness 2',
    timestamps: true
});

// Index is already created via unique: true on userId field

const BusinessInfo = mongoose.model('BusinessInfo', businessInfoSchema);

module.exports = BusinessInfo;

