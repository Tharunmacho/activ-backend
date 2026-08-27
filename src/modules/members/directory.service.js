const MemberDetails = require('./memberdetails.model');
const Company = require('./company.model');
const Product = require('../../models/Product');
const { BUSINESS_TYPES } = require('./businessTypes');
const { escapeRegex, regionPattern } = require('../common/regionMatch');
const { PAID_STATUSES } = require('../common/memberContext');

const MAX_PAGE_SIZE = 50;

const str = (value) => String(value === null || value === undefined ? '' : value).trim();

/**
 * The member directory (DIR-001).
 *
 * Separate from `memberService.getMembers`, which takes whatever query string
 * it is given and hands it straight to `MemberDetails.find` as a filter. That
 * is fine for an admin listing and wrong for a member-facing search in two
 * ways: the caller can filter on any field of the schema including
 * `aadhaarNumber`, and every field of the matched document comes back. This
 * module names the filters it accepts and names the fields it returns.
 *
 * Sector is the filter that makes this more than a listing, and it does not
 * live on the member: a member's line of business is on their COMPANY records.
 * So a sector search runs against `companies` first and narrows the member
 * query by the owners it finds, rather than trying to express the join in one
 * `find`.
 */

/**
 * What a member may see about another member.
 *
 * An allow-list, not a `-password` exclusion. The model carries `aadhaarNumber`
 * (already `select: false`), `paymentId`, `paymentAmount` and
 * `membershipExpiresAt`, none of which are anyone else's business — and an
 * exclusion list silently starts leaking each time a field is added to the
 * schema, which is exactly the kind of change nobody re-reads this file for.
 */
const toDirectoryEntry = (member = {}, companies = [], productCount = 0) => ({
    id: member._id ? String(member._id) : '',
    fullName: member.fullName || '',
    profilePhoto: member.profilePhoto || '',
    city: member.city || '',
    state: member.state || '',
    district: member.district || '',
    block: member.block || '',
    memberType: String(member.memberType || member.registrationType || '').toLowerCase(),
    membershipType: member.membershipType || '',
    memberSince: member.membershipActivatedAt || member.approvedAt || null,
    companies: (companies || []).map((company) => ({
        id: String(company._id),
        businessName: company.businessName || '',
        businessType: company.businessType || '',
        location: company.location || '',
        area: company.area || '',
        logo: company.logo || ''
    })),
    /** The sectors this member trades in — the directory's "Sector" column. */
    sectors: Array.from(new Set(
        (companies || []).map((company) => str(company.businessType)).filter(Boolean)
    )),
    productCount: Number(productCount || 0)
});

/** An anchored region filter, or nothing when the caller left the box empty. */
const regionFilter = (filters = {}) => {
    const out = {};

    ['state', 'district', 'block'].forEach((field) => {
        const pattern = regionPattern(filters[field]);
        if (pattern) out[field] = pattern;
    });

    return out;
};

/**
 * The free-text half of the search.
 *
 * Escaped before it reaches a regex: a member typing `(` into the box gets a
 * 500 otherwise, and one typing a pathological pattern makes the database do
 * the work of matching it. Anchored at the start of a word rather than
 * unanchored `contains`, so searching "raj" finds "Raj Kumar" and "Suraj" does
 * not drown it — and the index on `fullName` can still be used.
 */
const textFilter = (term) => {
    const escaped = escapeRegex(term);
    if (!escaped) return null;

    const pattern = new RegExp('(^|\\s)' + escaped, 'i');
    return { $or: [{ fullName: pattern }, { city: pattern }] };
};

class DirectoryService {
    /** The sectors a member can filter by — the same four the forms offer. */
    listSectors() {
        return BUSINESS_TYPES.slice();
    }

    /**
     * Search the directory.
     *
     * Only members with an active membership are listed. A directory is a
     * member benefit and its entries are a claim that the person is a member;
     * listing an applicant halfway through approval makes that claim on their
     * behalf before the association has.
     */
    async search(filters = {}, page = 1, limit = 20) {
        const size = Math.min(Math.max(Number(limit) || 20, 1), MAX_PAGE_SIZE);
        const current = Math.max(Number(page) || 1, 1);
        const skip = (current - 1) * size;

        const query = {
            membershipStatus: { $in: PAID_STATUSES },
            isActive: { $ne: false },
            ...regionFilter(filters)
        };

        const term = str(filters.q);
        const text = textFilter(term);

        const sector = str(filters.sector);
        const memberType = str(filters.memberType).toLowerCase();

        if (memberType === 'aspirant' || memberType === 'business') {
            query.$or = [{ memberType }, { registrationType: memberType }];
        }

        /*
         * Sector, and free text against a business name, are both answered from
         * `companies` — so they are resolved to a set of owner ids first and
         * folded into the member query as an `_id: { $in: ... }`.
         *
         * The alternative, `$lookup` in an aggregation, would let one query do
         * it — but `companies.userId` is an ObjectId ref while half of this
         * codebase compares member ids as strings, and a `$lookup` that fails
         * to match returns an empty array rather than an error. A search that
         * silently finds nobody is the worst possible failure for this screen.
         */
        const needsCompanyJoin = !!sector || !!term;

        if (needsCompanyJoin) {
            const companyQuery = { isActive: { $ne: false } };

            if (sector) companyQuery.businessType = sector;
            if (term) {
                const escaped = escapeRegex(term);
                if (escaped) companyQuery.businessName = new RegExp('(^|\\s)' + escaped, 'i');
            }

            const owners = await Company.find(companyQuery).distinct('userId').catch(() => []);
            const ownerIds = (owners || []).map(String);

            if (sector) {
                // A sector filter is a hard narrowing: no company in that
                // sector means no results, whatever else matched.
                if (!ownerIds.length) {
                    return { members: [], pagination: { page: current, limit: size, total: 0, pages: 0 } };
                }
                query._id = { $in: owners };

                // With the sector already narrowing by company, free text still
                // has to match the person or their business.
                if (text) query.$and = [text];
            } else if (text) {
                // No sector: a member matches by their own name OR by owning a
                // business whose name matches.
                const byName = text.$or;
                query.$and = [{ $or: byName.concat(ownerIds.length ? [{ _id: { $in: owners } }] : []) }];
            }
        } else if (text) {
            query.$and = [text];
        }

        const [members, total] = await Promise.all([
            MemberDetails.find(query)
                .select('fullName profilePhoto city state district block memberType registrationType ' +
                    'membershipType membershipActivatedAt approvedAt')
                .sort({ membershipActivatedAt: -1, createdAt: -1 })
                .skip(skip)
                .limit(size)
                .lean()
                .catch(() => []),
            MemberDetails.countDocuments(query).catch(() => 0)
        ]);

        const rows = members || [];
        const ids = rows.map((row) => row._id);

        // The companies and product counts for this PAGE only. Loading them for
        // every match would mean a directory of ten thousand members reading
        // ten thousand company records to render twenty rows.
        const [companies, productCounts] = await Promise.all([
            Company.find({ userId: { $in: ids }, isActive: { $ne: false } }).lean().catch(() => []),
            Product.aggregate([
                { $match: { userId: { $in: ids.map(String) }, isActive: true } },
                { $group: { _id: '$userId', count: { $sum: 1 } } }
            ]).catch(() => [])
        ]);

        const companiesByOwner = (companies || []).reduce((acc, company) => {
            const key = String(company.userId);
            (acc[key] = acc[key] || []).push(company);
            return acc;
        }, {});

        const countsByOwner = (productCounts || []).reduce((acc, row) => {
            acc[String(row._id)] = row.count;
            return acc;
        }, {});

        return {
            members: rows.map((row) => toDirectoryEntry(
                row,
                companiesByOwner[String(row._id)] || [],
                countsByOwner[String(row._id)] || 0
            )),
            pagination: {
                page: current,
                limit: size,
                total,
                pages: Math.ceil(total / size) || 0
            }
        };
    }

    /** One member's public directory card, with their catalogue attached. */
    async getEntry(id) {
        const member = await MemberDetails.findOne({
            _id: id,
            membershipStatus: { $in: PAID_STATUSES },
            isActive: { $ne: false }
        })
            .select('fullName profilePhoto city state district block memberType registrationType ' +
                'membershipType membershipActivatedAt approvedAt')
            .lean()
            .catch(() => null);

        if (!member) return null;

        const [companies, products] = await Promise.all([
            Company.find({ userId: member._id, isActive: { $ne: false } }).lean().catch(() => []),
            Product.find({ userId: String(member._id), isActive: true })
                .select('name category price priceUnit imageUrl')
                .limit(24)
                .lean()
                .catch(() => [])
        ]);

        return {
            ...toDirectoryEntry(member, companies, (products || []).length),
            products: (products || []).map((product) => ({
                id: String(product._id),
                name: product.name || '',
                category: product.category || '',
                price: Number(product.price || 0),
                imageUrl: product.imageUrl || ''
            }))
        };
    }
}

module.exports = new DirectoryService();
module.exports.toDirectoryEntry = toDirectoryEntry;
module.exports.textFilter = textFilter;
module.exports.regionFilter = regionFilter;
