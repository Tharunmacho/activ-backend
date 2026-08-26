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
        enum: ['pending', 'approved', 'active', 'expired', 'cancelled'],
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
    /*
     * What paid for the membership.
     *
     * `POST /payment/complete` has always written both of these, and neither
     * was declared — so Mongoose strict mode dropped them on every payment and
     * no record survived of which transaction bought which membership. The
     * write reported success either way, which is why it went unnoticed: the
     * response even echoes the updated document, and the two fields are simply
     * absent from it.
     */
    paymentId: {
        type: String,
        trim: true
    },
    lastPaymentDate: {
        type: Date
    },
    /*
     * Dropped in the same way, by the same mechanism.
     *
     * `processPaymentWebhook` and `renewMembership` both write these two, and
     * neither was declared. `membershipExpiresAt` is the one that matters:
     * `renewMembership` even READS it back to extend from the current expiry,
     * so every renewal extended from today instead — a member renewing early
     * silently lost the time they had left.
     */
    membershipExpiresAt: {
        type: Date
    },
    paymentAmount: {
        type: Number,
        min: 0
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