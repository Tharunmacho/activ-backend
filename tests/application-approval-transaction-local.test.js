// Real replica-set transaction behavior in disposable loopback Mongo.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, replSet: { count: 1, ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/); process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Business = require('../src/modules/members/businessinfo.model');
    const Financial = require('../src/modules/members/memberfinancialinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');
    const Application = require('../src/modules/applications/application.model');
    const service = require('../src/modules/applications/application.service');
    await Promise.all([Member, Business, Financial, Declaration, Application].map(Model => Model.createCollection()));
    const personal = { fullName: 'Submitted Name', phoneNumber: '9123456780', state: 'Tamil Nadu', district: 'Chennai', city: 'Chennai', religion: 'Hindu', socialCategory: 'SC', gender: 'Female' };
    let seq = 0;
    const fixture = async () => {
        const member = await Member.create({ ...personal, fullName: 'Saved Profile Name', email: `transaction-${++seq}@example.test`, role: 'member', isActive: true });
        const application = await Application.create({ userId: member._id, ...personal, phone: personal.phoneNumber, email: member.email, status: 'Pending', memberType: 'student', registrationType: 'student', data: {
            personalDetails: { ...personal, email: member.email }, businessInfo: { doingBusiness: false, registrationType: 'student' }, declaration: { agreeToDeclaration: true },
        } });
        return { member, application };
    };
    const reviewer = new mongoose.Types.ObjectId();
    const failed = await fixture(); let writes = 0;
    const originalSave = Financial.prototype.save;
    Financial.prototype.save = async function () { writes++; throw Error('Injected transactional write failure'); };
    try { await assert.rejects(() => service.commitFinalApproval(failed.application, reviewer), /Injected transactional write failure/); }
    finally { Financial.prototype.save = originalSave; }
    assert.equal(writes, 1, 'transaction profile writes are not replayed automatically');
    assert.equal((await Member.findById(failed.member._id)).fullName, 'Saved Profile Name');
    assert.equal((await Application.findById(failed.application._id)).status, 'Pending');
    assert.equal(await Business.countDocuments({ userId: failed.member._id }), 0);
    const happy = await fixture(); await service.commitFinalApproval(happy.application, reviewer);
    assert.equal((await Application.findById(happy.application._id)).status, 'Approved');
    assert.equal((await Member.findById(happy.member._id)).fullName, 'Submitted Name');
    assert.equal(await Declaration.countDocuments({ userId: happy.member._id, agreeToDeclaration: true }), 1);
    console.log('PASS transaction approval commit, automatic rollback and no stale-write replay');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
