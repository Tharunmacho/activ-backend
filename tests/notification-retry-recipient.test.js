// Isolated current-account fixtures: no database, provider or worker is started.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const Member = require('../src/modules/members/memberdetails.model');
const Application = require('../src/modules/applications/application.model');
const admins = require('../src/modules/admin/admin.repository');
const { logReason } = require('../src/modules/notifications/deliveryRetryPolicy');

const ownerId = '100000000000000000000001';
const profileId = '100000000000000000000002';
let member, linkedMember, application, admin, readError;
let linkedReads = 0, adminReads = 0;
const query = value => ({ lean: async () => {
    if (readError) throw Error('Account lookup unavailable');
    return value;
} });
Member.findById = id => {
    assert.equal(String(id), ownerId);
    return query(member);
};
Member.findOne = filter => {
    assert.deepEqual(filter, { userId: ownerId }, 'only an explicit stored identity link may resolve a legacy account');
    linkedReads++;
    return query(linkedMember);
};
Application.findById = () => query(application);
admins.findById = async id => {
    assert.equal(id, ownerId);
    adminReads++;
    return admin;
};
const row = (event = 'CUSTOM') => ({
    _id: '200000000000000000000001', user: ownerId, event,
    channel: 'email', recipient: 'original@example.test', status: 'failed',
    deliveryStatus: 'failed', createdAt: new Date(), lastError: 'SMTP 535 refused',
    data: { emailHtml: '<p>Original notice</p>', lifecycleData: { applicationId: '300000000000000000000001' } },
});
const reset = () => {
    member = { _id: ownerId, isActive: true, membershipStatus: 'pending' };
    linkedMember = null; admin = null; readError = false; linkedReads = 0; adminReads = 0;
    application = { _id: '300000000000000000000001', userId: ownerId, status: 'Pending', reviews: {} };
};

async function main() {
    reset();
    assert.equal(await logReason(row()), '', 'a current profile remains eligible');
    assert.equal(linkedReads, 0);

    linkedMember = { ...member, _id: profileId, userId: ownerId };
    member = null;
    const applicationRow = row('APPLICATION_SUBMITTED');
    const original = JSON.stringify(applicationRow);
    assert.equal(await logReason(applicationRow), '', 'a current application notice accepts its explicitly linked legacy member');
    assert.equal(adminReads, 0, 'a resolved legacy member does not fall through to an admin lookup');
    assert.equal(JSON.stringify(applicationRow), original, 'eligibility does not retarget or rewrite the stored message');

    assert.match(await logReason(row()), /recipient account.*inactive/, 'unrelated custom messages do not gain legacy identity fallback');
    assert.match(await logReason(row('EVENT_BOOKING_CONFIRMED')), /recipient account.*inactive/,
        'booking ownership is not changed by application identity compatibility');

    application.userId = profileId;
    assert.match(await logReason(applicationRow), /no longer matches/, 'the legacy profile does not replace original application ownership');
    application.userId = ownerId;
    linkedMember.isActive = false;
    assert.match(await logReason(applicationRow), /account is no longer active/, 'an inactive linked profile still blocks delivery');
    linkedMember.isActive = true;
    linkedMember.deletedAt = new Date();
    assert.match(await logReason(applicationRow), /account is no longer active/, 'a deleted linked profile still blocks delivery');
    linkedMember = null;
    assert.match(await logReason(applicationRow), /account is no longer active/, 'an unavailable legacy profile still blocks delivery');

    reset();
    member.isActive = false;
    linkedMember = { _id: profileId, userId: ownerId, isActive: true };
    admin = { active: true };
    assert.match(await logReason(row()), /account is no longer active/, 'direct inactive identity remains authoritative');
    assert.equal(linkedReads, 0);
    assert.equal(adminReads, 0);
    member.isActive = true; member.deletedAt = new Date();
    assert.match(await logReason(row()), /account is no longer active/, 'direct deleted identity remains ineligible');
    assert.equal(linkedReads, 0);
    assert.equal(adminReads, 0);

    reset(); member = null; admin = { active: true };
    assert.equal(await logReason(row()), '', 'active admin behavior is preserved');
    assert.equal(linkedReads, 0, 'ordinary admin lookup does not search legacy application profiles');
    admin.active = false;
    assert.match(await logReason(row()), /recipient account.*inactive/, 'inactive admins remain ineligible');
    admin = null;
    assert.match(await logReason(row()), /recipient account.*inactive/, 'missing accounts remain ineligible');

    reset(); readError = true;
    await assert.rejects(logReason(row('APPLICATION_SUBMITTED')), /Account lookup unavailable/,
        'a failed account lookup is not treated as an eligible legacy identity');
    console.log('Notification retry recipient identity checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
