// Real loopback Mongo + HTTP. OAuth identity evidence is a fixture; no external sends.
const assert = require('node:assert/strict');
const path = require('node:path');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'first-password-local-fixture', JWT_REFRESH_SECRET: 'first-password-refresh-fixture' });
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
let mongo;
async function main() {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri());
    const Auth = require('../src/modules/auth/auth.model');
    const Member = require('../src/modules/members/memberdetails.model');
    const Identity = require('../src/modules/auth/oauthIdentity.model');
    const Flow = require('../src/modules/auth/oauthFlow.model');
    await Promise.all([Auth.init(), Member.init(), Identity.init(), Flow.init()]);
    require('../src/modules/admin/admin.repository').findRawByEmail = async () => null;
    require('../src/modules/members/paymentReconcile').paymentIsGone = async () => false;
    require('../src/modules/notifications/notification.service').dispatchInBackground = async () => ({ queued: true });
    require('../src/modules/audit/audit.service').record = async () => {};
    const oauth = require('../src/modules/auth/oauthAccount.service');
    const auth = require('../src/modules/auth/auth.service');
    const jwt = require('jsonwebtoken');
    const express = require('express');
    const request = require('supertest');
    const app = express(); app.use(express.json()); app.use('/auth', require('../src/modules/auth/auth.routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const password = 'Fixture-first-password-2026!';
    const social = async (provider, suffix = '') => oauth.exchange(await oauth.create(provider, {
        subject: `${provider}-subject${suffix}`, email: `${provider}${suffix}@example.test`, name: 'Fixture Member', verified: true,
    }));
    const set = (token, body = {}) => request(app).post('/auth/set-password').set('Authorization', `Bearer ${token}`)
        .send({ newPassword: password, confirmPassword: password, ...body });
    assert.equal((await request(app).post('/auth/set-password').send({ newPassword: password, confirmPassword: password })).status, 401);
    for (const provider of ['google', 'facebook', 'linkedin']) {
        const initial = await social(provider);
        assert.equal(initial.user.passwordStatus, 'not_set');
        assert.equal(jwt.decode(initial.token).authProvider, provider);
        assert.equal((await set(initial.token, { confirmPassword: 'Different-password' })).status, 400);
        assert.equal((await set(initial.token, { newPassword: 'short', confirmPassword: 'short' })).status, 400);
        assert.equal((await set(initial.token, { newPassword: 'x'.repeat(73), confirmPassword: 'x'.repeat(73) })).status, 400);
        const expired = jwt.sign({ userId: initial.user.id, email: initial.user.email, role: 'member', authProvider: provider,
            iat: Math.floor(Date.now() / 1000) - 3601 }, process.env.JWT_SECRET, { expiresIn: 7200 });
        assert.equal((await set(expired)).status, 401);
        const noProvider = auth.generateTokens({ _id: initial.user.id, email: initial.user.email, role: 'member' }).accessToken;
        assert.equal((await set(noProvider)).status, 401);
        const results = await Promise.all([set(initial.token), set(initial.token)]);
        assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
        const result = results.find(item => item.status === 200);
        assert.equal(result.body.data.hasPassword, true);
        assert.deepEqual(result.body.data.linkedProviders, [provider]);
        assert(!JSON.stringify(result.body).includes(password));
        const credential = await Auth.findOne({ email: initial.user.email }).select('+password');
        assert.notEqual(credential.password, password);
        assert.equal(await credential.comparePassword(password), true);
        assert.equal(credential.passwordLoginEnabled, true);
        const login = await auth.login(initial.user.email, password, { portal: 'member' });
        assert.equal(String(login.user.id), String(initial.user.id));
        const again = await social(provider);
        assert.equal(String(again.user.id), String(initial.user.id));
        assert.equal(again.user.passwordStatus, 'set');
        assert.equal(await Member.countDocuments({ email: initial.user.email }), 1);
        assert.equal(await Identity.countDocuments({ authId: credential._id, provider }), 1);
        assert.equal((await set(again.token, { newPassword: 'Replacement-password', confirmPassword: 'Replacement-password' })).status, 409);
        await assert.rejects(auth.changePassword(initial.user.id, 'incorrect', 'Replacement-password'), /Current password/);
    }
    const legacy = await social('google', '-legacy');
    const legacyAuth = await Auth.findOne({ email: legacy.user.email }).select('+password');
    legacyAuth.password = password; await legacyAuth.save();
    await Auth.updateOne({ _id: legacyAuth._id }, { $unset: { passwordLoginEnabled: '' } });
    assert.equal((await set(legacy.token)).status, 409, 'An old hash is never overwritten as a first password');
    const unlinked = await social('google', '-unlinked');
    await Identity.deleteOne({ authId: (await Auth.findOne({ email: unlinked.user.email }))._id });
    assert.equal((await set(unlinked.token)).status, 403);
    const blocked = await social('google', '-blocked');
    await Member.updateOne({ _id: blocked.user.id }, { $set: { isActive: false } });
    assert.equal((await set(blocked.token)).status, 401);
    console.log('PASS first password: Google/Facebook/LinkedIn retain the same account through password and social login; HTTP auth, matching/length, recent proof, concurrent saves, legacy hashes and blocked/unlinked accounts.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect(); if (mongo) await mongo.stop();
    process.exit(process.exitCode || 0);
});
