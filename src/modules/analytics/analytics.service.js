const User = require('../auth/auth.model');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');
const { normalizeStatus } = require('../common/applicationStatus');

// A PAID membership. 'approved' is the application's verdict, not a payment.
const PAID_MEMBERSHIP_STATUSES = ['active', 'completed'];

class AnalyticsService {
    async getUserGrowth(period = '30d') {
        const days = parseInt(period);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const users = await User.aggregate([
            { $match: { createdAt: { $gte: startDate } } },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    count: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        return users;
    }

    async getApplicationStats() {
        const stats = await Application.aggregate([{
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }]).catch(() => []);

        /*
         * Folded through `normalizeStatus`: live rows carry three spellings of
         * the same status ('Pending-Block', 'pending_block_approval',
         * 'approved'), and grouping on the raw string split one bucket into
         * several. Same `[{ _id, count }]` shape as before.
         */
        const folded = new Map();
        (stats || []).forEach((row) => {
            const key = normalizeStatus(row?._id);
            folded.set(key, (folded.get(key) || 0) + Number(row?.count || 0));
        });
        return [...folded.entries()].map(([_id, count]) => ({ _id, count }));
    }

    async getMemberStats() {
        const [total, approved, byDistrict] = await Promise.all([
            Member.countDocuments(),
            // Paid members. There is no `isApproved` on MemberDetails, so the
            // old filter matched nothing and this was always 0.
            Member.countDocuments({ membershipStatus: { $in: PAID_MEMBERSHIP_STATUSES } }),
            Member.aggregate([
                { $group: { _id: '$district', count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 10 }
            ])
        ]);

        return { total, approved, byDistrict };
    }
}

module.exports = new AnalyticsService();