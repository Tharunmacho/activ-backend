// Real disposable loopback MongoDB + HTTP. Email/notification transports are fixtures.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', MONGOMS_RUNTIME_DOWNLOAD: 'false', NOTIFICATION_WORKER_ENABLED: 'false',
    JWT_SECRET: 'local-password-capabilities-secret', JWT_REFRESH_SECRET: 'local-password-capabilities-refresh',
    FRONTEND_URL: 'http://localhost:8080' });
let mongo, checks = 0;
const passed = name => { checks++; console.log(`PASS ${name}`); };
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    const uri = mongo.getUri(); assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = uri; await mongoose.connect(uri);
    const Auth = require('../src/modules/auth/auth.model');
    const Member = require('../src/modules/members/memberdetails.model');
    const Identity = require('../src/modules/auth/oauthIdentity.model');
    const Flow = require('../src/modules/auth/oauthFlow.model');
    await Promise.all([Auth.init(), Member.init(), Identity.init(), Flow.init()]);
    require('../src/modules/admin/admin.repository').findRawByEmail = async () => null;
    require('../src/modules/regions/region.service').validateRegion = async () => ({ ok: true, region: { state: 'Tamil Nadu', district: 'Chennai', block: '' } });
    require('../src/modules/members/paymentReconcile').paymentIsGone = async () => false;
    require('../src/modules/notifications/notification.service').dispatchInBackground = async () => {};
    require('../src/modules/audit/audit.service').record = async () => {};
    const mails = [];
    const mailer = require('../src/core/utils/mailer');
    mailer.send = async data => { mails.push(data); return { sent: true }; };
    mailer.sendPasswordReset = async data => { mails.push(data); return { sent: true }; };
    const auth = require('../src/modules/auth/auth.service');
    const oauth = require('../src/modules/auth/oauthAccount.service');
    const capabilities = require('../src/modules/auth/accountCapabilities');
    const account = require('../src/modules/members/accountDetails.service');
    const cache = require('../src/core/cache/cacheClient');
    const { CACHE_KEYS } = require('../src/core/cache/cacheKeys');
    const request = require('supertest'); const express = require('express');
    const app = express(); app.use(express.json()); app.use('/auth', require('../src/modules/auth/auth.routes'));
    app.get('/members/my-profile', require('../src/core/middleware/auth').verifyToken, require('../src/modules/members/member.controller').getMyProfile);
    app.use(require('../src/core/middleware/errorHandler').errorHandler);
    const safe = value => {
        const serialized = JSON.stringify(value);
        assert(!serialized.includes('"password":')); assert(!serialized.includes('resetPasswordToken'));
        assert(!serialized.includes('$2b$')); assert(!serialized.includes('$2a$'));
    };
    assert.deepEqual(capabilities.describe(null, null), { hasPassword: false, linkedProviders: [], passwordStatus: 'not_set' });
    assert.equal(capabilities.describe({ password: null }, [{ provider: 'google' }]).hasPassword, false);
    assert.deepEqual(capabilities.describe({ password: 'hash' }, [{ provider: 'google' }, { provider: 'google' }, { provider: 'invalid' }]),
        { hasPassword: true, linkedProviders: ['google'], passwordStatus: 'legacy_unknown' });
    passed('null/legacy capabilities are defensive, provider allowlisted and deduplicated');

    const sessions = [];
    for (const provider of ['google', 'linkedin', 'facebook']) {
        const email = `${provider}@example.test`;
        const code = await oauth.create(provider, { subject: `${provider}-subject`, email, verified: provider !== 'facebook', name: `${provider} Member` });
        let session = await oauth.exchange(code);
        if (provider === 'facebook') {
            assert.equal(session.requiresEmailVerification, true);
            await oauth.requestEmail(code, email);
            const otp = mails.at(-1).text.match(/code is (\d{6})/)[1];
            session = await oauth.exchange(code, { verificationCode: otp });
        }
        sessions.push(session);
        assert.deepEqual({ hasPassword: session.user.hasPassword, linkedProviders: session.user.linkedProviders, passwordStatus: session.user.passwordStatus },
            { hasPassword: false, linkedProviders: [provider], passwordStatus: 'not_set' });
        const stored = await Auth.findOne({ email }).select('+password').lean();
        assert.equal(stored.password, undefined); assert.equal(stored.passwordLoginEnabled, false);
        await assert.rejects(auth.login(email, 'invented-password'), /Invalid credentials/);
        const again = await oauth.exchange(await oauth.create(provider, { subject: `${provider}-subject`, verified: false }));
        assert.equal(String(again.user.id), String(session.user.id));
        safe(session);
        passed(`${provider} registers and signs in again without creating a fake ACTIV password`);
    }
    const social = sessions[0]; const socialId = String(social.user.id);
    for (const endpoint of ['/auth/me', '/members/my-profile']) {
        const response = await request(app).get(endpoint).set('Authorization', `Bearer ${social.token}`).expect(200);
        assert.equal(response.body.data.hasPassword, false);
        assert.equal(response.body.data.passwordStatus, 'not_set'); assert.deepEqual(response.body.data.linkedProviders, ['google']); safe(response.body);
    }
    passed('both authenticated profile APIs expose capabilities without credential material');
    await request(app).post('/auth/change-password').set('Authorization', `Bearer ${social.token}`)
        .send({ oldPassword: 'made-up', newPassword: 'New-password-2026' }).expect(400).expect(res => assert.match(res.body.message, /email password reset/));
    await assert.rejects(account.update(await Member.findById(socialId), { password: 'New-password-2026', confirmPassword: 'New-password-2026' }), /email password reset/);
    assert.equal((await Auth.findOne({ email: social.user.email }).select('+password')).password, undefined);
    passed('neither password endpoint permits session-only first-password setup');

    // An administrator's authorized reset rollback must restore the absent
    // password as well as its marker if saving the profile fails afterward.
    const failingMember = await Member.findById(socialId);
    failingMember.save = async () => { throw new Error('Fixture profile write failure'); };
    await assert.rejects(account.update(failingMember, { password: 'Admin-password-2026' }, { admin: true }), /Fixture/);
    const rolledBack = await Auth.findOne({ email: social.user.email }).select('+password').lean();
    assert.equal(rolledBack.password, undefined); assert.equal(rolledBack.passwordLoginEnabled, false);
    passed('account rollback restores social-only state without leaving a newly assigned password');

    const response = await request(app).post('/auth/forgot-password').send({ email: social.user.email, portal: 'member' }).expect(200);
    assert.equal(response.body.data.channel, 'email'); safe(response.body);
    const resetToken = new URL(mails.at(-1).resetUrl).searchParams.get('token'); assert(resetToken);
    const pending = await Auth.findOne({ email: social.user.email }).select('+resetPasswordToken +resetPasswordExpires').lean();
    assert.notEqual(pending.resetPasswordToken, resetToken);
    await request(app).get('/auth/reset-password/verify').query({ token: resetToken, portal: 'member' }).expect(200).expect(res => assert.equal(res.body.data.valid, true));
    await request(app).post('/auth/reset-password').send({ token: 'invalid', newPassword: 'Chosen-password-2026', portal: 'member' }).expect(400);
    const resets = await Promise.allSettled([auth.resetPassword(resetToken, 'Chosen-password-2026', { portal: 'member' }), auth.resetPassword(resetToken, 'Chosen-password-2026', { portal: 'member' })]);
    assert.equal(resets.filter(value => value.status === 'fulfilled').length, 1);
    await assert.rejects(auth.resetPassword(resetToken, 'Another-password-2026', { portal: 'member' }), /invalid or has expired/);
    const after = await auth.login(social.user.email, 'Chosen-password-2026');
    assert.equal(after.user.hasPassword, true); assert.equal(after.user.passwordStatus, 'set'); assert.deepEqual(after.user.linkedProviders, ['google']);
    safe(after); passed('verified email setup atomically consumes its token once and enables password login');
    // Even a preexisting profile cache must not override current capabilities.
    await cache.set(CACHE_KEYS.USER(socialId), { email: social.user.email, role: 'member', hasPassword: false, passwordStatus: 'not_set' }, 3600);
    assert.equal((await auth.getCurrentUser(socialId)).hasPassword, true);
    const providerAfter = await oauth.exchange(await oauth.create('google', { subject: 'google-subject', verified: false }));
    assert.equal(providerAfter.user.passwordStatus, 'set'); assert.equal(String(providerAfter.user.id), socialId);
    await assert.rejects(auth.changePassword(socialId, '', 'Replacement-2026'), /Current password/);
    await assert.rejects(auth.changePassword(socialId, 'wrong', 'Replacement-2026'), /Current password/);
    await assert.rejects(account.update(await Member.findById(socialId), { password: 'Replacement-2026', confirmPassword: 'Replacement-2026', currentPassword: 'wrong' }), /Current password/);
    await auth.changePassword(socialId, 'Chosen-password-2026', 'Replacement-2026');
    assert((await auth.login(social.user.email, 'Replacement-2026')).token);
    passed('linked password accounts retain both sign-in methods and all current-password checks');

    const passwordAccount = await auth.register({ email: 'password@example.test', password: 'Original-password-2026', fullName: 'Password Member', phoneNumber: '9123456780', whatsappNumber: '9123456780', state: 'Tamil Nadu', district: 'Chennai' });
    assert.equal(passwordAccount.user.passwordStatus, 'set'); assert.equal(passwordAccount.user.hasPassword, true); assert.deepEqual(passwordAccount.user.linkedProviders, []);
    const linked = await oauth.exchange(await oauth.create('linkedin', { subject: 'password-link', email: 'password@example.test', verified: true, name: 'Password Member' }));
    assert.equal(String(linked.user.id), String(passwordAccount.user.id)); assert.equal(linked.user.passwordStatus, 'set');
    await assert.rejects(auth.changePassword(passwordAccount.user.id, 'wrong', 'Never-saved-2026'), /Current password/);
    assert((await auth.login('password@example.test', 'Original-password-2026')).token);
    passed('linking a provider to an existing password account never downgrades its credentials');

    await Auth.updateOne({ email: 'password@example.test' }, { $unset: { passwordLoginEnabled: '' } });
    assert.equal((await capabilities.forMemberEmail('password@example.test')).passwordStatus, 'legacy_unknown');
    const legacy = await auth.login('password@example.test', 'Original-password-2026');
    assert.equal(legacy.user.passwordStatus, 'legacy_unknown'); assert.equal(legacy.user.hasPassword, true);
    await assert.rejects(auth.changePassword(passwordAccount.user.id, '', 'Never-saved-2026'), /Current password/);
    await auth.changePassword(passwordAccount.user.id, 'Original-password-2026', 'Legacy-chosen-2026');
    assert.equal((await capabilities.forMemberEmail('password@example.test')).passwordStatus, 'set');
    passed('legacy linked hashes remain usable and protected until a verified password write resolves ambiguity');

    const linkedAuth = await Auth.findOne({ email: 'password@example.test' });
    await Identity.deleteMany({ authId: linkedAuth._id });
    await Auth.updateOne({ _id: linkedAuth._id }, { $unset: { passwordLoginEnabled: '' } });
    assert.equal((await capabilities.forMemberEmail('password@example.test')).passwordStatus, 'set');
    passed('legacy ordinary password accounts retain the normal password interface');

    const accountForReset = await auth.resettableByEmail(sessions[1].user.email, 'member');
    const expired = await auth.issueResetToken(accountForReset, -1);
    await assert.rejects(auth.resetPassword(expired, 'Never-saved-2026', { portal: 'member' }), /invalid or has expired/);
    const blockedToken = await auth.issueResetToken(accountForReset);
    await Member.updateOne({ _id: sessions[1].user.id }, { $set: { isActive: false } });
    assert.equal((await auth.verifyResetToken(blockedToken, { portal: 'member' })).valid, false);
    await assert.rejects(auth.resetPassword(blockedToken, 'Never-saved-2026', { portal: 'member' }), /invalid or has expired/);
    passed('expired tokens and accounts blocked after email issuance cannot set a password');
    console.log(`PASS: ${checks} account/password integration checks; disposable MongoDB and intercepted mail only.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(process.exitCode || 0);
});
