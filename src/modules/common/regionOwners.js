const MemberDetails = require('../members/memberdetails.model');
const { regionPattern } = require('./regionMatch');

/**
 * Turn a region into the set of members registered in it.
 *
 * Products and companies carry no region of their own — a product row has a
 * `userId` and a `companyId` and no idea where either of them is. The region
 * tree the entire platform is filtered on lives on the member record. So every
 * region-scoped catalogue query has to resolve the region to a set of owner ids
 * first and match on those.
 *
 * Written once here because three callers need it — the member directory, the
 * product Discover search and the company Discover search — and three copies of
 * a region join is how they end up disagreeing about whether `block` narrows
 * within `district` or replaces it.
 *
 * The matching itself is `regionPattern` from `regionMatch.js`: anchored and
 * case-insensitive with regex metacharacters escaped, which is what keeps
 * "Tamil Nadu" and "tamil  nadu" from becoming two regions each holding half a
 * queue. See the admin-first region rules in CLAUDE.md.
 */

/**
 * `null` means "no region was asked for" — NOT "nobody matched".
 *
 * The distinction is the whole contract of this function and the one thing a
 * caller must not collapse. `[]` is a real answer meaning nobody is registered
 * in that region, and a caller that treats it as "no filter" turns an
 * unpopulated block into a network-wide listing — showing a member every
 * product in the association at the exact moment they asked to see only their
 * own block's.
 *
 * @returns {Promise<string[]|null>} owner ids as strings, or `null` for no filter
 */
const regionOwnerIds = async (filters = {}) => {
    const region = {};

    ['state', 'district', 'block'].forEach((field) => {
        const pattern = regionPattern(filters[field]);
        if (pattern) region[field] = pattern;
    });

    if (!Object.keys(region).length) return null;

    const owners = await MemberDetails.find({ ...region, isActive: { $ne: false } })
        .select('_id')
        .lean()
        .catch(() => []);

    return (owners || []).map((row) => String(row._id));
};

module.exports = { regionOwnerIds };
