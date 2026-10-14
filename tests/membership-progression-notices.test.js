// Runs against in-memory stubs. No provider, database or account changes.
const assert = require('node:assert/strict');
const Member = require('../src/modules/members/memberdetails.model');
const notifications = require('../src/modules/notifications/notification.service');
const service = require('../src/modules/notifications/membershipProgression.service');
const now = new Date('2031-01-01T06:00:00Z');
const expiry = new Date('2031-10-12T00:00:00Z');
const member = { _id: '507f191e810c19729de860ea', fullName: 'Test member', email: 'test@example.invalid',
    membershipStatus: 'active', membershipType: 'annual', membershipExpiresAt: expiry,
    membershipNumber: 'ACTIV-BEG-20261012-001' };
const beginner = { key: 'beginner', name: 'Beginner', minYears: 0, price: 100 };
const intermediate = { key: 'intermediate', name: 'Intermediate', minYears: 5, price: 200, features: ['Business directory'] };
const progress = (effective, promoted = false) => ({ kind: 'business', effective, held: beginner, promoted });
let stored = { ...member };
const sent = [];
Member.updateOne = async (filter, patch) => {
    const old = stored.planNotificationState;
    const matches = filter.planNotificationState === null ? !old
        : old && old.planId === filter['planNotificationState.planId']
            && old.minYears === filter['planNotificationState.minYears']
            && old.initializedAt === filter['planNotificationState.initializedAt'];
    if (!matches || stored.membershipStatus !== filter.membershipStatus
        || stored.membershipExpiresAt !== filter.membershipExpiresAt) return { modifiedCount: 0 };
    Object.assign(stored, patch.$set);
    return { modifiedCount: 1 };
};
notifications.dispatchLifecycleEvent = async (event, recipient, payload) => {
    sent.push({ event, recipient, payload }); return { channels: { email: { success: true } } };
};
async function main() {
    assert.equal(await service.observe(member, progress(beginner), now), false);
    assert.equal(sent.length, 0, 'initial rollout is silent');
    const snapshot = { ...stored };
    const results = await Promise.all([service.observe(snapshot, progress(intermediate, true), now),
        service.observe(snapshot, progress(intermediate, true), now)]);
    assert.equal(results.filter(Boolean).length, 1, 'one concurrent claim wins');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'MEMBERSHIP_PLAN_ADVANCED');
    assert.equal(sent[0].payload.planName, 'Intermediate');
    assert.equal(sent[0].payload.data.feeAppliesAtRenewal, true);
    assert.equal(stored.membershipExpiresAt, expiry, 'paid validity unchanged');
    assert.equal(stored.membershipNumber, member.membershipNumber, 'membership ID unchanged');
    assert.equal(await service.observe({ ...stored }, progress(intermediate, true), now), false, 'no repeat');
    assert.equal(await service.observe({ ...stored }, progress(beginner), now), false, 'no backward notice');
    assert.equal(await service.observe({ ...stored, membershipStatus: 'expired' }, progress(intermediate, true), now), false);
    assert.equal(service.transitionFor(member, { ...progress(intermediate), kind: 'student' }), null);
    assert.equal(service.transitionFor({ ...member, membershipType: 'lifetime' }, progress(intermediate)), null);
    stored = { ...member };
    assert.equal(await service.observe(member, progress(intermediate, true), now), false, 'historic upgrade gets silent baseline');
    assert.equal(sent.length, 1);
    console.log('Membership progression notices: baseline, future promotion, concurrency, deduplication, no downgrade, paid validity and ID preservation passed.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
