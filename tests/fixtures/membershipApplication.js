// Complete submitted snapshot for isolated membership activation fixtures.
module.exports = (member, { status = 'Approved', year, kind = member.memberType || 'student' } = {}) => ({
    userId: member._id, fullName: member.fullName, email: member.email, phone: member.phoneNumber,
    state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur', status,
    memberType: kind, registrationType: kind, submittedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    data: {
        personalDetails: { fullName: member.fullName, email: member.email, phoneNumber: member.phoneNumber,
            state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur', city: 'Hosur',
            religion: 'Hindu', socialCategory: 'SC', gender: 'Female' },
        businessInfo: { doingBusiness: kind === 'business', registrationType: kind,
            businessCommencementYear: kind === 'business' ? year || String(new Date().getFullYear() - 2) : '' },
        declaration: { agreeToDeclaration: true, sisterConcerns: 0, companyNames: [] },
    },
});
