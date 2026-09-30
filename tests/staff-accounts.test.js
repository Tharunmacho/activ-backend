/**
 * Site-staff accounts (CMS admin, events admin): the Super Admin maintains
 * their credentials.
 *
 * PURE UNIT, NO DB. The service runs against an in-memory repository fake; the
 * route gate is driven through supertest with signed JWTs and stubbed
 * controllers, so nothing touches Mongo.
 *
 *   node tests/staff-accounts.test.js
 */
const path = require('path');
const mongoose = require('mongoose');

const {
    createStaffAccountsService, planStaffUpdate, passwordProblem, toStaffRow
} = require('../src/modules/admin/staffAccounts.service');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const rejects = async(promise) => {
    try { await promise; return null; } catch (e) { return e; }
};

/* ------------------------------------------------------------ fakes */
const oid = () => new mongoose.Types.ObjectId();
const normalizeRole = (v) => {
    const r = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (r === 'cmsadmin') return 'cms_admin';
    if (r === 'eventsadmin' || r === 'event_admin') return 'events_admin';
    if (r === 'superadmin') return 'super_admin';
    return r;
};

const makeWorld = () => {
    // Two databases: the same CMS account mirrored in both, like production.
    const docs = [
        { _id: oid(), db: 'adminsdb:superadmins', email: 'cms@activ.org.in', fullName: 'CMS Editor', role: 'cms_admin', passwordHash: '$2b$10$oldcmshash', phoneNumber: '9000000001', active: true },
        { _id: oid(), db: 'superadmins', email: 'cms@activ.org.in', fullName: 'CMS Editor', role: 'cms_admin', passwordHash: '$2b$10$oldcmshash' },
        { _id: oid(), db: 'adminsdb:superadmins', email: 'event@gmail.com', fullName: 'Events Desk', role: 'events_admin', passwordHash: '$2b$10$oldevthash', active: true },
        { _id: oid(), db: 'adminsdb:superadmins', email: 'super.admin@activ.com', fullName: 'Super', role: 'super_admin', passwordHash: '$2b$10$superhash', active: true },
        // A superadmins document with NO role: the collection makes it a super admin.
        { _id: oid(), db: 'adminsdb:superadmins', email: 'legacy.super@activ.com', fullName: 'Legacy', passwordHash: '$2b$10$x' },
        { _id: oid(), db: 'adminsdb:blockadmins', email: 'block@activ.com', fullName: 'Block', role: 'block_admin', passwordHash: '$2b$10$b', state: 'Tamil Nadu', district: 'Salem', block: 'Omalur' },
        { _id: oid(), db: 'admins', email: 'district@activ.com', fullName: 'District', role: 'district_admin', password: '$2b$10$d' }
    ];
    const writes = [];
    const audits = [];
    const hashed = [];
    const forgotten = [];

    const toHit = (doc) => ({ doc, source: doc.db.replace('adminsdb:', ''), sourceKey: doc.db, handle: {}, objectId: doc._id });
    const toAdminRow = (doc, source) => ({
        id: String(doc._id),
        fullName: doc.fullName || '',
        email: String(doc.email || '').toLowerCase(),
        phoneNumber: doc.phoneNumber || doc.phone || '',
        role: normalizeRole(doc.role || (source === 'superadmins' ? 'super_admin' : '')),
        roleLabel: 'X',
        active: doc.isActive !== false && doc.active !== false,
        // The real toAdminRow never includes a hash; the fake leaks one on
        // purpose so the test proves toStaffRow drops it regardless.
        passwordHash: doc.passwordHash,
        password: doc.password
    });

    const repository = {
        STAFF_ROLES: ['cms_admin', 'events_admin'],
        normalizeRole,
        toAdminRow,
        findStaff: async() => docs
            .filter(d => ['cms_admin', 'events_admin'].includes(normalizeRole(d.role)))
            .filter((d, i, all) => all.findIndex(o => o.email === d.email) === i)
            .map(d => ({ ...toAdminRow(d, d.db.replace('adminsdb:', '')), source: d.db })),
        findRawById: async(id) => {
            const d = docs.find(x => String(x._id) === String(id));
            return d ? toHit(d) : null;
        },
        findAllRawByEmail: async(email) => docs.filter(d => d.email === String(email).toLowerCase()).map(toHit),
        updateById: async(hit, update) => {
            writes.push({ id: String(hit.objectId), sourceKey: hit.sourceKey, update: { ...update } });
            Object.assign(hit.doc, update);
        }
    };
    const hasher = { hash: async(pw, rounds) => { hashed.push({ pw, rounds }); return `$2b$${rounds}$hashed:${pw.length}`; } };
    const audit = { record: async(entry) => { audits.push(entry); } };
    const memberEmails = new Set(['member@example.com']);

    const service = createStaffAccountsService({
        repository,
        hasher,
        audit,
        memberEmailTaken: async(email) => memberEmails.has(email),
        forgetSession: async(id, emails) => { forgotten.push({ id, emails }); }
    });

    const byEmail = (email, db = 'adminsdb:superadmins') => docs.find(d => d.email === email && d.db === db);
    return { docs, writes, audits, hashed, forgotten, service, byEmail };
};

const ACTOR = { userId: 'super-1', email: 'super.admin@activ.com', role: 'super_admin' };

(async() => {
    console.log('\nvalidation (planStaffUpdate / passwordProblem)');
    {
        const existing = { fullName: 'CMS Editor', email: 'cms@activ.org.in', phoneNumber: '', active: true };
        const p = planStaffUpdate(existing, {});
        check('empty payload changes nothing', p.changed.length === 0 && !p.password);
        check('omitted fields keep stored values', p.update.fullName === 'CMS Editor' && p.update.email === 'cms@activ.org.in');

        const low = planStaffUpdate(existing, { email: '  NEW.Cms@Activ.org.in ' });
        check('email trimmed + lowercased', low.email === 'new.cms@activ.org.in' && low.changed.includes('email'));

        const bad = (payload) => { try { planStaffUpdate(existing, payload); return null; } catch (e) { return e; } };
        check('invalid email rejected', (bad({ email: 'not-an-email' }) || {}).statusCode === 400);
        check('blank name rejected', (bad({ fullName: '   ' }) || {}).statusCode === 400);
        check('bad phone rejected', (bad({ phoneNumber: 'call me' }) || {}).statusCode === 400);
        check('short password rejected', (bad({ password: 'short7!' }) || {}).statusCode === 400);
        check('password over 72 bytes rejected', (bad({ password: 'x'.repeat(73) }) || {}).statusCode === 400);
        check('all-space password rejected', !!passwordProblem('         '));
        check('8-char password accepted', passwordProblem('Abcdef1!') === '');
        check('"false" string deactivates', planStaffUpdate(existing, { active: 'false' }).update.active === false);
        check('password listed as a change by name only',
            JSON.stringify(planStaffUpdate(existing, { password: 'N3w-Strong-Pass' }).changed) === '["password"]');
    }

    console.log('\nno hash leakage');
    {
        const row = toStaffRow({ id: '1', email: 'a@b.co', role: 'cms_admin', passwordHash: 'h', password: 'p', resetPasswordToken: 't' });
        check('toStaffRow drops password, passwordHash, reset token',
            !('password' in row) && !('passwordHash' in row) && !('resetPasswordToken' in row));

        const w = makeWorld();
        const list = await w.service.list();
        const blob = JSON.stringify(list);
        check('list returns only cms + events staff', list.length === 2 && list.every(r => ['cms_admin', 'events_admin'].includes(r.role)));
        check('list contains no hash material', !/\$2b\$|passwordHash|"password"/.test(blob), blob);
        check('super admin never listed', !list.some(r => r.email === 'super.admin@activ.com'));
    }

    console.log('\nsuper_admin and tier-admin protection');
    {
        const w = makeWorld();
        const sup = w.byEmail('super.admin@activ.com');
        const e1 = await rejects(w.service.update(String(sup._id), { password: 'Takeover-123' }, ACTOR));
        check('super_admin record refused (403)', e1 && e1.statusCode === 403, e1 && e1.message);
        const legacy = w.byEmail('legacy.super@activ.com');
        const e2 = await rejects(w.service.update(String(legacy._id), { password: 'Takeover-123' }, ACTOR));
        check('role-less superadmins record treated as super_admin and refused', e2 && e2.statusCode === 403);
        const blk = w.byEmail('block@activ.com', 'adminsdb:blockadmins');
        const e3 = await rejects(w.service.update(String(blk._id), { fullName: 'X' }, ACTOR));
        check('tier admin refused on the staff path', e3 && e3.statusCode === 403);
        const cms = w.byEmail('cms@activ.org.in');
        const e4 = await rejects(w.service.update(String(cms._id), { role: 'super_admin' }, ACTOR));
        check('role change refused', e4 && e4.statusCode === 400);
        const e5 = await rejects(w.service.update('nope', {}, ACTOR));
        check('invalid id -> 400', e5 && e5.statusCode === 400);
        const e6 = await rejects(w.service.update(String(oid()), {}, ACTOR));
        check('unknown id -> 404', e6 && e6.statusCode === 404);
        check('nothing was written by any refused call', w.writes.length === 0 && w.hashed.length === 0);
    }

    console.log('\nuniqueness');
    {
        const w = makeWorld();
        const cms = w.byEmail('cms@activ.org.in');
        const e1 = await rejects(w.service.update(String(cms._id), { email: 'event@gmail.com' }, ACTOR));
        check('email of another staff account -> 409', e1 && e1.statusCode === 409);
        const e2 = await rejects(w.service.update(String(cms._id), { email: 'District@Activ.com' }, ACTOR));
        check('email of a tier admin in the unified collection -> 409 (case-insensitive)', e2 && e2.statusCode === 409);
        const e3 = await rejects(w.service.update(String(cms._id), { email: 'super.admin@activ.com' }, ACTOR));
        check('email of the super admin -> 409', e3 && e3.statusCode === 409);
        const e4 = await rejects(w.service.update(String(cms._id), { email: 'member@example.com' }, ACTOR));
        check('email of a member sign-in -> 409', e4 && e4.statusCode === 409);
        const ok = await w.service.update(String(cms._id), { email: 'CMS@activ.org.in', fullName: 'CMS Editor' }, ACTOR);
        check('own email (mirrored in the other DB) is not a collision', ok && ok.changed.length === 0);
        check('no writes from rejected emails', w.writes.length === 0);
    }

    console.log('\npassword hashing path');
    {
        const w = makeWorld();
        const cms = w.byEmail('cms@activ.org.in');
        const res = await w.service.update(String(cms._id), { password: 'Br4nd-New-Secret' }, ACTOR);
        check('hashed once, cost 10', w.hashed.length === 1 && w.hashed[0].rounds === 10);
        check('written as canonical passwordHash, never the raw password',
            w.writes.every(x => x.update.passwordHash && x.update.passwordHash.startsWith('$2b$10$hashed')
                && !JSON.stringify(x.update).includes('Br4nd-New-Secret')));
        check('reaches BOTH stored copies of the account', w.writes.length === 2
            && new Set(w.writes.map(x => x.sourceKey)).size === 2, JSON.stringify(w.writes.map(x => x.sourceKey)));
        check('mustResetPassword cleared', w.writes.every(x => x.update.mustResetPassword === false));
        check('response carries no hash', !/passwordHash|\$2b\$/.test(JSON.stringify(res)));
        check('cached session/profile dropped', w.forgotten.length === 1 && w.forgotten[0].emails.includes('cms@activ.org.in'));
        const a = w.audits[0] || {};
        check('audited as admin.staff_updated', a.action === 'admin.staff_updated' && a.actorEmail === ACTOR.email);
        check('audit lists "password" but carries neither password nor hash',
            (a.metadata.changed || []).includes('password') && !/Br4nd-New-Secret|\$2b\$/.test(JSON.stringify(a)));
    }

    console.log('\nprofile edits');
    {
        const w = makeWorld();
        const evt = w.byEmail('event@gmail.com');
        const res = await w.service.update(String(evt._id),
            { fullName: 'Events Team', email: 'events@activ.org.in', phoneNumber: '+91 90000 00002', active: false }, ACTOR);
        check('changed set is name, email, phone, deactivated',
            JSON.stringify(res.changed) === '["name","email","phone","deactivated"]', JSON.stringify(res.changed));
        check('no password written when none given', w.writes.every(x => !('passwordHash' in x.update)) && w.hashed.length === 0);
        check('response reflects new values', res.account.email === 'events@activ.org.in' && res.account.active === false);
        check('audit records previous email', (w.audits[0] || {}).metadata.previousEmail === 'event@gmail.com');
        check('sessions are not claimed invalidated (stateless JWT)', res.sessionsInvalidated === false);
    }

    console.log('\nrepository translation (real admin.repository helpers)');
    {
        // Pure functions only; requiring the module does not open a connection.
        const repo = require('../src/modules/admin/admin.repository');
        const seg = repo.translateUpdate({ passwordHash: 'h', phoneNumber: '1', active: true }, 'adminsdb:superadmins');
        check('segregated keeps passwordHash / phoneNumber / active', seg.passwordHash === 'h' && seg.phoneNumber === '1' && seg.active === true);
        const uni = repo.translateUpdate({ passwordHash: 'h', phoneNumber: '1', active: true }, 'admins');
        check('unified writes password / phone / isActive', uni.password === 'h' && uni.phone === '1' && uni.isActive === true);
        check('segregated write clears stale password / phone / isActive',
            JSON.stringify(repo.alternateSpellings({ passwordHash: 'h', phoneNumber: '1', active: true, fullName: 'x' }, 'adminsdb:superadmins').sort())
                === JSON.stringify(['isActive', 'password', 'phone']));
        check('unified write clears stale passwordHash',
            repo.alternateSpellings({ passwordHash: 'h' }, 'admins')[0] === 'passwordHash');

        // updateById with a fake handle: the one write sets the new hash AND
        // unsets the other spelling, so login (password || passwordHash) reads it.
        let op = null;
        await repo.updateById(
            { handle: { updateOne: async(_f, o) => { op = o; } }, sourceKey: 'adminsdb:superadmins', objectId: oid(), doc: { role: 'cms_admin' } },
            { passwordHash: 'NEW' }
        );
        check('updateById: $set passwordHash + $unset password',
            op && op.$set.passwordHash === 'NEW' && op.$unset && op.$unset.password === '' && !('passwordHash' in op.$unset));
    }

    console.log('\nroute gate (super_admin only)');
    {
        // Stub the controllers so the real router can be mounted without models.
        const stub = (file, handlers) => {
            const full = require.resolve(path.join(__dirname, '..', 'src', 'modules', file));
            require.cache[full] = { id: full, filename: full, loaded: true, exports: handlers };
        };
        const reached = (req, res) => res.status(200).json({ reached: true });
        const anyHandler = new Proxy({}, { get: () => reached });
        stub('admin/admin.controller.js', anyHandler);
        stub('members/platinum.controller.js', anyHandler);
        stub('admin/adminMembers.controller.js', anyHandler);

        const express = require('express');
        const request = require('supertest');
        const jwt = require('jsonwebtoken');
        const config = require('../src/config');
        const { errorHandler } = require('../src/core/middleware/errorHandler');
        const app = express();
        app.use(express.json());
        app.use('/admin', require('../src/modules/admin/admin.routes'));
        app.use(errorHandler);
        const as = (role) => `Bearer ${jwt.sign({ userId: String(oid()), email: 'x@y.z', role }, config.jwt.secret)}`;
        const target = `/admin/super/staff-accounts/${oid()}`;

        const r0 = await request(app).get('/admin/super/staff-accounts');
        check('no token -> 401', r0.status === 401, String(r0.status));
        for (const role of ['cms_admin', 'events_admin', 'state_admin', 'district_admin', 'block_admin', 'member']) {
            const r = await request(app).put(target).set('Authorization', as(role)).send({ password: 'Takeover-123' });
            check(`${role} -> 403 on PUT`, r.status === 403, String(r.status));
        }
        const rl = await request(app).get('/admin/super/staff-accounts').set('Authorization', as('cms_admin'));
        check('cms_admin cannot list', rl.status === 403, String(rl.status));
        const rs = await request(app).put(target).set('Authorization', as('super_admin')).send({});
        check('super_admin passes the gate', rs.status === 200 && rs.body.reached === true, String(rs.status));
        const rg = await request(app).get('/admin/super/staff-accounts').set('Authorization', as('super_admin'));
        check('super_admin can list', rg.status === 200, String(rg.status));
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
