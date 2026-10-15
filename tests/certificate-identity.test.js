const assert = require('node:assert/strict');
const { certificateIdentity: identity, certificateCompanyCutoff: cutoff } = require('../src/modules/members/certificateIdentity');
assert.deepEqual(identity({ organizationName: 'ACTIV Exports', businessActivities: 'Old sector' },
    { businessName: '  Original Saved Company  ', businessType: 'Manufacturing' }),
    { companyName: 'Original Saved Company', businessSector: 'Manufacturing' });
assert.equal(identity({ organizationName: '  ACTIV Exports  ' }, null).companyName, 'ACTIV Exports');
assert.equal(identity({}, { businessName: 'Member Company' }).companyName, 'Member Company');
assert.equal(identity({ companyName: 'Legacy Company' }, null).companyName, 'Legacy Company');
assert.equal(identity(null, null).companyName, '');
for (const key of ['organizationName', 'organisationName', 'companyName', 'businessName', 'organization', 'organisation']) {
    assert.equal(identity({ [key]: '  Registered Company  ' }, null).companyName, 'Registered Company');
}
for (const key of ['businessInfo', 'business', 'flat']) {
    const business = { organizationName: 'Approved Company', businessActivities: 'Exports' };
    const registration = { status: 'Approved', data: key === 'flat' ? business : { [key]: business } };
    assert.deepEqual(identity(null, null, registration),
        { companyName: 'Approved Company', businessSector: 'Exports' });
    assert.equal(identity({ organizationName: 'Current Company' }, null, registration).companyName, 'Current Company');
}
for (const status of ['Pending', 'Rejected', 'Pending-State', '']) {
    assert.equal(identity(null, null, { status, data: { businessInfo: { organizationName: 'Unapproved Company' } } }).companyName, '');
}
assert.deepEqual(identity({ organizationName: ' ', businessActivities: 'Unrelated old sector' },
    { businessName: 'Company Profile', businessType: 'Services' }), { companyName: 'Company Profile', businessSector: 'Services' });
for (const registrationType of ['student', 'aspirant']) {
    assert.deepEqual(identity({ registrationType, doingBusiness: false }, null,
        { status: 'Approved', data: { businessInfo: { registrationType, doingBusiness: false } } }), { companyName: '', businessSector: '' });
}
assert.equal(identity({ organizationName: { name: 'Not a text field' } }, null).companyName, '');
const firstPayment = { orderType: 'membership', status: 'paid', paidAt: '2025-04-01T08:00:00Z' };
assert.equal(cutoff({ membershipActivatedAt: '2026-04-01T08:00:00Z' }, [firstPayment]).toISOString(), firstPayment.paidAt.replace('Z', '.000Z'));
assert.equal(cutoff({ membershipActivatedAt: '2024-04-01T08:00:00Z' }, [firstPayment]).getUTCFullYear(), 2024);
assert.equal(cutoff({}, [firstPayment]).getUTCFullYear(), 2025);
assert.equal(cutoff({ approvedAt: '2025-01-01', createdAt: '2024-01-01', lastPaymentDate: '2026-01-01' }, null), null);
assert.equal(cutoff({ membershipActivatedAt: 'invalid' }, [
    { ...firstPayment, orderType: 'company_listing' }, { ...firstPayment, status: 'pending' },
    { ...firstPayment, paidAt: null }, { ...firstPayment, paidAt: 'invalid' }, null,
]), null);
console.log('PASS certificate identity: one prepayment company, enrollment fallback, same-source sector, personal fallback and first-payment cutoff.');
