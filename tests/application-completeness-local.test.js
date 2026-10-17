// Disposable loopback database only. Submission announcements are disabled.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'local-application-only', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Auth = require('../src/modules/auth/auth.model');
    const Personal = require('../src/modules/members/personalinfo1.model');
    const Business = require('../src/modules/members/businessinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');
    const Application = require('../src/modules/applications/application.model');
    const service = require('../src/modules/applications/application.service');
    service.announceSubmission = async () => {};
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/members', require('../src/modules/members/member.routes'));
    app.use('/applications', require('../src/modules/applications/application.routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const personal = { fullName: 'Complete Applicant', phoneNumber: '9123456780', state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur', city: 'Hosur', religion: 'Hindu', socialCategory: 'SC', gender: 'Female' };
    const business = { doingBusiness: false, registrationType: 'student' };
    const declaration = { agreeToDeclaration: true, sisterConcerns: 0, companyNames: [] };
    let seq = 0;
    const fixture = async (extra = {}) => {
        const member = await Member.create({ ...personal, email: `complete-${++seq}@example.test`, role: 'member', isActive: true, ...extra });
        await Auth.create({ email: member.email, password: 'LocalOnly123!', isActive: true });
        const token = require('jsonwebtoken').sign({ userId: String(member._id), role: 'member' }, process.env.JWT_SECRET);
        const api = (method, url, body) => request(app)[method](url).set('Authorization', `Bearer ${token}`).send(body);
        return { member, api };
    };
    const f = await fixture();
    for (const data of [
        {}, { businessInfo: {} }, { businessInfo: business }, { businessInfo: business, declaration: {} },
        { businessInfo: business, declaration: { agreeToDeclaration: false } },
        { businessInfo: { doingBusiness: false }, declaration },
        { businessInfo: { doingBusiness: true }, declaration },
        ...['', '1799', '9999', '2020.5'].map(year => ({ businessInfo: { doingBusiness: true, businessCommencementYear: year }, declaration })),
        { businessInfo: [], declaration }, { businessInfo: business, declaration: [] },
        { businessInfo: { doingBusiness: true, businessCommencementYear: '2020' }, declaration: { ...declaration, sisterConcerns: 2, companyNames: ['One'] } },
    ]) {
        const response = await f.api('post', '/applications/submit', { data });
        assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(await Application.countDocuments({ userId: f.member._id }), 0);
    }
    const invalidSave = await f.api('put', '/members/profile', { fullName: 'Must not save', doingBusiness: true, businessCommencementYear: '9999' });
    assert.equal(invalidSave.status, 400);
    assert.equal((await Member.findById(f.member._id)).fullName, personal.fullName, 'section validation precedes any profile write');
    assert.equal(await Business.countDocuments({ userId: f.member._id }), 0);
    const created = await f.api('post', '/applications', { userId: new mongoose.Types.ObjectId(), role: 'super_admin', status: 'Approved', reviews: { state: { decision: 'approved' } }, data: { businessInfo: business, declaration } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.userId, String(f.member._id));
    assert.equal(created.body.data.status, 'Pending');
    assert.equal(created.body.data.reviews.state.decision, 'pending');
    assert.notEqual(created.body.data.role, 'super_admin');
    const existing = await Application.findById(created.body.data._id);
    existing.reviews.block = { decision: 'approved', decidedAt: new Date() };
    existing.blockApprovedAt = new Date(); existing.districtApprovedAt = new Date();
    existing.reviewedBy = { blockAdmin: new mongoose.Types.ObjectId(), districtAdmin: new mongoose.Types.ObjectId() };
    await existing.save();
    const unchanged = await f.api('post', '/applications/submit', { data: { businessInfo: business, declaration } });
    assert.equal(unchanged.status, 201, JSON.stringify(unchanged.body));
    assert.equal(unchanged.body.data.reviews.block.decision, 'approved', 'identical retry preserves endorsements');
    const changed = await f.api('post', '/applications/submit', { data: { businessInfo: { doingBusiness: true, businessCommencementYear: '2020' }, declaration: { ...declaration, sisterConcerns: 1, companyNames: ['Real Company'] } } });
    assert.equal(changed.status, 201, JSON.stringify(changed.body));
    assert.equal(changed.body.data._id, String(existing._id));
    assert.equal(changed.body.data.registrationType, 'business');
    assert.equal(changed.body.data.data.declaration.companyNames[0], 'Real Company');
    assert.equal(changed.body.data.reviews.block.decision, 'pending');
    assert.match(changed.body.data.notes.at(-1).note, /Previous review/);
    const afterRetry = await Application.findById(existing._id);
    assert.equal(afterRetry.blockApprovedAt, undefined); assert.equal(afterRetry.districtApprovedAt, undefined);
    require('../src/modules/common/tierReviews').materialiseLegacyVerdicts(afterRetry);
    assert.equal(afterRetry.reviews.block.decision, 'pending'); assert.equal(afterRetry.reviews.district.decision, 'pending');
    assert.equal(await Application.countDocuments({ userId: f.member._id }), 1);
    const badRetry = await f.api('post', '/applications/submit', { data: { businessInfo: business, declaration: { agreeToDeclaration: false } } });
    assert.equal(badRetry.status, 400);
    assert.equal((await Application.findById(existing._id)).registrationType, 'business');
    const beforeContact = (await Application.findById(existing._id)).toObject();
    const contactChange = await f.api('put', '/members/profile', { email: 'new-login@example.test', phoneNumber: '9234567801' });
    assert.equal(contactChange.status, 200, JSON.stringify(contactChange.body));
    assert.deepEqual((await Application.findById(existing._id)).data, beforeContact.data, 'contact edits preserve the submitted snapshot');
    const profileChange = await f.api('put', '/members/profile', { city: 'New Town' });
    assert.equal(profileChange.status, 200, JSON.stringify(profileChange.body));
    assert.deepEqual((await Application.findById(existing._id)).data, beforeContact.data, 'saving a section does not resubmit answers');
    await service.createMemberProfile(await Application.findById(existing._id), new mongoose.Types.ObjectId());
    const preservedContact = await Member.findById(f.member._id);
    assert.equal(preservedContact.email, 'new-login@example.test', 'approval preserves the current login email');
    assert.equal(preservedContact.phoneNumber, '9234567801', 'approval preserves the current contact number');
    assert(await Auth.exists({ email: preservedContact.email }));

    // Saved complete forms still do not authorize approving a missing snapshot.
    const legacy = await fixture();
    await Business.create({ userId: legacy.member._id, ...business });
    await Declaration.create({ userId: legacy.member._id, memberId: legacy.member._id, ...declaration });
    const old = await Application.create({ userId: legacy.member._id, ...personal, email: legacy.member.email, phone: personal.phoneNumber, data: { personalDetails: personal }, status: 'Pending' });
    const reviewer = new mongoose.Types.ObjectId();
    for (const tier of ['block', 'district', 'state', 'super']) await assert.rejects(() => service.decide(old._id, 'approve', tier, reviewer), /Business information/);
    await assert.rejects(() => service.updateApplicationStatus(old._id, 'Approved', '', reviewer), /Business information/);
    await assert.rejects(() => service.createMemberProfile(old, reviewer), /Business information/);
    assert.equal((await Application.findById(old._id)).status, 'Pending');
    const repair = await legacy.api('post', '/applications/submit', {});
    assert.equal(repair.status, 201, JSON.stringify(repair.body));
    await service.completeApplicationPersonal(await Application.findById(old._id));
    await Application.updateOne({ _id: old._id }, { status: 'Approved' });
    assert.equal((await legacy.api('post', '/applications', {})).status, 409, 'approved applications cannot be duplicated');

    // Initial social accounts can save sections without fake phone/region values.
    const draft = await fixture({ registrationIncomplete: true, phoneNumber: '', state: '', district: '', block: '', city: '', religion: '', socialCategory: '', gender: '' });
    const premature = await draft.api('post', '/applications/submit', { data: { businessInfo: business, declaration } });
    assert.equal(premature.status, 400);
    const businessSave = await draft.api('put', '/members/profile', { ...business, registrationIncomplete: false });
    assert.equal(businessSave.status, 200, JSON.stringify(businessSave.body));
    assert.equal((await Member.findById(draft.member._id)).registrationIncomplete, true);
    assert.equal((await Personal.findOne({ userId: draft.member._id })).isLocked, false);
    const firstContact = await draft.api('put', '/members/profile', { ...personal, phoneNumber: '+447911123456', state: '', district: '', block: '', city: 'London', place: 'London' });
    assert.equal(firstContact.status, 200, JSON.stringify(firstContact.body));
    assert.equal(firstContact.body.data.isInternational, true);
    assert.equal((await Member.findById(draft.member._id)).registrationIncomplete, true, 'Personal alone is still an unsubmitted draft');
    assert.equal((await draft.api('put', '/members/profile', declaration)).status, 200);
    const draftSubmit = await draft.api('post', '/applications/submit', {});
    assert.equal(draftSubmit.status, 201, JSON.stringify(draftSubmit.body));
    assert.equal(draftSubmit.body.data.isInternational, true);
    assert.equal(draftSubmit.body.data.state, '');
    assert.equal((await Member.findById(draft.member._id)).registrationIncomplete, false);
    assert.equal((await Personal.findOne({ userId: draft.member._id })).registrationIncomplete, false);
    console.log('PASS complete application gates, conditional fields, safe retries, approval snapshots and social drafts');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0); });
