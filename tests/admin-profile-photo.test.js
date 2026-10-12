// Real authenticated router/controller and multipart validation; in-memory account/storage fixtures only.
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const stub = (file, exports) => {
    const id = require.resolve(path.join(__dirname, '../src', file));
    require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('config', { jwt: { secret: 'fixture-admin-photo-secret' } });
for (const file of ['admin/admin.service', 'admin/superadmin.service', 'admin/adminBulk.service', 'admin/staffAccounts.service', 'members/membershipplan.service']) stub('modules/' + file, {});
const unused = new Proxy({}, { get: () => (_req, res) => res.status(418).end() });
for (const file of ['admin/adminMembershipDashboard.controller', 'members/platinum.controller', 'admin/adminMembers.controller', 'auth/auth.validators']) stub('modules/' + file, unused);
const writes = [], deletedCache = [], lookups = [];
let invalidations = 0;
stub('modules/admin/admin.repository', {
    findRawByEmail: async email => {
        lookups.push(email);
        return { objectId: 'own-account', handle: { updateOne: async (query, update) => { writes.push({ email, query, update }); return { matchedCount: 1 }; } } };
    },
    invalidate: () => { invalidations++; },
});
stub('core/cache/cacheClient', { del: async key => { deletedCache.push(key); } });
const productionUpload = require('../src/core/middleware/upload');
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: productionUpload.limits, fileFilter: productionUpload.fileFilter });
stub('core/middleware/upload', { single: field => [memoryUpload.single(field), (req, _res, next) => { if (req.file) req.file.filename = 'fixture-avatar.png'; next(); }] });
const app = express();
app.use('/admin', require('../src/modules/admin/admin.routes'));
app.use((error, _req, res, _next) => res.status(error.statusCode || 400).json({ message: error.message }));
const token = role => 'Bearer ' + jwt.sign({ role, userId: 'own-account', email: 'Own@Example.Test' }, 'fixture-admin-photo-secret');

(async () => {
    assert.equal((await request(app).post('/admin/profile/photo')).status, 401);
    for (const role of ['member', 'cms_admin', 'events_admin', 'attendance_admin']) {
        assert.equal((await request(app).post('/admin/profile/photo').set('Authorization', token(role)).attach('photo', Buffer.from('fixture'), { filename: 'avatar.png', contentType: 'image/png' })).status, 403);
    }
    assert.equal(writes.length, 0);
    for (const role of ['block_admin', 'district_admin', 'state_admin', 'super_admin']) {
        const result = await request(app).post('/admin/profile/photo').set('Authorization', token(role))
            .field('email', 'somebody-else@example.test').field('userId', 'other-account')
            .attach('photo', Buffer.from('fixture'), { filename: 'avatar.png', contentType: 'image/png' });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.profilePhoto, '/uploads/fixture-avatar.png');
        assert.equal(writes.at(-1).email, 'own@example.test');
        assert.deepEqual(writes.at(-1).query, { _id: 'own-account' });
        assert.deepEqual(writes.at(-1).update, { $set: { profilePhoto: '/uploads/fixture-avatar.png' } });
    }
    assert.equal(invalidations, 4);
    assert.equal(deletedCache.length, 4);
    assert(lookups.every(email => email === 'own@example.test'));
    const beforeRejected = writes.length;
    assert.equal((await request(app).post('/admin/profile/photo').set('Authorization', token('state_admin'))).status, 400);
    assert.equal((await request(app).post('/admin/profile/photo').set('Authorization', token('state_admin')).attach('photo', Buffer.from('not an image'), { filename: 'report.pdf', contentType: 'application/pdf' })).status, 400);
    assert.equal((await request(app).post('/admin/profile/photo').set('Authorization', token('state_admin')).attach('photo', Buffer.alloc(5 * 1024 * 1024 + 1), { filename: 'large.png', contentType: 'image/png' })).status, 400);
    assert.equal(writes.length, beforeRejected);
    assert.equal((await request(app).post('/admin/super/profile/photo').set('Authorization', token('state_admin'))).status, 403);
    assert.equal((await request(app).post('/admin/super/profile/photo').set('Authorization', token('super_admin')).attach('photo', Buffer.from('fixture'), { filename: 'avatar.png', contentType: 'image/png' })).status, 200);
    // Exercise the real roster projection: own-profile GET reads this warm roster.
    const stored = { _id: '507f1f77bcf86cd799439011', role: 'block_admin', email: 'own@example.test', fullName: 'Own Admin', createdVia: 'fixture', profilePhoto: '/uploads/persisted.png' };
    stub('config/logger', { warn() {}, info() {}, error() {} });
    const collection = name => ({ find: (_filter, { projection }) => ({ limit() { return this; }, toArray: async () => name === 'blockadmins'
        ? [Object.fromEntries(Object.entries(stored).filter(([key]) => projection[key]))] : [] }) });
    stub('modules/admin/adminsDb', { ensureReady: async () => {}, isReady: () => true, getConnection: () => ({ db: { collection } }) });
    stub('config/dataLayout', { ADMIN_COLLECTIONS: { block_admin: 'blockadmins', district_admin: 'districtadmins', state_admin: 'stateadmins', super_admin: 'superadmins' }, dbName: () => 'fixture-admins' });
    delete require.cache[require.resolve('../src/modules/admin/admin.repository')];
    const repository = require('../src/modules/admin/admin.repository');
    const roster = await repository.findAll();
    assert.equal(roster.find(row => row.email === stored.email)?.profilePhoto, '/uploads/persisted.png');
    console.log('Admin photo: four authorized roles, own-account writes, cache invalidation, image/5 MB limits, denied roles and compatible super route passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
