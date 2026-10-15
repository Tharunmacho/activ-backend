// Real routes and persistence, isolated loopback Mongo. Never sends a message.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'local-personal-only', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Personal = require('../src/modules/members/personalinfo1.model');
    const Auth = require('../src/modules/auth/auth.model');
    const Application = require('../src/modules/applications/application.model');
    const service = require('../src/modules/applications/application.service');
    service.announceSubmission = async () => {}; // no email/WhatsApp/FCM adapter invoked
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/members', require('../src/modules/members/member.routes'));
    app.use('/applications', require('../src/modules/applications/application.routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const base = { fullName: 'Local Applicant', phoneNumber: '9123456780', state: 'Tamil Nadu', district: 'Krishnagiri', block: 'Hosur', city: 'Hosur' };
    const demographics = { socialCategory: 'SC', religion: 'Hinduism', gender: 'Male' };
    let seq = 0;
    const fixture = async extra => {
        const email = `personal-${++seq}@example.test`;
        const member = await Member.create({ ...base, email, role: 'member', isActive: true, ...extra });
        await Auth.create({ email, password: 'LocalOnly123!', isActive: true });
        const token = require('jsonwebtoken').sign({ userId: String(member._id), role: 'member' }, process.env.JWT_SECRET);
        return { member, api: method => url => request(app)[method](url).set('Authorization', `Bearer ${token}`) };
    };
    const f = await fixture({});
    const incomplete = await f.api('put')('/members/profile').send({ agreeToDeclaration: true });
    assert.equal(incomplete.status, 200, JSON.stringify(incomplete.body));
    assert.equal(incomplete.body.data.personalDetailsComplete, false);
    assert.equal((await Personal.findOne({ userId: f.member._id })).isLocked, false, 'declaration cannot lock an unfinished personal form');
    const legacy = await Personal.findOne({ userId: f.member._id });
    legacy.isLocked = true; await legacy.save();
    let profile = await f.api('get')('/members/my-profile');
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    assert.equal(profile.body.data.isLocked, false, 'legacy missing answers remain editable');
    assert(profile.body.data.missingPersonalFields.includes('religion'));

    for (const body of [
        { fullName: 'Must not change', email: 'must-not-change@example.test', socialCategory: 'SC', gender: 'Male' },
        { ...demographics, religion: '' }, { ...demographics, religion: null },
        { ...demographics, socialCategory: 'made-up' }, { ...demographics, gender: {} },
        { ...demographics, religion: 'Christian' }, { ...demographics, city: '   ' },
    ]) {
        const result = await f.api('put')('/members/profile').send(body);
        assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    assert.equal((await Member.findById(f.member._id)).fullName, base.fullName, 'reject before profile/contact writes');
    assert(await Auth.exists({ email: f.member.email }));
    for (const body of [{}, { data: { personalDetails: { socialCategory: 'SC', religion: 'Hindu' } } }, { data: { personalDetails: [] } }]) {
        const result = await f.api('post')('/applications/submit').send(body);
        assert.equal(result.status, 400, JSON.stringify(result.body));
    }
    assert.equal(await Application.countDocuments({ userId: f.member._id }), 0);
    const saved = await f.api('put')('/members/profile').send({ ...demographics });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.personalDetailsComplete, true);
    assert.equal((await Member.findById(f.member._id)).religion, 'Hindu');
    assert.equal((await Personal.findOne({ userId: f.member._id })).religion, 'Hindu');
    // Explicit erasure cannot be hidden by a valid saved answer.
    const erase = await f.api('post')('/applications').send({ data: { personalDetails: { religion: '' } } });
    assert.equal(erase.status, 400);
    const submitted = await f.api('post')('/applications').send({ memberType: 'aspirant', data: { businessInfo: { doingBusiness: false } } });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.data.personalDetails.religion, 'Hindu');
    assert.equal(submitted.body.data.data.personalDetails.socialCategory, 'SC');
    assert.equal(submitted.body.data.data.personalDetails.gender, 'Male');
    assert.equal(submitted.body.data.memberType, 'aspirant');

    for (const kind of ['business', 'student']) {
        const next = await fixture({});
        const result = await next.api('post')('/applications/submit').send({ registrationType: kind, data: { personalDetails: demographics,
            businessInfo: { doingBusiness: kind === 'business', registrationType: kind } } });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.data.memberType, kind);
        assert.equal(result.body.data.data.personalDetails.religion, 'Hindu');
    }
    const legacyApp = { userId: f.member._id, email: f.member.email, data: { personalDetails: { fullName: base.fullName }, businessInfo: {}, financialInfo: {}, declaration: {} } };
    let hydrated = await service.hydrateApplicationSections(legacyApp);
    assert.equal(hydrated.data.personalDetails.religion, 'Hindu', 'partial snapshot fills saved answers');
    assert.equal(hydrated.data.personalDetails.socialCategory, 'SC');
    hydrated = await service.hydrateApplicationSections({ ...legacyApp, data: { ...legacyApp.data, personalDetails: { religion: 'Buddhist', socialCategory: 'ST' } } });
    assert.equal(hydrated.data.personalDetails.religion, 'Buddhist', 'snapshot answer wins over later profile');
    const missing = await fixture({});
    hydrated = await service.hydrateApplicationSections({ userId: missing.member._id, email: missing.member.email, data: { personalDetails: { fullName: base.fullName } } });
    assert(!hydrated.data.personalDetails.religion, 'never invent a missing religion');
    assert(!hydrated.data.personalDetails.socialCategory, 'never invent a missing category');

    const abroad = await fixture({ phoneNumber: '+447911123456', isInternational: true, country: 'United Kingdom', state: '', district: '', block: '', place: 'London', ...demographics });
    const international = await abroad.api('post')('/applications').send({ registrationType: 'student', data: { personalDetails: { place: 'Manchester' } } });
    assert.equal(international.status, 201, JSON.stringify(international.body));
    assert.equal(international.body.data.place, 'Manchester');
    assert.equal(international.body.data.data.personalDetails.state, '');
    const city = await fixture({ district: 'Chennai', block: '', ...demographics });
    const districtOnly = await city.api('post')('/applications').send({ registrationType: 'aspirant' });
    assert.equal(districtOnly.status, 201, JSON.stringify(districtOnly.body));
    console.log('PASS: required personal fields, direct API bypasses, pre-write validation, canonical demographics, all applicant types, legacy unlock/readback, international and district-only locations. No external delivery.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
