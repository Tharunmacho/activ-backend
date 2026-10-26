const assert = require('node:assert/strict');
const { certificateIdentity: identity } = require('../src/modules/members/certificateIdentity');
assert.equal(identity({ organizationName: '  ACTIV Exports  ' }, { businessName: 'Other listing' }).companyName, 'ACTIV Exports');
assert.equal(identity({}, { businessName: 'Member Company' }).companyName, 'Member Company');
assert.equal(identity({ companyName: 'Legacy Company' }, null).companyName, 'Legacy Company');
assert.equal(identity(null, null).companyName, '');
assert.deepEqual(identity({ organizationName: 'Original company', businessActivities: 'Original sector' },
    { businessName: '  Switched company ', businessType: 'Trading' }, { selectedCompany: true }),
    { companyName: 'Switched company', businessSector: 'Trading' });
console.log('PASS certificate identity: application company preferred; company-profile and legacy fallbacks; personal certificate has no company name.');
