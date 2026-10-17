const ApiError = require('../../core/utils/ApiError');
const { validYear } = require('../members/membershipPlanRules');

const object = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw ApiError.badRequest(`${label} must be an object.`);
    return typeof value.toObject === 'function' ? value.toObject() : value;
};
const boolean = value => typeof value === 'boolean' ? value
    : ['yes', 'true', 1, '1'].includes(value) ? true
    : ['no', 'false', 0, '0'].includes(value) ? false : undefined;

/** The registration Business step asks only these conditional questions.
 * Company, tax and financial-account fields are not membership prerequisites. */
function completeBusiness(input) {
    const data = object(input, 'Business details');
    const doingBusiness = boolean(data.doingBusiness);
    if (doingBusiness === undefined) throw ApiError.badRequest('Complete Business information: answer whether you are doing business.');
    const kind = String(data.registrationType || data.memberType || '').trim().toLowerCase();
    if (!doingBusiness && !['aspirant', 'student'].includes(kind)) throw ApiError.badRequest('Complete Business information: choose Aspirant or Student.');
    const year = String(data.businessCommencementYear ?? '').trim();
    if (doingBusiness && !validYear(year)) throw ApiError.badRequest('Complete Business information: enter a valid business commencement year.');
    return { ...data, doingBusiness, registrationType: doingBusiness ? 'business' : kind, businessCommencementYear: doingBusiness ? year : '' };
}

function normalizeDeclaration(input, { business = true, requireAgreement = true } = {}) {
    const data = object(input, 'Declaration');
    const agreed = boolean(data.agreeToDeclaration ?? data.agreeToTerms ?? data.declarationAccepted);
    if (requireAgreement && agreed !== true) throw ApiError.badRequest('Please accept the declaration before submitting your application.');
    const rawCount = data.sisterConcerns ?? 0;
    if (business && (typeof rawCount !== 'string' && typeof rawCount !== 'number'
        || !/^\d+$/.test(String(rawCount === '' ? 0 : rawCount).trim()))) throw ApiError.badRequest('Enter a whole number of sister concerns, or 0 if none.');
    const sisterConcerns = business ? Number(rawCount || 0) : 0;
    if (!Number.isSafeInteger(sisterConcerns) || sisterConcerns < 0) throw ApiError.badRequest('Enter a whole number of sister concerns, or 0 if none.');
    const names = data.companyNames ?? [];
    if (business && !Array.isArray(names) && typeof names !== 'string') throw ApiError.badRequest('Enter the sister concern company names.');
    const companyNames = business ? (Array.isArray(names) ? names : names.split(',')).map(name => typeof name === 'string' ? name.trim() : '').filter(Boolean) : [];
    if (business && companyNames.length !== sisterConcerns) throw ApiError.badRequest('Enter one company name for each sister concern, or correct the number of sister concerns.');
    return { ...data, sisterConcerns, companyNames, agreeToDeclaration: agreed === true };
}

/** Explicit submitted blanks win over saved answers. Only the authenticated
 * applicant's own forms may be supplied as saved values by the caller. */
function completeSections(data, savedBusiness = {}, savedDeclaration = {}, top = {}) {
    const suppliedBusiness = data.businessInfo ?? data.business ?? {};
    const suppliedDeclaration = data.declaration ?? {};
    const business = { ...object(savedBusiness || {}, 'Business details'), ...object(suppliedBusiness, 'Business details') };
    const declaredKind = data.registrationType || data.memberType || top.registrationType || top.memberType;
    if (!Object.hasOwn(suppliedBusiness, 'registrationType') && declaredKind) business.registrationType = declaredKind;
    const businessInfo = completeBusiness(business);
    const declaration = normalizeDeclaration({ ...object(savedDeclaration || {}, 'Declaration'), ...object(suppliedDeclaration, 'Declaration') }, { business: businessInfo.doingBusiness });
    return { businessInfo, declaration };
}

module.exports = { completeBusiness, normalizeDeclaration, completeSections, boolean };
