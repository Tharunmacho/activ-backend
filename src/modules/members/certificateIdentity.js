const text = value => typeof value === 'string' ? value.trim() : '';

const businessName = business => [business?.organizationName, business?.organisationName,
    business?.companyName, business?.businessName, business?.organization, business?.organisation]
    .map(text).find(Boolean) || '';

// Use the first activation/payment, not a renewal or an application timestamp.
// An undated historical membership cannot establish when a company was chosen.
function certificateCompanyCutoff(member, orders) {
    const dates = [member?.membershipActivatedAt,
        ...(Array.isArray(orders) ? orders : [])
            .filter(order => order?.orderType === 'membership' && order?.status === 'paid')
            .map(order => order.paidAt)]
        .filter(value => value instanceof Date || typeof value === 'string' && value.trim())
        .map(value => new Date(value).getTime()).filter(value => Number.isFinite(value) && value > 0);
    return dates.length ? new Date(Math.min(...dates)) : null;
}

// `company` must be the owner's earliest named account saved before payment,
// including an unpublished account. Later company listings never replace it.
// Otherwise retain the enrollment identity; the client uses the member's name
// when neither source contains a company. Do not invent a company name.
function certificateIdentity(business, company, application) {
    if (text(company?.businessName)) return {
        companyName: text(company.businessName),
        businessSector: text(company.businessType),
    };
    const approved = text(application?.status).toLowerCase() === 'approved';
    const data = approved ? application?.data : null;
    const registration = data?.businessInfo || data?.business || data;
    const declared = businessName(business) ? business : businessName(registration) ? registration : null;
    const companyName = businessName(declared);
    return {
        companyName,
        businessSector: declared ? text(declared.businessActivities) : '',
    };
}
module.exports = { certificateIdentity, certificateCompanyCutoff };
