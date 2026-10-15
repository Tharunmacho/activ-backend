// Controller fixtures only: no database process or provider connections.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Member = require('../src/modules/members/memberdetails.model');
const Personal = require('../src/modules/members/personalinfo1.model');
const Order = require('../src/modules/payment/paymentorder.model');
const { getMyProfile } = require('../src/modules/members/member.controller');
const originals = [Member.findById, Personal.findOne, Order.findOne];
const base = {
    _id: new mongoose.Types.ObjectId(), fullName: 'Local Fixture', email: 'fixture@example.test',
    phoneNumber: '+447911123456', membershipStatus: 'pending', socialCategory: 'SC', religion: 'Hindu', gender: 'Male',
    state: '', district: '', block: '', city: '', isInternational: false, country: '', place: 'London',
};
async function profile(member, personal = null) {
    Member.findById = () => ({ select: async () => member });
    Personal.findOne = async () => personal;
    Order.findOne = () => ({ sort() { return this; }, select() { return this; }, lean: async () => null });
    return new Promise((resolve, reject) => {
        const response = { set() { return this; }, status() { return this; }, json: value => resolve(value.data) };
        getMyProfile({ user: { userId: String(member._id) } }, response, reject);
    });
}
(async () => {
    for (const personal of [null, { ...base, name: base.fullName, isLocked: true }]) {
        const result = await profile({ ...base }, personal);
        assert.equal(result.isInternational, true, 'Stored overseas phone is authoritative even when the old flag is false');
        assert.equal(result.country, 'United Kingdom');
        assert.equal(result.place, 'London');
        assert.equal(result.personalDetailsComplete, true);
        assert.equal(result.personalDetailsBlockRequired, false);
        assert.deepEqual(result.missingPersonalFields, []);
    }
    const savedPlace = await profile({ ...base, place: '' }, { ...base, name: base.fullName, place: 'Manchester', isLocked: true });
    assert.equal(savedPlace.place, 'Manchester', 'Read the same member\'s saved place when the core row predates it');
    assert.equal(savedPlace.personalDetailsComplete, true);
    const missingPlace = await profile({ ...base, place: '' }, { ...base, name: base.fullName, place: '', isLocked: true });
    assert.equal(missingPlace.isInternational, true);
    assert.deepEqual(missingPlace.missingPersonalFields, ['place']);
    assert.equal(missingPlace.isLocked, false, 'An incomplete legacy profile remains editable');
    const domestic = await profile({ ...base, phoneNumber: '9123456780', state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur', city: 'Hosur', place: '' });
    assert.equal(domestic.isInternational, false);
    assert.equal(domestic.personalDetailsBlockRequired, true);
    assert.equal(domestic.personalDetailsComplete, true);
    const recordedAbroad = await profile({ ...base, phoneNumber: '9123456780', isInternational: true, country: 'United Kingdom' });
    assert.equal(recordedAbroad.isInternational, true, 'A recorded overseas account keeps its country classification');
    assert.equal(recordedAbroad.country, 'United Kingdom');
    console.log('PASS 6 international profile response fixtures; no database or provider connection.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    [Member.findById, Personal.findOne, Order.findOne] = originals;
    process.exit(process.exitCode || 0);
});
