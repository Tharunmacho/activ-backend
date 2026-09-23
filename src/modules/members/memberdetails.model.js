const mongoose = require('mongoose');
const { ALL_SOCIAL_CATEGORIES, GENDERS } = require('./demographicOptions');

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
    /**
     * The number this member is reachable on over WhatsApp.
     *
     * DECLARED, not just written. Mongoose strict mode drops a path that is not
     * on the schema and reports nothing — the write returns success and the
     * field is simply absent afterwards. That is the failure the member
     * collections in this project have been bitten by repeatedly (see the
     * collection/key table in CLAUDE.md), and an undeclared `whatsappNumber`
     * would land in exactly the same hole: the form collects it, the service
     * saves it, the response says 201, and the column is empty forever.
     *
     * Optional on purpose. Every member already in `users` predates this field,
     * and `required: true` would make every one of their profile saves fail
     * validation on a value they were never asked for. New registrations do
     * require it, at the registration validator, which is the one place where
     * the applicant is actually in front of the form.
     *
     * Normalised by `common/phoneNumber.validateMobile` before it gets here, so
     * `+91 98765 43210` and `09876543210` do not become two different members'
     * worth of data.
     *
     * TWO SHAPES LIVE IN THIS COLUMN, and the difference is the point:
     *
     *     9876543210       an Indian number — the bare ten national digits
     *     +442071234567    anything else — full E.164, and the '+' says so
     *
     * Uniform E.164 would have been tidier and would have rewritten every row
     * already here, breaking `botbeeWebhook.findMemberByPhone` and every lookup
     * keyed on ten digits. A bare ten digits therefore still means exactly what
     * it has always meant, and a leading '+' is the unambiguous marker for a
     * number that is not Indian. Match on both, never on length alone.
     */
    whatsappNumber: {
        type: String,
        trim: true,
        default: ''
    },
    state: {
        type: String,
        required: function requiredUnlessInternational() { return this.isInternational !== true; },
        trim: true,
        index: true
    },
    district: {
        type: String,
        required: function requiredUnlessInternational() { return this.isInternational !== true; },
        trim: true,
        index: true
    },
    block: {
        type: String,
        required: function requiredUnlessInternational() { return this.isInternational !== true; },
        trim: true,
        index: true
    },
    /*
     * MEMBERS OUTSIDE INDIA.
     *
     * Set on the server, from the phone number — a valid number with a
     * country code other than +91 — and never from anything the client
     * claims. Such a member has no state, district or block: the region
     * tree is India's, and asking a member in Dubai to pick a Tamil Nadu
     * block would file them in a queue that is not theirs. They give a
     * free-text `place` instead, which the certificate and the dashboard
     * print, and their application has no region, so no tier admin's
     * geofence matches it and it goes straight to the Super Admin.
     */
    isInternational: { type: Boolean, default: false, index: true },
    /** The country, named from the phone number's code — "United Arab Emirates". */
    country: { type: String, trim: true, default: '' },
    /** Where they are, as they wrote it — "Dubai, UAE". */
    place: { type: String, trim: true, default: '' },
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
        /*
         * The withdrawn `Christian ST` is still in this enum on purpose.
         *
         * Mongoose validates an enum on every save of the whole document, not
         * only when the path changes. Rows already hold that value, so removing
         * it would make an unrelated edit — a phone number, a membership expiry
         * — fail validation on a field nobody touched. It is off the dropdowns
         * instead. See `demographicOptions.js`.
         */
        enum: ALL_SOCIAL_CATEGORIES,
        trim: true,
        default: ''
    },
    /**
     * Male / Female.
     *
     * DECLARED, like `whatsappNumber` above and for the same reason: an
     * undeclared path is dropped by strict mode with a 200 and a success
     * message, and the form would collect a gender that was never stored.
     *
     * `''` is in the enum because every member registered before this field
     * existed has no answer, and `required` would fail their next profile save
     * on a question they were never asked.
     */
    gender: {
        type: String,
        enum: [...GENDERS, ''],
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
     * THE MEMBERSHIP NUMBER, AND THE THIRD FIELD LOST THE SAME WAY.
     *
     * Undeclared, so strict mode dropped it on every write and a Mongoose READ
     * never exposed it either. Both controllers derive the number with the same
     * fallback —
     *
     *     member.membershipNumber || String(member._id).slice(-8).toUpperCase()
     *
     * — and `member.controller.js` carries a comment promising the dashboard
     * and the certificate "cannot differ" because of it. They did. The
     * certificate loads with `.lean()`, which returns the raw document and
     * therefore the real number; the profile loads a Mongoose document, where
     * an undeclared path does not exist, so the fallback always won. One member,
     * two different membership numbers, on the two screens most likely to be
     * shown to somebody else.
     *
     * The fallback stays: it is what gives a member with no assigned number a
     * stable id rather than a blank field.
     */
    membershipNumber: {
        type: String,
        trim: true,
        index: true
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