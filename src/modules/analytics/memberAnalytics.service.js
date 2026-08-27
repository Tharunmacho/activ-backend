const Product = require('../../models/Product');
const Company = require('../members/company.model');
const StockMovement = require('../members/stockmovement.model');
const Engagement = require('../common/engagement.model');

const { stockState } = require('../../models/Product');
const { dayKey } = Engagement;

/**
 * A member's own operational analytics (BUS-003).
 *
 * Deliberately not part of `analytics.service.js`, which answers association
 * questions ("how many members joined this month") for admins and is mounted
 * behind `requireRole('district_admin', ...)`. This answers "how is MY
 * catalogue doing" for one member about their own data, and every query here is
 * scoped by `userId` from the token.
 *
 * Everything reported is measured. There is no modelled or estimated figure
 * anywhere in this file: a member deciding whether their catalogue is worth
 * maintaining is badly served by a number that was invented to fill a tile.
 */

const DEFAULT_WINDOW_DAYS = 30;

/** The `YYYY-MM-DD` keys for the last N days, oldest first. */
const dayRange = (days) => {
    const keys = [];
    const cursor = new Date();
    cursor.setHours(12, 0, 0, 0);

    for (let i = days - 1; i >= 0; i -= 1) {
        const day = new Date(cursor);
        day.setDate(cursor.getDate() - i);
        keys.push(dayKey(day));
    }
    return keys;
};

class MemberAnalyticsService {
    /**
     * @param {string} userId  MemberDetails._id, as a string.
     * @param {number} days    Window size. Clamped: a member asking for a year
     *                         of daily buckets would render 365 bars in a card
     *                         four inches wide.
     */
    async overview(userId, days = DEFAULT_WINDOW_DAYS) {
        const owner = String(userId || '');
        if (!owner) {
            return this.empty(DEFAULT_WINDOW_DAYS);
        }

        const window = Math.min(Math.max(Number(days) || DEFAULT_WINDOW_DAYS, 7), 90);
        const keys = dayRange(window);
        const since = keys[0];

        const [catalogue, engagement, topProducts, movements, companies] = await Promise.all([
            this.catalogueCounts(owner),
            this.engagementSeries(owner, since, keys),
            this.topViewedProducts(owner, since),
            StockMovement.countDocuments({ userId: owner, createdAt: { $gte: this.sinceDate(window) } })
                .catch(() => 0),
            Company.countDocuments({ userId: owner, isActive: { $ne: false } }).catch(() => 0)
        ]);

        return {
            windowDays: window,
            catalogue,
            engagement,
            topProducts,
            stockMovements: movements,
            companies
        };
    }

    sinceDate(days) {
        const from = new Date();
        from.setDate(from.getDate() - days);
        from.setHours(0, 0, 0, 0);
        return from;
    }

    empty(window) {
        return {
            windowDays: window,
            catalogue: { total: 0, published: 0, unpublished: 0, featured: 0, lowStock: 0, outOfStock: 0, stockValue: 0 },
            engagement: { profileViews: 0, productViews: 0, series: [] },
            topProducts: [],
            stockMovements: 0,
            companies: 0
        };
    }

    /**
     * The catalogue, counted in one pass.
     *
     * `$cond` rather than five `countDocuments` calls for the reason
     * `getProductStats` already documents: each one is a separate round trip to
     * a remote cluster, and this is rendered on a dashboard.
     *
     * The low-stock and out-of-stock arms are the two halves of `stockState`,
     * expressed in aggregation. They have to agree with it — a tile saying
     * "3 low" beside a list showing 4 is worse than no tile.
     */
    async catalogueCounts(owner) {
        const [row] = await Product.aggregate([
            { $match: { userId: owner } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    published: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
                    featured: { $sum: { $cond: [{ $eq: ['$isFeatured', true] }, 1, 0] } },
                    outOfStock: { $sum: { $cond: [{ $lte: [{ $ifNull: ['$stock', 0] }, 0] }, 1, 0] } },
                    lowStock: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $gt: [{ $ifNull: ['$stock', 0] }, 0] },
                                        { $gt: [{ $ifNull: ['$minStock', 0] }, 0] },
                                        { $lte: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$minStock', 0] }] }
                                    ]
                                },
                                1, 0
                            ]
                        }
                    },
                    stockValue: {
                        $sum: {
                            $multiply: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$price', 0] }]
                        }
                    }
                }
            }
        ]).catch(() => []);

        const counts = row || {};
        const total = Number(counts.total || 0);
        const published = Number(counts.published || 0);

        return {
            total,
            published,
            unpublished: Math.max(0, total - published),
            featured: Number(counts.featured || 0),
            lowStock: Number(counts.lowStock || 0),
            outOfStock: Number(counts.outOfStock || 0),
            stockValue: Math.round(Number(counts.stockValue || 0))
        };
    }

    /**
     * Views over the window, split by kind and bucketed per day.
     *
     * Every day in the window appears in the series, including the ones with no
     * views. A chart drawn only from the days that have data compresses a quiet
     * fortnight into a single point and makes a flat month look busy.
     */
    async engagementSeries(owner, since, keys) {
        const rows = await Engagement.aggregate([
            { $match: { ownerId: owner, day: { $gte: since } } },
            { $group: { _id: { day: '$day', kind: '$kind' }, count: { $sum: 1 } } }
        ]).catch(() => []);

        const byDay = new Map(keys.map((day) => [day, { day, profile: 0, product: 0 }]));

        let profileViews = 0;
        let productViews = 0;

        (rows || []).forEach((row) => {
            const day = row._id && row._id.day;
            const kind = row._id && row._id.kind;
            const count = Number(row.count || 0);

            if (kind === 'profile') profileViews += count;
            if (kind === 'product') productViews += count;

            const bucket = byDay.get(day);
            if (bucket && (kind === 'profile' || kind === 'product')) bucket[kind] += count;
        });

        return { profileViews, productViews, series: Array.from(byDay.values()) };
    }

    /** The five most-viewed lines in the window, with their current state. */
    async topViewedProducts(owner, since) {
        const rows = await Engagement.aggregate([
            { $match: { ownerId: owner, kind: 'product', day: { $gte: since } } },
            { $group: { _id: '$targetId', views: { $sum: 1 } } },
            { $sort: { views: -1 } },
            { $limit: 5 }
        ]).catch(() => []);

        if (!rows || !rows.length) return [];

        const products = await Product.find({ _id: { $in: rows.map((row) => row._id) } })
            .select('name category price stock minStock imageUrl isActive')
            .lean()
            .catch(() => []);

        const byId = (products || []).reduce((acc, product) => {
            acc[String(product._id)] = product;
            return acc;
        }, {});

        return rows
            .map((row) => {
                const product = byId[String(row._id)];
                if (!product) return null;

                return {
                    id: String(product._id),
                    name: product.name || '',
                    category: product.category || '',
                    imageUrl: product.imageUrl || '',
                    price: Number(product.price || 0),
                    stock: Number(product.stock || 0),
                    stockState: stockState(product),
                    published: !!product.isActive,
                    views: Number(row.views || 0)
                };
            })
            // A product deleted since it was viewed leaves its engagement rows
            // behind. Dropping it is right: there is nothing to link to.
            .filter(Boolean);
    }
}

module.exports = new MemberAnalyticsService();
module.exports.dayRange = dayRange;
