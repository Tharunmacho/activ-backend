const mongoose = require('mongoose');
const Company = require('./company.model');
const Order = require('../payment/paymentorder.model');
const ApiError = require('../../core/utils/ApiError');
const publishing = require('./companyPublishing');
const { membershipNumberFor, prepareMembershipNumber } = require('./memberNumber');
const { membershipIdCategory } = require('./membershipIdCategory');
const { annualExpiry, lastValidDay } = require('./membershipDates');

// Called only with a server-verified paid order. The compare-and-set keeps the
// first ID if two payment callbacks or certificate reads arrive together.
async function ensureCompanyNumber(order) {
    if (!order || order.orderType !== 'company_listing' || order.status !== 'paid' || !order.paidAt) {
        throw ApiError.forbidden('A verified company payment is required');
    }
    const company = await Company.findOne({ _id: order.companyId, userId: order.memberId }).lean();
    if (!company) throw ApiError.notFound('Company not found');
    if (company.membershipNumber) return company;
    const number = await prepareMembershipNumber({
        _id: company._id, membershipActivatedAt: order.paidAt,
    }, '', membershipIdCategory({}, { planId: order.planId, membershipType: order.membershipType, planAudience: order.planAudience }));
    const saved = await Company.findOneAndUpdate({
        _id: company._id, userId: order.memberId,
        $or: [{ membershipNumber: { $exists: false } }, { membershipNumber: '' }, { membershipNumber: null }],
    }, { $set: { membershipNumber: number, membershipActivatedAt: order.paidAt } }, { new: true });
    if (saved) return saved.toObject ? saved.toObject() : saved;
    const winner = await Company.findOne({ _id: company._id, userId: order.memberId }).lean();
    if (!winner?.membershipNumber) throw ApiError.conflict('The company membership ID is being prepared. Please retry.');
    return winner;
}

async function certificateCompany(member, companyId) {
    if (!mongoose.Types.ObjectId.isValid(String(companyId || ''))) throw ApiError.notFound('Company not found');
    const owner = member._id;
    let company = await Company.findOne({ _id: companyId, userId: owner }).lean();
    if (!company) throw ApiError.notFound('Company not found');
    const state = await publishing.ownerContext(owner);
    if (!state.active) throw ApiError.forbidden('An active membership is required for a company certificate');
    if (state.unlimited || state.includedId === String(company._id)) {
        return { company, membershipNumber: membershipNumberFor(member), separate: false };
    }
    if (!state.funded.has(String(company._id))) {
        throw ApiError.forbidden('Pay the membership plan for this additional company to issue its certificate and make it visible to others.');
    }
    const orders = await Order.find({ memberId: owner, companyId: company._id, orderType: 'company_listing', status: 'paid' })
        .sort({ paidAt: -1, _id: -1 }).lean();
    const now = new Date();
    const paid = orders.find(order => publishing.fundedCompanies([order], now).has(String(company._id)));
    if (!paid) throw ApiError.forbidden('An active paid company plan is required for this certificate');
    // Existing paid listings created before per-company IDs are upgraded on an
    // authenticated owner read. No primary member record or ID is rewritten.
    company = await ensureCompanyNumber(paid);
    return { company, membershipNumber: company.membershipNumber, separate: true,
        membershipType: paid.membershipType,
        activatedAt: company.membershipActivatedAt || paid.paidAt,
        validUntil: paid.membershipType === 'lifetime' ? null : lastValidDay(annualExpiry(paid.paidAt)) };
}

module.exports = { ensureCompanyNumber, certificateCompany };
