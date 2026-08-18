const mongoose = require('mongoose');

// Application Schema with 3-tier approval workflow
const applicationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        required: true,
        index: true
    },
    fullName: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    phone: {
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
    status: {
        type: String,
        enum: ['PENDING', 'Pending-Block', 'Pending-District', 'Pending-State', 'Approved', 'Rejected'],
        default: 'PENDING',
        index: true
    },
    // Admin assignments
    assignedBlockAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BlockAdmin',
        index: true
    },
    assignedDistrictAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DistrictAdmin',
        index: true
    },
    assignedStateAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StateAdmin',
        index: true
    },
    // Approval timestamps
    blockApprovedAt: {
        type: Date
    },
    districtApprovedAt: {
        type: Date
    },
    stateApprovedAt: {
        type: Date
    },
    // Review tracking
    reviewedBy: {
        blockAdmin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'BlockAdmin'
        },
        districtAdmin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'DistrictAdmin'
        },
        stateAdmin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'StateAdmin'
        }
    },
    rejectionReason: {
        type: String,
        trim: true
    },
    rejectedBy: {
        adminId: mongoose.Schema.Types.ObjectId,
        adminType: {
            type: String,
            enum: ['BlockAdmin', 'DistrictAdmin', 'StateAdmin']
        },
        rejectedAt: Date
    },
    // Application data
    data: {
        type: mongoose.Schema.Types.Mixed
    },
    documents: [{
        name: String,
        url: String,
        type: String,
        uploadedAt: Date
    }],
    notes: [{
        adminId: mongoose.Schema.Types.ObjectId,
        adminType: String,
        note: String,
        createdAt: {
            type: Date,
            default: Date.now
        }
    }]
}, {
    collection: 'applications',
    timestamps: true
});

// Compound indexes for admin dashboards
applicationSchema.index({ status: 1, assignedBlockAdmin: 1 });
applicationSchema.index({ status: 1, assignedDistrictAdmin: 1 });
applicationSchema.index({ status: 1, assignedStateAdmin: 1 });
applicationSchema.index({ state: 1, district: 1, block: 1 });
applicationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Application', applicationSchema);