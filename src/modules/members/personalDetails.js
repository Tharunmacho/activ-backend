const ApiError = require('../../core/utils/ApiError');
const { SOCIAL_CATEGORIES, GENDERS, normalizeReligion, isReligionAllowed } = require('./demographicOptions');
const { requiresBlock } = require('../regions/geography');

const PERSONAL_FIELDS = ['fullName', 'email', 'phoneNumber', 'state', 'district', 'block', 'city', 'place', 'religion', 'socialCategory', 'gender'];
const PERSONAL_LABELS = {
    fullName: 'Full name', email: 'Email address', phoneNumber: 'Mobile number', state: 'State',
    district: 'District', block: 'Block', city: 'City / town', place: 'Place',
    religion: 'Religion', socialCategory: 'Social category', gender: 'Gender',
};
const text = value => typeof value === 'string' ? value.trim() : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value)
    ? (typeof value.toObject === 'function' ? value.toObject() : value) : {};

/** Older forms use name/phone. Resolve saved answers without allowing an empty
 * duplicate record to hide the member's actual answer. Never infer demographics. */
function personalFrom(...sources) {
    const result = {};
    for (const source of sources) {
        const data = object(source);
        const canonical = { ...data, fullName: data.fullName ?? data.name, phoneNumber: data.phoneNumber ?? data.phone };
        for (const key of PERSONAL_FIELDS) if (text(canonical[key])) result[key] = text(canonical[key]);
    }
    return result;
}

function normalizePersonal(input) {
    const data = { ...input };
    for (const key of PERSONAL_FIELDS) if (Object.hasOwn(data, key)) data[key] = text(data[key]);
    data.religion = normalizeReligion(data.religion);
    data.gender = GENDERS.find(value => value.toLowerCase() === text(data.gender).toLowerCase()) || '';
    return data;
}

function missingPersonalFields(input, { international = false } = {}) {
    const data = normalizePersonal(input);
    const required = ['fullName', 'email', 'phoneNumber', 'socialCategory', 'religion', 'gender'];
    if (international) required.push('place');
    else {
        required.push('state', 'district', 'city');
        if (requiresBlock(data.state, data.district)) required.push('block');
    }
    return required.filter(key => !data[key]
        || (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data[key]))
        || (key === 'phoneNumber' && !require('../common/phoneNumber').validateMobile(data[key]).ok)
        || (key === 'socialCategory' && !SOCIAL_CATEGORIES.includes(data[key]))
        || (key === 'religion' && !isReligionAllowed(data.religion, data.socialCategory)));
}

function assertCompletePersonal(input, options) {
    const data = normalizePersonal(input);
    const missing = missingPersonalFields(data, options);
    if (missing.length) throw ApiError.badRequest(`Please complete your personal details: ${missing.map(key => PERSONAL_LABELS[key]).join(', ')}.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw ApiError.badRequest('Please enter a valid email address.');
    const phone = require('../common/phoneNumber').validateMobile(data.phoneNumber);
    if (!phone.ok) throw ApiError.badRequest('Please enter a valid mobile number.');
    data.phoneNumber = phone.stored;
    return data;
}

module.exports = { PERSONAL_FIELDS, PERSONAL_LABELS, personalFrom, normalizePersonal, missingPersonalFields, assertCompletePersonal };
