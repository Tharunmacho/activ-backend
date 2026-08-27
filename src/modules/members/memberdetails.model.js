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
        /*
         * `aspirant` and `business` belong here, and leaving them out was not
         * cosmetic.
         *
         * `createApplication` derives the role from what the applicant declared
         * and then saves it onto this document. With the enum limited to
         * member/admin that save THREW on every aspirant — and because it threw,
         * the `memberType` and `registrationType` assignments on the same
         * document were abandoned with it. The catch around it logs
         * "Non-fatal error updating user role in DB" and carries on, so the
         * whole thing looked like a warning rather than three fields silently
         * never being written.
         */
        enum: ['member', 'admin', 'aspirant', 'business'],
        default: 'member'
    },

    /*
     * What the applicant declared, stored rather than re-derived.
     *
     * Neither path existed, so Mongoose strict mode dropped both without a
     * word — the same silent-drop that left `memberType` undefined on the
     * application documents. Every screen that wanted to know whether someone
     * was an aspirant had to reconstruct it from `data.registrationType` and
     * `data.doingBusiness` on the application, and two of them reconstructed it
     * differently and disagreed.
     */
    memberType: {
        type: String,
        enum: ['aspirant', 'business'],
        trim: true
    },
    registrationType: {
        type: String,
        enum: ['aspirant', 'business'],
        trim: true
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