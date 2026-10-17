// Exercise the standalone fallback against disposable loopback Mongo only.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/); process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Auth = require('../src/modules/auth/auth.model');
    const Business = require('../src/modules/members/businessinfo.model');
    const Financial = require('../src/modules/members/memberfinancialinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');
    const Application = require('../src/modules/applications/application.model');
    const service = require('../src/modules/applications/application.service');
    const account = require('../src/modules/members/accountDetails.service');
    service.announceSubmission = async () => {};
    const personal = { fullName: 'Snapshot Applicant', phoneNumber: '9123456780', state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur', city: 'Hosur', religion: 'Hindu', socialCategory: 'SC', gender: 'Female' };
    const business = { doingBusiness: false, registrationType: 'student', businessCommencementYear: '' };
    const declaration = { agreeToDeclaration: true, sisterConcerns: 0, companyNames: [] };
    let seq = 0;
    const fixture = async () => {
        const member = await Member.create({ ...personal, fullName: 'Current Profile', city: 'Current Town', email: `rollback-${++seq}@example.test`, role: 'member', isActive: true });
        await Auth.create({ email: member.email, password: 'LocalOnly123!', isActive: true });
        const savedBusiness = await Business.create({ userId: member._id, doingBusiness: false, registrationType: 'aspirant', organizationName: 'Existing Company' });
        const application = await Application.create({ userId: member._id, ...personal, phone: personal.phoneNumber, email: member.email, memberType: 'student', registrationType: 'student', status: 'Pending',
            data: { personalDetails: { ...personal, email: member.email }, businessInfo: business, declaration } });
        return { member, business: savedBusiness, application };
    };
    const relevant = doc => { const value = doc.toObject ? doc.toObject() : doc; return Object.fromEntries(Object.entries(value).filter(([key]) => !['updatedAt', '__v'].includes(key))); };
    const reviewer = new mongoose.Types.ObjectId();

    // Mid-write failure after Member+Business changed: both existing rows must
    // remain, and their previous answers must be restored (never deleted).
    const failed = await fixture();
    const beforeMember = relevant(failed.member), beforeBusiness = relevant(failed.business);
    const originalFinancialSave = Financial.prototype.save;
    Financial.prototype.save = async function () { throw new Error('Injected financial write failure'); };
    try { await assert.rejects(() => service.commitFinalApproval(failed.application, reviewer), /Injected financial write failure/); }
    finally { Financial.prototype.save = originalFinancialSave; }
    assert.deepEqual(relevant(await Member.findById(failed.member._id)), beforeMember);
    assert.deepEqual(relevant(await Business.findById(failed.business._id)), beforeBusiness);
    assert.equal((await Application.findById(failed.application._id)).status, 'Pending');
    assert.equal(await Financial.countDocuments({ memberId: failed.member._id }), 0);

    // A complete resubmission lands while approval has written all profiles but
    // before its final Application save. The stale approval loses the revision
    // comparison, rolls back its own fields, and preserves the new submission.
    const race = await fixture();
    const save = race.application.save.bind(race.application);
    let injected = false;
    race.application.save = async function (...args) {
        if (!injected) {
            injected = true;
            await account.update(await Member.findById(race.member._id), { email: 'current-login@example.test', phoneNumber: '9234567801' });
            await Member.updateOne({ _id: race.member._id }, { $set: { city: 'Concurrent Town' } });
            await service.createApplication(race.member._id, { data: {
                personalDetails: { ...personal, email: 'current-login@example.test', phoneNumber: '9234567801', city: 'Resubmitted Town' },
                businessInfo: { doingBusiness: false, registrationType: 'aspirant' }, declaration,
            } });
        }
        return save(...args);
    };
    await assert.rejects(() => service.commitFinalApproval(race.application, reviewer), error => error.statusCode === 409);
    assert.equal(injected, true);
    const final = await Application.findById(race.application._id);
    assert.equal(final.status, 'Pending'); assert.equal(final.data.personalDetails.city, 'Resubmitted Town');
    assert.equal(final.registrationType, 'aspirant');
    const retained = await Member.findById(race.member._id);
    assert.equal(retained.fullName, 'Current Profile', 'own approval name change restored');
    assert.equal(retained.city, 'Concurrent Town', 'later profile change preserved');
    assert.equal(retained.email, 'current-login@example.test'); assert.equal(retained.phoneNumber, '9234567801');
    assert(await Auth.exists({ email: retained.email }));
    assert.equal((await Business.findById(race.business._id)).registrationType, 'aspirant');
    assert.equal(await Financial.countDocuments({ memberId: race.member._id }), 0, 'new unchanged records removed on rollback');
    assert.equal(await Declaration.countDocuments({ userId: race.member._id }), 0);

    // A stale revision detected before writes does not enter profile creation.
    const stale = await fixture();
    await Application.updateOne({ _id: stale.application._id }, { $set: { 'data.personalDetails.city': 'New submitted city' } });
    await assert.rejects(() => service.commitFinalApproval(stale.application, reviewer), error => error.statusCode === 409);
    assert.equal((await Member.findById(stale.member._id)).fullName, 'Current Profile');
    assert.equal(await Financial.countDocuments({ memberId: stale.member._id }), 0);

    const happy = await fixture();
    await service.commitFinalApproval(happy.application, reviewer);
    assert.equal((await Application.findById(happy.application._id)).status, 'Approved');
    assert(await Member.findById(happy.member._id));
    console.log('PASS standalone approval rollback, mid-write failure, real resubmission conflict, concurrent contact/profile preservation and successful approval');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
