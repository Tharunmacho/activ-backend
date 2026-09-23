const mongoose = require('mongoose');
const { normalizeStatus } = require('../common/applicationStatus');

/**
 * One tier's verdict slot.
 *
 * A factory rather than a shared sub-schema instance: three paths pointing at
 * one schema object share its options, and `_id: false` on a shared instance is
 * the kind of coupling that makes a later change to one tier silently change
 * all three.
 *
 * `decidedAt` and not `at`, to match `approvedBy.approvedAt` and
 * `rejectedBy.rejectedAt` — the two fields a reader will compare it against.
 */
const reviewSlot = () => ({
    decision: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },
    adminId: mongoose.Schema.Types.ObjectId,
    adminType: {
        type: String,
        enum: ['BlockAdmin', 'DistrictAdmin', 'StateAdmin', 'SuperAdmin']
    },
    decidedAt: Date,
    /** Why it was rejected. Empty on an approval. */
    reason: { type: String, trim: true },
    /**
     * TRUE when this tier did not act itself — a HIGHER tier's approval carried
     * it. See the cascade note in `application.service.decide()`.
     *
     * Recorded rather than left implicit because "the Block Admin approved
     * this" and "the State Admin approved this, so the Block's step is
     * satisfied" are different facts, and an audit that cannot tell them apart
     * is an audit that says a block admin reviewed a file they never opened.
     * `adminType` still names who actually signed.
     */
    auto: { type: Boolean, default: false }
});

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
    /*
     * What kind of membership this is.
     *
     * `applicationService.createApplication` has always set all three of these
     * on the document it saves, and none of them was declared — so Mongoose
     * strict mode dropped every one, silently, on every application ever
     * created. `buildApplicant` reads `application.registrationType` and
     * `application.memberType` when deciding whether an applicant is an
     * aspirant; both were permanently `undefined`, and the decision fell
     * through to the copies inside `data`, which survive only because `data`
     * is a Mixed path that strict mode does not police.
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
    /** The role the applicant is granted on approval. */
    role: {
        type: String,
        trim: true
    },

    /**
     * `Pending` until somebody decides, then `Approved` or `Rejected`.
     *
     * The three tier-named pending values are still in the enum because rows
     * carrying them are still in the collection — Mongoose validates on save,
     * so dropping them would make every legacy document unsaveable the first
     * time anything touched it. Nothing writes them any more. `normalizeStatus`
     * folds all four to `Pending` on the way out, so no reader has to know the
     * difference. See `common/applicationStatus.js`.
     */
    status: {
        type: String,
        enum: ['Pending', 'PENDING', 'Pending-Block', 'Pending-District', 'Pending-State', 'Approved', 'Rejected'],
        default: 'Pending',
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
    /**
     * WHO APPROVED IT, which is now a real question.
     *
     * Under the sequential workflow the answer was "all three, in order", and
     * the three `*ApprovedAt` timestamps above said so. One approval ends the
     * review now, so exactly one tier signs off and the other two never do —
     * the timestamps alone can no longer name them. `SuperAdmin` is in the enum
     * because a super admin acts as themselves rather than in a tier's place.
     */
    approvedBy: {
        adminId: mongoose.Schema.Types.ObjectId,
        adminType: {
            type: String,
            enum: ['BlockAdmin', 'DistrictAdmin', 'StateAdmin', 'SuperAdmin']
        },
        approvedAt: Date
    },
    rejectedBy: {
        adminId: mongoose.Schema.Types.ObjectId,
        adminType: {
            type: String,
            enum: ['BlockAdmin', 'DistrictAdmin', 'StateAdmin', 'SuperAdmin']
        },
        rejectedAt: Date
    },
    /**
     * ONE VERDICT PER TIER — see `common/tierReviews.js` for the whole rule.
     *
     * The Block, District and State admin of the applicant's region each record
     * their own answer here. `status` above is still the APPLICATION's outcome
     * and is written only by the State (or the Super Admin filling that seat);
     * the block and district slots are endorsements, and signing one changes
     * nothing about whether the applicant is a member.
     *
     * Absent on every row written before this existed, which is why every read
     * goes through `tierReviews.tierVerdict()` — it falls back to `approvedBy` /
     * `rejectedBy` for the one tier that actually signed a legacy decision, and
     * leaves the other two genuinely undecided. Never read `reviews.x.decision`
     * directly: a legacy row answers `undefined` for the tier that approved it.
     *
     * No migration is needed or wanted. Backfilling these slots would have to
     * invent verdicts for two tiers that never gave one.
     */
    reviews: {
        block: reviewSlot(),
        district: reviewSlot(),
        state: reviewSlot()
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

// Middleware to backfill required fields on legacy documents
applicationSchema.pre('validate', function(next) {
    if (!this.fullName && this.get('memberName')) {
        this.fullName = this.get('memberName');
    }
    if (!this.email && this.get('memberEmail')) {
        this.email = this.get('memberEmail');
    }
    if (!this.phone && this.get('memberPhone')) {
        this.phone = this.get('memberPhone');
    }
    // Final fallback so validation doesn't crash on completely malformed legacy rows
    if (!this.fullName) this.fullName = 'Unknown Applicant';
    if (!this.email) this.email = 'unknown@example.com';
    if (!this.phone) this.phone = '0000000000';

    /*
     * FOLD A LEGACY STATUS SPELLING TO THE CANONICAL ONE, ON THE WAY TO DISK.
     *
     * Live rows carry spellings the enum above has never listed —
     * `pending_district_approval`, `pending_block`, bare `approved` — written by
     * builds that predate it. Reads were always safe, because every read goes
     * through `normalizeStatus`. Writes were safe too, but only by accident:
     * the one path that saved such a row set `status` to a valid value in the
     * same breath, so the invalid spelling never reached the validator.
     *
     * That accident ended when a Block or District verdict became something you
     * could record WITHOUT changing the status. Saving the endorsement then
     * validated the status it had not touched, and Mongoose refused the whole
     * document: `pending_district_approval is not a valid enum value`. A real
     * applicant in the live collection became one no admin could endorse.
     *
     * Folding here rather than widening the enum, because the goal is for those
     * spellings to stop existing. `normalizeStatus` is the same function every
     * reader already uses, so this changes what is STORED to match what every
     * reader has always SEEN — and only for a document something was already
     * writing to.
     */
    if (this.status) {
        const canonical = normalizeStatus(this.status);
        if (canonical && canonical !== this.status) this.status = canonical;
    }

    next();
});

module.exports = mongoose.model('Application', applicationSchema);