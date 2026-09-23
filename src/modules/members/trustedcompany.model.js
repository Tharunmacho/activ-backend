const mongoose = require('mongoose');

/**
 * TRUST LIST — the companies a member has kept from Discover.
 *
 * A member searches the network, finds suppliers worth remembering, and marks
 * them. Without this the only way back to a company found last week is to
 * remember the search that surfaced it.
 *
 * A JOIN COLLECTION, not an array on the member.
 *
 * An array of ids on `MemberDetails` would have been fewer lines. It is the
 * wrong shape for three reasons, and all three arrive later:
 *
 *   - Concurrency. `$push` on a member document from two tabs is a lost update;
 *     an upsert on a compound-unique pair cannot be.
 *   - The reverse question. "Who trusts this company?" is the number the
 *     company's own page wants to show, and against an array that is a scan of
 *     every member in the platform. Here it is an indexed count.
 *   - When it was added. An array of ids records order, not dates, so "recently
 *     trusted" is unanswerable — and re-adding a removed entry silently jumps
 *     it to the end of the list rather than being dated today.
 *
 * The pair is uniquely indexed, so trusting the same company twice is a no-op
 * rather than a duplicate row. Adds go through `updateOne({ upsert: true })`,
 * which makes the operation idempotent — a double-click, a retried request or a
 * stale button state cannot produce two rows.
 */
const trustedCompanySchema = new mongoose.Schema({
    /** The member doing the trusting. */
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'MemberDetails',
        required: true,
        index: true
    },
    /** The company being trusted. */
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    /**
     * A private note — "met at the Coimbatore expo", "quoted 12% under".
     *
     * Optional, and visible only to the member who wrote it. A trust list with
     * no room for why is a list of names nobody can act on six months later.
     */
    note: {
        type: String,
        trim: true,
        default: '',
        maxlength: 500
    }
}, {
    collection: 'trusted companies',
    timestamps: true
});

// One row per (member, company). See the note above on idempotent adds.
trustedCompanySchema.index({ userId: 1, companyId: 1 }, { unique: true });

module.exports = mongoose.model('TrustedCompany', trustedCompanySchema);
