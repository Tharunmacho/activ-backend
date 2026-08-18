const MemberDetails = require('./memberdetails.model');
const User = require('../auth/auth.model');
const ApiError = require('../../core/utils/ApiError');
const cacheClient = require('../../core/cache/cacheClient');
const { CACHE_KEYS, CACHE_TTL } = require('../../core/cache/cacheKeys');

class MemberService {
    async createOrUpdateMember(userId, memberData) {
        let member = await MemberDetails.findById(userId);

        if (member) {
            Object.assign(member, memberData);
        } else {
            member = new MemberDetails({ _id: userId, ...memberData });
        }

        member.profileCompletion = this.calculateProfileCompletion(member);
        await member.save();
        await cacheClient.del(CACHE_KEYS.MEMBER(userId));

        return member;
    }

    async getMemberByUserId(userId) {
        const cached = await cacheClient.get(CACHE_KEYS.MEMBER(userId));
        if (cached) return cached;

        const member = await MemberDetails.findById(userId).select('-password');
        await cacheClient.set(CACHE_KEYS.MEMBER(userId), member, CACHE_TTL.MEDIUM);

        return member;
    }

    async getMembers(filter = {}, page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const members = await MemberDetails.find(filter)
            .select('-password')
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await MemberDetails.countDocuments(filter);

        return { members, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
    }

    calculateProfileCompletion(member) {
        const fields = ['profilePhoto', 'state', 'district', 'city', 'businessName'];
        const completed = fields.filter(field => member[field]).length;
        return Math.round((completed / fields.length) * 100);
    }
}

module.exports = new MemberService();