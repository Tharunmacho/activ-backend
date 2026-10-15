const ApiError = require('../../core/utils/ApiError');
const Member = require('../members/memberdetails.model');
const normalizePhone = value => require('./botbee.service').normalizePhoneNumber(value || '');
const phoneFor = member => normalizePhone(member?.whatsappNumber || member?.phoneNumber);

function preferences(member = {}) {
    const stored = member.associationUpdatePreferences || {};
    const phone = phoneFor(member);
    return { email: stored.email !== false,
        whatsapp: stored.whatsapp === true && !!stored.whatsappConsentAt && !!phone && stored.whatsappConsentNumber === phone,
        whatsappNumber: member.whatsappNumber || member.phoneNumber || '' };
}
async function get(memberId) {
    const member = await Member.findOne({ _id: memberId, isActive: { $ne: false }, deletedAt: null })
        .select('whatsappNumber phoneNumber associationUpdatePreferences').lean();
    if (!member) throw ApiError.notFound('Member account was not found.');
    return preferences(member);
}
async function update(memberId, body = {}) {
    if (!body || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key => !['email', 'whatsapp'].includes(key) || typeof body[key] !== 'boolean')) {
        throw ApiError.badRequest('Choose email and/or WhatsApp using true or false.');
    }
    const member = await Member.findOne({ _id: memberId, isActive: { $ne: false }, deletedAt: null })
        .select('whatsappNumber phoneNumber associationUpdatePreferences').lean();
    if (!member) throw ApiError.notFound('Member account was not found.');
    const phone = phoneFor(member);
    if (body.whatsapp === true && !/^\d{8,15}$/.test(phone)) throw ApiError.badRequest('Please save a valid WhatsApp number in your profile first.');
    const set = { 'associationUpdatePreferences.updatedAt': new Date() };
    for (const key of ['email', 'whatsapp']) if (Object.hasOwn(body, key)) set[`associationUpdatePreferences.${key}`] = body[key];
    if (body.whatsapp === true) {
        set['associationUpdatePreferences.whatsappConsentAt'] = new Date();
        set['associationUpdatePreferences.whatsappConsentNumber'] = phone;
    }
    // A phone edited while this request was open cannot inherit consent.
    const saved = await Member.findOneAndUpdate({ _id: memberId, isActive: { $ne: false },
        phoneNumber: member.phoneNumber, ...(member.whatsappNumber === undefined ? { whatsappNumber: { $exists: false } } : { whatsappNumber: member.whatsappNumber }),
    }, { $set: set }, { new: true }).select('whatsappNumber phoneNumber associationUpdatePreferences').lean();
    if (!saved) throw ApiError.badRequest('Your contact details changed. Please refresh and save your preferences again.');
    return preferences(saved);
}
module.exports = { get, update, preferences, phoneFor };
