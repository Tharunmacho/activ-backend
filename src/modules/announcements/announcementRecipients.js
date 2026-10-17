const mongoose = require('mongoose');
const ApiError = require('../../core/utils/ApiError');
const { builtinKeys } = require('../common/updateVariables');
const idValid = value => /^[a-f\d]{24}$/i.test(String(value || ''));
const MEMBER_FILTER = { isActive: { $ne: false }, deletedAt: null,
    role: { $nin: ['super_admin', 'state_admin', 'district_admin', 'block_admin', 'cms_admin', 'events_admin', 'attendance_admin'] } };
function matchesSelected(update, recipient = {}) {
    return update.recipientMode !== 'selected' || (update.memberIds || []).some(id => String(id) === String(recipient._id || recipient.id || ''));
}
function selectedClause(recipient = {}) {
    const id = String(recipient._id || recipient.id || '');
    return { $or: [{ recipientMode: { $ne: 'selected' } }, ...(idValid(id) ? [{ recipientMode: 'selected', memberIds: new mongoose.Types.ObjectId(id) }] : [])] };
}
const parseArray = (value, label, max) => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch (_) { throw ApiError.badRequest(`Invalid ${label}.`); } }
    if (!Array.isArray(value) || value.length > max) throw ApiError.badRequest(`Choose at most ${max} ${label}.`);
    return value;
};
function sanitizeRecipients(payload, out) {
    if (payload.recipientMode !== undefined) {
        if (!['audience', 'selected'].includes(payload.recipientMode)) throw ApiError.badRequest('Choose all eligible members or specific members.');
        out.recipientMode = payload.recipientMode;
    }
    if (payload.memberIds !== undefined) {
        const ids = parseArray(payload.memberIds, 'members', 500);
        if (ids.some(id => typeof id !== 'string' || !idValid(id))) throw ApiError.badRequest('Choose valid members.');
        out.memberIds = [...new Set(ids.map(id => id.toLowerCase()))];
    }
    if (payload.variables !== undefined) {
        const rows = parseArray(payload.variables, 'variables', 40), seen = new Set();
        const value = input => {
            if (input !== undefined && typeof input !== 'string') throw ApiError.badRequest('Variable values must be text.');
            const text = (input || '').trim();
            if (text.length > 1000) throw ApiError.badRequest('Keep each variable value within 1,000 characters.');
            return text;
        };
        let totalOverrides = 0;
        out.variables = rows.map(row => {
            const key = String(row?.key || '').trim().toLowerCase();
            if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) || seen.has(key)) throw ApiError.badRequest('Variable names must be unique: start with a letter, then use letters, numbers or underscores.');
            seen.add(key);
            const overrides = parseArray(row.overrides || [], 'member values per variable', 500);
            totalOverrides += overrides.length;
            if (totalOverrides > 2000) throw ApiError.badRequest('Use at most 2,000 member-specific variable values per update.');
            const ids = new Set();
            return { key, defaultValue: value(row.defaultValue), overrides: overrides.map(entry => {
                const id = String(entry?.memberId || '').toLowerCase();
                if (!idValid(id) || ids.has(id)) throw ApiError.badRequest('Each variable can have only one value per valid member.');
                ids.add(id); return { memberId: id, value: value(entry.value) };
            }) };
        });
    }
}
async function validateRecipients(data, current = {}) {
    const merged = { ...current, ...data };
    if (merged.recipientMode === 'selected' && !merged.memberIds?.length) throw ApiError.badRequest('Choose at least one specific member.');
    if (merged.recipientMode === 'selected' && merged.includeVisitors) throw ApiError.badRequest('An update for specific members cannot be public.');
    // Eligibility is always checked again at read/send time, even after validation.
    if (data.memberIds || data.variables) {
        const ids = [...new Set([...(merged.memberIds || []).map(String), ...(merged.variables || []).flatMap(row => (row.overrides || []).map(entry => String(entry.memberId)))])];
        if (ids.length && await require('../members/memberdetails.model').countDocuments({ _id: { $in: ids }, ...MEMBER_FILTER }) !== ids.length) throw ApiError.badRequest('Some selected members are no longer available. Remove them or choose active members.');
    }
    const defined = new Set((merged.variables || []).map(row => row.key));
    const used = [...['title', 'summary', 'body', 'bannerAlt', 'attachmentLabel'].map(key => merged[key] || '').join('\n').matchAll(/(?<!\{)\{\s*([a-z][a-z0-9_]{0,39})\s*\}(?!\})/gi)].map(match => match[1].toLowerCase());
    const unknown = [...new Set(used)].filter(key => !builtinKeys.has(key) && !defined.has(key));
    if (merged.status === 'published' && unknown.length) throw ApiError.badRequest(`Add these custom variables first: ${unknown.join(', ')}.`);
}
async function loadRecipient(recipient = {}) {
    const id = String(recipient._id || recipient.id || '');
    if (!idValid(id)) return recipient;
    const [member, receipt, business, company] = await Promise.all([
        require('../members/memberdetails.model').findById(id).select('fullName email phoneNumber membershipNumber membershipType membershipTier membershipStatus membershipExpiresAt membershipActivatedAt memberType registrationType paymentId state district block city country place isActive deletedAt role').lean(),
        require('../payment/paymentorder.model').findOne({ memberId: id, orderType: 'membership', status: 'paid' }).sort({ paidAt: -1, createdAt: -1 }).select('amount currency planId planAudience upgradeKind').lean(),
        require('../members/businessinfo.model').findOne({ userId: id }).select('organizationName organisationName companyName businessName').lean(),
        require('../members/company.model').findOne({ userId: id, isActive: { $ne: false } }).sort({ createdAt: 1, _id: 1 }).select('businessName').lean(),
    ]);
    if (!member) return { id };
    if (receipt?.planId && !receipt.planAudience && !receipt.upgradeKind) receipt.planAudience = (await require('../members/membershipplan.model').findOne({ key: receipt.planId }).select('audience').lean())?.audience || '';
    const profile = /^(pay_|OFF-)/.test(member.paymentId || '') && !receipt ? { ...member, membershipStatus: 'pending' } : member;
    let lastPaidFee = '';
    if (receipt && Number.isFinite(receipt.amount)) {
        try { lastPaidFee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: receipt.currency || 'INR' }).format(receipt.amount); } catch (_) { /* Invalid stored currency is unavailable. */ }
    }
    return { ...member, id, ...require('../common/memberAudience').memberAccess(profile, receipt),
        companyName: require('../members/certificateIdentity').certificateIdentity(business, company).companyName, lastPaidFee };
}
module.exports = { MEMBER_FILTER, matchesSelected, selectedClause, sanitizeRecipients, validateRecipients, loadRecipient, idValid };
