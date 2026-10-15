// Real certificate controller with scoped in-memory model fixtures. No MongoDB,
// network, provider calls or production writes.
const assert = require('node:assert/strict');
// The endpoint never uses cache methods; avoid the unrelated cache cleanup timer.
const cacheId = require.resolve('../src/core/cache/cacheClient');
require.cache[cacheId] = { id: cacheId, filename: cacheId, loaded: true, exports: {} };
const Member = require('../src/modules/members/memberdetails.model');
const Business = require('../src/modules/members/businessinfo.model');
const Company = require('../src/modules/members/company.model');
const Application = require('../src/modules/applications/application.model');
const Financial = require('../src/modules/members/memberfinancialinfo.model');
const Order = require('../src/modules/payment/paymentorder.model');
const controller = require('../src/modules/members/memberExtras.controller');
const owner = '670000000000000000000001', other = '670000000000000000000002';
let member, businesses, companies, orders, applications, businessError, applicationError, orderError, applicationReads, companyReads;
const chain = (get, expectedSort) => ({
    sort(value) { if (expectedSort) assert.deepEqual(value, expectedSort); return this; },
    select() { return this; }, limit() { return this; }, lean: async () => get(),
});
Member.findById = id => { assert.equal(id, owner); return chain(() => member); };
Financial.findOne = query => { assert.deepEqual(query, { $or: [{ memberId: owner }, { userId: owner }] }); return chain(() => null); };
Order.find = query => {
    assert.deepEqual(query, { memberId: owner, status: 'paid', orderType: 'membership' });
    return chain(() => {
        if (orderError) throw new Error('membership payments unavailable');
        return orders.filter(row => row.memberId === owner && row.status === 'paid' && row.orderType === 'membership')
            .sort((a, b) => new Date(a.paidAt) - new Date(b.paidAt));
    });
};
Business.findOne = query => {
    assert.deepEqual(query, { userId: owner });
    return chain(() => { if (businessError) throw new Error('business unavailable'); return businesses.find(row => row.userId === query.userId) || null; });
};
Company.findOne = query => {
    companyReads++;
    assert.equal(query.userId, owner);
    assert.equal(query.isActive, undefined, 'unpublished prepayment companies must remain eligible');
    assert.deepEqual(query.status, { $ne: 'inactive' });
    assert(query.createdAt.$lte instanceof Date);
    assert.equal(query.businessName.$type, 'string');
    assert(query.businessName.$regex instanceof RegExp);
    return chain(() => companies.filter(row => row.userId === query.userId && row.status !== 'inactive'
        && row.createdAt && new Date(row.createdAt) <= query.createdAt.$lte
        && typeof row.businessName === 'string' && query.businessName.$regex.test(row.businessName))
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a._id).localeCompare(String(b._id)))[0] || null,
    { createdAt: 1, _id: 1 });
};
Application.findOne = query => {
    applicationReads++;
    assert.equal(query.userId, owner);
    assert(query.status instanceof RegExp);
    return chain(() => {
        if (applicationError) throw new Error('application unavailable');
        return applications.filter(row => row.userId === query.userId && query.status.test(row.status))
            .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    }, { 'approvedBy.approvedAt': -1, createdAt: -1, _id: -1 });
};
function reset() {
    member = { _id: owner, fullName: 'Certificate Member', membershipNumber: 'ACTIV-BEG-20261015-001',
        membershipStatus: 'active', membershipType: 'annual', memberType: 'business',
        membershipActivatedAt: '2026-10-15T00:00:00Z', membershipExpiresAt: '2027-10-15T00:00:00Z' };
    businesses = []; companies = []; orders = []; applications = [];
    businessError = false; applicationError = false; orderError = false; applicationReads = 0; companyReads = 0;
}
const certificate = (kind = 'membership') => new Promise((resolve, reject) => controller.getCertificate(
    { user: { userId: owner }, params: { kind, userId: other }, query: { userId: other }, body: { userId: other } },
    { json: result => resolve(result.data) }, reject));

(async () => {
    reset();
    businesses = [{ userId: other, organizationName: 'Other User Company' }, { userId: owner, organizationName: 'Current Registered Company' }];
    let result = await certificate();
    assert.equal(result.member.companyName, 'Current Registered Company');
    assert.equal(applicationReads, 0, 'Do not query registration when current business is complete');
    assert.equal(result.membershipType, 'annual');

    reset();
    applications = [
        { userId: other, status: 'Approved', createdAt: 9, data: { organizationName: 'Someone Else' } },
        { userId: owner, status: 'Pending', createdAt: 8, data: { organizationName: 'Pending Company' } },
        { userId: owner, status: 'Rejected', createdAt: 7, data: { organizationName: 'Rejected Company' } },
        { userId: owner, status: 'approved', createdAt: 6, data: { businessInfo: { organizationName: 'Approved Registration Company', businessActivities: 'Manufacturing' } } },
    ];
    companies = [{ userId: owner, createdAt: '2026-10-16', businessName: 'Later Dashboard Company' }];
    result = await certificate();
    assert.equal(result.member.companyName, 'Approved Registration Company');
    assert.equal(result.member.businessSector, 'Manufacturing');

    reset();
    companies = [
        { userId: other, createdAt: '2026-01-01', businessName: 'Other User Company' },
        { userId: owner, createdAt: '2026-01-02', businessName: '   ' },
        { userId: owner, createdAt: '2026-01-03', businessName: 'Deleted Company', isActive: false, status: 'inactive' },
        { userId: owner, createdAt: '2026-01-04', _id: 'b', businessName: 'Second Named Company' },
        { userId: owner, createdAt: '2026-01-04', _id: 'a', businessName: 'First Named Company', businessType: 'Services', isActive: false, status: 'active' },
        { userId: owner, createdAt: '2026-02-01', businessName: 'Later Named Company' },
    ];
    businesses = [{ userId: owner, organizationName: 'Enrollment Company', businessActivities: 'Other sector' }];
    result = await certificate();
    assert.equal(result.member.companyName, 'First Named Company');
    assert.equal(result.member.businessSector, 'Services');
    assert.equal(applicationReads, 0);
    member.membershipTier = 'platinum'; member.membershipType = 'lifetime';
    companies.push({ userId: owner, createdAt: '2026-10-20', businessName: 'Additional Lifetime Company' });
    result = await certificate();
    assert.equal(result.member.companyName, 'First Named Company', 'later lifetime companies never replace the initial account');
    assert.equal(companies.length, 7, 'certificate reads do not restrict or mutate company listings');

    reset();
    companies = [{ userId: owner, createdAt: member.membershipActivatedAt, businessName: 'Company Saved At Payment' }];
    assert.equal((await certificate()).member.companyName, 'Company Saved At Payment');

    reset();
    // A renewal date cannot admit a company created after initial membership.
    orders = [{ memberId: owner, orderType: 'membership', status: 'paid', paidAt: '2025-10-01' }];
    companies = [{ userId: owner, createdAt: '2026-01-01', businessName: 'Post Membership Company' }];
    businesses = [{ userId: owner, organizationName: 'Original Enrollment Company' }];
    assert.equal((await certificate()).member.companyName, 'Original Enrollment Company');

    reset();
    delete member.membershipActivatedAt;
    orders = [{ memberId: owner, orderType: 'membership', status: 'paid', paidAt: '2026-10-01' }];
    companies = [{ userId: owner, createdAt: '2026-09-01', businessName: 'Company Before Recorded Payment', isActive: false }];
    assert.equal((await certificate()).member.companyName, 'Company Before Recorded Payment');

    reset();
    delete member.membershipActivatedAt;
    member.approvedAt = '2026-10-01'; member.lastPaymentDate = '2026-10-01';
    orders = [
        { memberId: owner, orderType: 'company_listing', status: 'paid', paidAt: '2026-10-01' },
        { memberId: other, orderType: 'membership', status: 'paid', paidAt: '2026-10-01' },
        { memberId: owner, orderType: 'membership', status: 'pending', paidAt: '2026-10-01' },
    ];
    companies = [{ userId: owner, createdAt: '2026-09-01', businessName: 'Unproven Enrollment Company' }];
    businesses = [{ userId: owner, organizationName: 'Historical Enrollment Company' }];
    assert.equal((await certificate()).member.companyName, 'Historical Enrollment Company');
    assert.equal(companyReads, 0, 'do not infer a company enrollment date from approvals or listing payments');

    reset();
    companies = [{ userId: owner, createdAt: '2026-10-16', businessName: 'Only Later Listing' }];
    result = await certificate();
    assert.equal(result.member.companyName, '', 'with no enrollment company the views use the member name');
    assert.equal(result.member.name, 'Certificate Member');

    for (const memberType of ['student', 'aspirant']) {
        reset(); member.memberType = memberType;
        businesses = [{ userId: owner, registrationType: memberType, doingBusiness: false }];
        result = await certificate();
        assert.equal(result.member.companyName, '');
        assert.equal(result.member.name, 'Certificate Member');
        assert.equal(result.membershipType, 'annual');
    }
    reset(); member.membershipTier = 'platinum'; member.membershipType = 'lifetime';
    result = await certificate();
    assert.equal(result.membershipTier, 'platinum');
    assert.equal(result.membershipType, 'lifetime');
    assert.equal(result.validUntil, null);
    reset(); businessError = true;
    await assert.rejects(certificate(), /business unavailable/);
    reset(); applicationError = true;
    await assert.rejects(certificate(), /application unavailable/);
    reset(); orderError = true;
    companies = [{ userId: owner, createdAt: '2026-01-01', businessName: 'Potentially Post Renewal Company' }];
    await assert.rejects(certificate(), /membership payments unavailable/);
    assert.equal(companyReads, 0, 'payment history failure must not choose a company using an uncertain date');
    reset(); member.membershipStatus = 'pending';
    await assert.rejects(certificate(), error => error.statusCode === 403);
    console.log('PASS certificate API: one owned prepayment company including unpublished accounts, enrollment/personal fallbacks, renewal and lifetime stability, owner/date boundaries and lookup failures.');
})().catch(error => { console.error(error); process.exitCode = 1; });
