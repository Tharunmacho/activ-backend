const mongoose = require('mongoose');

// Activities Schema
const activitySchema = new mongoose.Schema({
    memberId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        required: true,
        index: true
    },
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberAuth',
        index: true
    },
    activityType: {
        type: String,
        enum: [
            'profile_update',
            'application_submitted',
            'application_approved',
            'application_rejected',
            'product_created',
            'product_updated',
            'connection_request_sent',
            'connection_request_accepted',
            'document_uploaded',
            'payment_made',
            'membership_activated',
            'membership_renewed'
        ],
        required: true,
        index: true
    },
    entityType: {
        type: String,
        enum: ['Application', 'Product', 'Connection', 'Payment', 'Document', 'Profile'],
        index: true
    },
    entityId: {
        type: mongoose.Schema.Types.ObjectId,
        index: true
    },
    description: {
        type: String,
        trim: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed
    }
}, {
    collection: 'activities',
    timestamps: true
});

// Compound indexes
activitySchema.index({ memberId: 1, createdAt: -1 });
activitySchema.index({ companyId: 1, createdAt: -1 });
activitySchema.index({ activityType: 1, createdAt: -1 });

module.exports = mongoose.model('Activity', activitySchema);