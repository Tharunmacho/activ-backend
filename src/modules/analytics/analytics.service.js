const User = require('../auth/auth.model');
const Member = require('../members/memberdetails.model');
const Application = require('../applications/application.model');

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
        }]);

        return stats;
    }

    async getMemberStats() {
        const [total, approved, byDistrict] = await Promise.all([
            Member.countDocuments(),
            Member.countDocuments({ isApproved: true }),
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