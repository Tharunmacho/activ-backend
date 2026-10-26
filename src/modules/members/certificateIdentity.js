const text = value => typeof value === 'string' ? value.trim() : '';

// Prefer the company declared in the membership application. A company added
// later through the business dashboard is the fallback for older profiles.
function certificateIdentity(business, company, { selectedCompany = false } = {}) {
    if (selectedCompany) return { companyName: text(company?.businessName),
        businessSector: text(company?.businessActivities) || text(company?.businessType) };
    const companyName = [business?.organizationName, business?.organisationName,
        business?.companyName, business?.businessName, company?.businessName]
        .map(text).find(Boolean) || '';
    return { companyName, businessSector: text(business?.businessActivities) || text(company?.businessType) };
}
module.exports = { certificateIdentity };
