const asyncHandler = require('../../core/utils/asyncHandler');
const ApiError = require('../../core/utils/ApiError');
const { resolveMemberContext, ADMIN_ROLES } = require('./memberContext');

/**
 * ============================================================================
 * THIS ROUTE IS A MEMBERSHIP BENEFIT
 * ============================================================================
 *
 * For the handful of endpoints that serve something the membership BUYS — the
 * member directory, and whatever follows it — rather than something every
 * signed-in applicant may read.
 *
 * ------------------------------------------------- read from the database
 *
 * Through `resolveMemberContext`, which reads `membershipStatus` off the member
 * record rather than the token. Two reasons, and the second is the one that
 * bites:
 *
 *   - most member tokens are minted from `{ _id, email, role }` alone, so the
 *     status is not in them to read;
 *   - the status CHANGES during a token's lifetime. A member who pays at noon
 *     would keep an unpaid token, and an unpaid view of the association, until
 *     it expired.
 *
 * ------------------------------------------------------------ admins pass
 *
 * An administrator is not a paying member and has every reason to open the
 * directory — they review the applications that fill it. `ADMIN_ROLES` is the
 * same list the rest of this module uses.
 *
 * ------------------------------------------------------------- the answer
 *
 * 403 with a sentence naming what is missing, not 401. A 401 tells a client its
 * SESSION is wrong, and the axios layer on the website reacts to one by
 * clearing the token and bouncing to the sign-in page — so an applicant who
 * opened a paid screen would be signed out, with no idea why.
 */
const requirePaidMembership = asyncHandler(async(req, res, next) => {
    if (ADMIN_ROLES.includes(String(req.user?.role || ''))) return next();

    const viewer = await resolveMemberContext(req);
    if (viewer?.isPaid) return next();

    throw ApiError.forbidden(
        'This is a membership benefit. Complete your membership to open it.',
    );
});

module.exports = { requirePaidMembership };
