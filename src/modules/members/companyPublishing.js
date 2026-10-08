const mongoose = require('mongoose');
const Company = require('./company.model');
const Member = require('./memberdetails.model');
const Order = require('../payment/paymentorder.model');
const ApiError = require('../../core/utils/ApiError');
const { membershipState } = require('./membershipState');

const activeMember = member => !!member && member.isActive !== false && membershipState(member).state === 'active';
const unlimited = member => activeMember(member) && String(member.membershipTier).toLowerCase() === 'platinum';
const id = value => String(value || '');

function fundedCompanies(orders, now = new Date()) {
    return new Set(orders.filter(order => {
        if (order.status !== 'paid' || order.orderType !== 'company_listing' || !order.companyId || !order.paidAt) return false;
        if (order.membershipType === 'lifetime') return true;
        const end = new Date(order.paidAt);
        end.setFullYear(end.getFullYear() + 1);
        return end > now;
    }).map(order => id(order.companyId)));
}

// Stable selection also bounds concurrent publish requests: two racing writes
// can never make two unfunded companies publicly visible. No records are erased.
function publicationState(member, companies, orders, now = new Date()) {
    const funded = fundedCompanies(orders, now);
    const active = activeMember(member);
    const all = unlimited(member);
    const requested = companies.filter(c => c.isActive !== false).sort((a, b) =>
        new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || id(a._id).localeCompare(id(b._id)));
    const included = requested.find(c => !funded.has(id(c._id)));
    const published = new Set(active ? requested.filter(c => all || funded.has(id(c._id)) || c === included).map(c => id(c._id)) : []);
    return { funded, active, unlimited: all, includedId: included ? id(included._id) : '', published };
}

async function ownerContext(userId) {
    const [member, companies, orders] = await Promise.all([
        Member.findById(userId).select('isActive membershipStatus membershipTier membershipType membershipExpiresAt membershipActivatedAt').lean(),
        Company.find({ userId }).select('_id isActive createdAt').lean(),
        Order.find({ memberId: userId, orderType: 'company_listing', status: 'paid' }).select('companyId orderType status paidAt membershipType').lean()
    ]);
    return publicationState(member, companies, orders);
}

function decorate(company, state) {
    if (!company) return company;
    const raw = company.toObject ? company.toObject() : company;
    const published = state.published.has(id(raw._id));
    const canPublish = state.active && (state.unlimited || state.funded.has(id(raw._id)) || !state.includedId || state.includedId === id(raw._id));
    return { ...raw, status: published ? 'active' : 'inactive', isActive: published,
        publication: { published, canPublish, memberActive: state.active, unlimited: state.unlimited,
            paymentRequired: state.active && !canPublish, publishedCount: state.published.size,
            label: published ? 'Published' : state.active ? 'Not published' : 'Membership required' } };
}

async function decorateOwned(userId, value) {
    const state = await ownerContext(userId);
    return Array.isArray(value) ? value.map(c => decorate(c, state)) : decorate(value, state);
}

async function assertCanPublish(userId, companyId) {
    const state = await ownerContext(userId);
    const result = decorate({ _id: companyId }, state);
    if (!state.active) throw ApiError.forbidden('An active paid membership is required to publish in ACTIV Network.');
    if (!result.publication.canPublish) throw ApiError.badRequest('Your plan includes one company. Pay the membership fee for this additional company, or unpublish your existing company. Lifetime Membership includes multiple companies.');
}

async function publishedIds(ownerIds) {
    if (!ownerIds.length) return [];
    const [members, companies, orders] = await Promise.all([
        Member.find({ _id: { $in: ownerIds } }).select('isActive membershipStatus membershipTier membershipType membershipExpiresAt membershipActivatedAt').lean(),
        Company.find({ userId: { $in: ownerIds } }).select('userId isActive createdAt').lean(),
        Order.find({ memberId: { $in: ownerIds }, orderType: 'company_listing', status: 'paid' }).select('memberId companyId orderType status paidAt membershipType').lean()
    ]);
    const grouped = new Map(members.map(m => [id(m._id), { member: m, companies: [], orders: [] }]));
    companies.forEach(c => grouped.get(id(c.userId))?.companies.push(c));
    orders.forEach(o => grouped.get(id(o.memberId))?.orders.push(o));
    return [...grouped.values()].flatMap(g => [...publicationState(g.member, g.companies, g.orders).published].map(v => new mongoose.Types.ObjectId(v)));
}

async function quote(userId, companyId) {
    if (!mongoose.Types.ObjectId.isValid(companyId)) throw ApiError.notFound('Company not found');
    const company = await Company.findOne({ _id: companyId, userId }).select('businessName').lean();
    if (!company) throw ApiError.notFound('Company not found');
    const state = await ownerContext(userId);
    if (!state.active) throw ApiError.forbidden('Activate or renew your membership before publishing a company.');
    if (decorate(company, state).publication.canPublish) return { paymentRequired: false, companyId: id(company._id), companyName: company.businessName };
    const previous = await Order.findOne({ memberId: userId, orderType: 'membership', status: 'paid' }).sort({ paidAt: -1, createdAt: -1 }).select('planId').lean();
    if (!previous?.planId) throw ApiError.badRequest('Your membership plan needs to be linked by the ACTIV office before an additional company can be priced.');
    const plan = await require('./membershipplan.service').getPlanForPayment(previous.planId);
    if (!plan || !Number.isFinite(plan.amount) || plan.amount <= 0) throw ApiError.badRequest('The current membership fee is unavailable. Please contact the ACTIV office.');
    return { paymentRequired: true, companyId: id(company._id), companyName: company.businessName,
        planId: plan.id, planName: plan.name, amount: plan.amount, membershipType: plan.membershipType,
        term: plan.membershipType === 'lifetime' ? 'One-time payment' : 'One year from payment',
        message: 'This payment publishes one additional company. Your personal membership and its renewal date stay the same.' };
}

module.exports = { activeMember, unlimited, publicationState, decorate, decorateOwned, ownerContext, assertCanPublish, publishedIds, quote };
