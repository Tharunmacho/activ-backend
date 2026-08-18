const mongoose = require('mongoose');

// MemberDetails Schema - web users collection (full user details)
const memberDetailsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        auto: true
    },
    fullName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
    },
    phoneNumber: {
        type: String,
        required: true,
        trim: true
    },
    state: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    district: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    block: {
        type: String,
        required: true,
        trim: true,
        index: true
    },
    city: {
        type: String,
        trim: true
    },
    aadhaarNumber: {
        type: String,
        trim: true,
        select: false
    },
    educationalQualification: {
        type: String,
        trim: true
    },
    religion: {
        type: String,
        trim: true
    },
    socialCategory: {
        type: String,
        enum: ['Christian ST', 'Christian SC', 'ST', 'SC', 'Others', ''],
        trim: true,
        default: ''
    },
    profileCompleted: {
        type: Boolean,
        default: false
    },
    approvedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StateAdmin'
    },
    approvedBlock: {
        type: String,
        trim: true
    },
    approvedAt: {
        type: Date
    },
    membershipStatus: {
        type: String,
        enum: ['pending', 'active', 'expired', 'cancelled'],
        default: 'pending',
        index: true
    },
    membershipType: {
        type: String,
        enum: ['annual', 'lifetime', 'none'],
        default: 'none'
    },
    membershipActivatedAt: {
        type: Date
    },
    role: {
        type: String,
        enum: ['member', 'admin'],
        default: 'member'
    },
    isActive: {
        type: Boolean,
        default: true
    },
    profilePhoto: {
        type: String,
        trim: true
    }
}, {
    collection: 'users',
    timestamps: true
});

// Indexes for efficient queries
memberDetailsSchema.index({ state: 1, district: 1, block: 1 });
memberDetailsSchema.index({ membershipStatus: 1, membershipType: 1 });
memberDetailsSchema.index({ createdAt: -1 });

module.exports = mongoose.model('MemberDetails', memberDetailsSchema);