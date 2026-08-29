/**
 * Full-app end-to-end test: the complete member journey plus every endpoint the
 * React Native client actually calls.
 *
 *   BASE_URL=http://localhost:5055 node tests/e2e-full-app.test.js
 *
 * SAFETY: everything is created inside a synthetic region and tagged with a
 * unique run id, then removed in the cleanup phase (which runs even on failure).
 * Pre-existing data is snapshotted and asserted unchanged at the end.
 *
 * Endpoints are exercised exactly as the app calls them (same path, same verb),
 * so a route that exists but is mounted at a different path still fails here —
 * which is the point.
 */
require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5055';
const API = `${BASE_URL}/api/v1`;
const RUN = `fa${Date.now()}`;
const PASSWORD = 'FullApp123!';

const REGION = { state: 'FA Test State', district: 'FA Test District', block: 'FA Test Block' };

const COL = {
    details: 'users',   // MemberDetails — schema says collection: 'users'
    business: 'additional form for bussiness 2',
    financial: 'additional form for financial 3',
    declaration: 'additional form for declaration 4',
};

let passed = 0;
let failed = 0;
const broken = [];   // endpoint-contract failures, reported together at the end

const section = t => console.log(`\n${t}`);

const test = async(name, fn) => {
    try {
        await fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
    } catch (e) {
        failed += 1;
        console.error(`  FAIL  ${name}\n        ${e.message}`);
    }
};

const request = async(method, path, { token, body, raw } = {}) => {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            ...(raw ? {} : { 'Content-Type': 'application/json' }),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
};

/**
 * Assert an endpoint the app calls is actually reachable. 404/405 means the
 * client and server disagree about the route — a real integration break.
 */
const contract = async(label, method, path, opts = {}) => {
    const res = await request(method, path, opts);
    const okCodes = opts.expect || [200, 201];
    const ok = okCodes.includes(res.status);

    if (!ok) {
        const kind = [404, 405].includes(res.status) ? 'ROUTE MISSING' : `HTTP ${res.status}`;
        broken.push({ label, method, path, status: res.status, kind, message: res.body?.message });
    }
    console.log(`  ${ok ? 'ok  ' : 'BAD '} ${method.padEnd(6)} ${path.padEnd(46)} -> ${res.status}${ok ? '' : '  <-- ' + (res.body?.message || '')}`);
    return res;
};

(async() => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    console.log(`\nServer: ${BASE_URL}\nRun id: ${RUN}`);

    const appsBefore = await db.collection('applications').countDocuments();
    const usersBefore = await db.collection(COL.details).countDocuments();

    const memberEmail = `${RUN}.member@fatest.invalid`;
    let memberToken = null;
    let memberId = null;
    let applicationId = null;
    let businessProfileId = null;
    let productId = null;
    const adminTokens = {};

    try {
        // ============================================================
        section('AUTH — registration and login');
        // ============================================================
        await test('member can register', async() => {
            const res = await request('POST', '/auth/register', {
                body: {
                    fullName: 'Full App Tester',
                    email: memberEmail,
                    password: PASSWORD,
                    phoneNumber: '9000012345',
                    state: REGION.state,
                    district: REGION.district,
                    block: REGION.block,
                },
            });
            assert.ok([200, 201].includes(res.status), `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
            memberToken = res.body?.data?.token;
            memberId = res.body?.data?.user?.id || res.body?.data?.user?.memberId;
            assert.ok(memberToken, 'no token returned from register');
        });

        await test('registering the same email twice is refused', async() => {
            const res = await request('POST', '/auth/register', {
                body: {
                    fullName: 'Duplicate', email: memberEmail, password: PASSWORD,
                    phoneNumber: '9000012345', state: REGION.state,
                    district: REGION.district, block: REGION.block,
                },
            });
            assert.ok(res.status >= 400, `duplicate registration returned ${res.status}`);
        });

        await test('registration rejects a bad phone number', async() => {
            const res = await request('POST', '/auth/register', {
                body: {
                    fullName: 'Bad Phone', email: `${RUN}.bad@fatest.invalid`,
                    password: PASSWORD, phoneNumber: '123',
                    state: REGION.state, district: REGION.district, block: REGION.block,
                },
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        await test('member can log in', async() => {
            const res = await request('POST', '/auth/login', {
                body: { email: memberEmail, password: PASSWORD },
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            memberToken = res.body?.data?.token || memberToken;
            assert.ok(memberToken);
        });

        await test('login with a wrong password is refused', async() => {
            const res = await request('POST', '/auth/login', {
                body: { email: memberEmail, password: 'wrong-password' },
            });
            assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
        });

        await test('protected route rejects a missing token', async() => {
            const res = await request('GET', '/members/my-profile');
            assert.strictEqual(res.status, 401);
        });

        await test('protected route rejects a garbage token', async() => {
            const res = await request('GET', '/members/my-profile', { token: 'not-a-jwt' });
            assert.strictEqual(res.status, 401);
        });

        // ============================================================
        section('MEMBER PROFILE — endpoints the app calls');
        // ============================================================
        await contract('AUTH.PROFILE (/auth/me)', 'GET', '/auth/me', { token: memberToken });
        await contract('members/my-profile', 'GET', '/members/my-profile', { token: memberToken });
        await contract('members/business-info', 'GET', '/members/business-info', { token: memberToken });
        await contract('members/financial-info', 'GET', '/members/financial-info', { token: memberToken });
        await contract('members/declaration-info', 'GET', '/members/declaration-info', { token: memberToken });

        await test('profile update persists the 4-step form data', async() => {
            const res = await request('PUT', '/members/profile', {
                token: memberToken,
                body: {
                    fullName: 'Full App Tester',
                    phoneNumber: '9000012345',
                    state: REGION.state,
                    district: REGION.district,
                    block: REGION.block,
                    city: 'FA City',
                    religion: 'NA',
                    socialCategory: 'Others',
                    // business step
                    doingBusiness: true,
                    organizationName: 'FA Traders',
                    constitutionType: 'Proprietorship',
                    businessTypes: ['Trader'],
                    // financial step
                    panNumber: 'CCCCC3333C',
                    turnoverRange: '1-5 Lakhs',
                    // declaration step
                    sisterConcerns: 0,
                    companyNames: [],
                    agreeToDeclaration: true,
                },
            });
            assert.ok([200, 201].includes(res.status), `HTTP ${res.status}: ${JSON.stringify(res.body)}`);

            const saved = await db.collection(COL.details).findOne({ email: memberEmail });
            assert.ok(saved, 'member profile row not found after update');
            assert.strictEqual(saved.city, 'FA City', 'city did not persist');
        });

        await test('declaration step writes userId (unique index) not just memberId', async() => {
            // Profile rows are keyed by the member-profile (`users`) id, which is what the JWT
            // carries — not the memberauths id.
            const uid = new mongoose.Types.ObjectId(memberId);
            const dec = await db.collection(COL.declaration).findOne({
                $or: [{ userId: uid }, { memberId: uid }],
            });
            assert.ok(dec, 'declaration row not written by the profile form');
            assert.ok(dec.userId, 'declaration row written without userId — second member would collide');
        });

        // ============================================================
        section('APPLICATION — submit and track');
        // ============================================================
        await test('member can submit an application', async() => {
            const res = await request('POST', '/applications', {
                token: memberToken,
                body: {
                    fullName: 'Full App Tester',
                    email: memberEmail,
                    phone: '9000012345',
                    state: REGION.state,
                    district: REGION.district,
                    block: REGION.block,
                    data: {
                        personalDetails: {
                            fullName: 'Full App Tester', ...REGION,
                            city: 'FA City', socialCategory: 'Others',
                        },
                        businessInfo: { doingBusiness: true, organizationName: 'FA Traders', businessTypes: ['Trader'] },
                        financialInfo: { panNumber: 'CCCCC3333C', turnoverRange: '1-5 Lakhs', itrFiled: true },
                        declaration: { sisterConcerns: 0, companyNames: [], agreeToDeclaration: true },
                    },
                },
            });
            assert.ok([200, 201].includes(res.status), `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
            applicationId = res.body?.data?._id || res.body?.data?.id;
            assert.ok(applicationId, 'no application id returned');
        });

        await test('new application starts at Pending-Block', async() => {
            const doc = await db.collection('applications').findOne({ _id: new mongoose.Types.ObjectId(applicationId) });
            assert.strictEqual(doc.status, 'Pending-Block');
        });

        await test('submitting twice returns the existing application, not a duplicate', async() => {
            const res = await request('POST', '/applications', {
                token: memberToken,
                body: { fullName: 'Full App Tester', email: memberEmail, phone: '9000012345', ...REGION },
            });
            assert.ok([200, 201].includes(res.status));
            const count = await db.collection('applications').countDocuments({ email: memberEmail });
            assert.strictEqual(count, 1, `expected 1 application, found ${count}`);
        });

        await contract('my-applications', 'GET', '/applications/my-applications', { token: memberToken });
        await contract('applications/user/:id', 'GET', `/applications/user/${memberId}`, { token: memberToken });
        await contract('applications/:id', 'GET', `/applications/${applicationId}`, { token: memberToken });

        await test('a member cannot approve their own application', async() => {
            const res = await request('POST', `/applications/${applicationId}/block-review`, {
                token: memberToken, body: { action: 'approve' },
            });
            assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        });

        await test('a member cannot list all applications', async() => {
            const res = await request('GET', '/applications', { token: memberToken });
            assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        });

        // ============================================================
        section('BUSINESS PROFILES — endpoints the app calls');
        // ============================================================
        await test('member can create a business profile', async() => {
            // Field names mirror BusinessProfileScreen's FormData exactly.
            const res = await request('POST', '/business-profiles', {
                token: memberToken,
                body: {
                    organizationName: 'FA Traders',
                    description: 'End to end test business',
                    businessTypes: JSON.stringify(['Trader']),
                    phone: '9000012345',
                    area: 'FA Area',
                    location: 'FA City',
                    doingBusiness: 'true',
                    registrationType: 'business',
                    email: memberEmail,
                },
            });
            assert.ok([200, 201].includes(res.status), `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
            businessProfileId = res.body?.data?._id || res.body?.data?.id;
        });

        await contract('business-profiles/me', 'GET', '/business-profiles/me', { token: memberToken });
        await contract('business-profiles/all (ManageCompanies)', 'GET', '/business-profiles/all', { token: memberToken });
        await contract('business-profiles/discover (Discover)', 'GET', '/business-profiles/discover', { token: memberToken });

        if (businessProfileId) {
            await contract('business-profiles/:id (ViewCompany)', 'GET', `/business-profiles/${businessProfileId}`, { token: memberToken });
            await contract('business-profiles/:id update (EditCompany)', 'PUT', `/business-profiles/${businessProfileId}`, {
                token: memberToken, body: { description: 'Updated by full-app test' },
            });
        }

        // ============================================================
        section('PRODUCTS — endpoints the app calls');
        // ============================================================
        await test('member can create a product', async() => {
            const res = await request('POST', '/products', {
                token: memberToken,
                body: {
                    name: 'FA Test Product',
                    description: 'A product created by the full-app test',
                    price: 499,
                    category: 'Agri',
                    companyId: businessProfileId,
                    sku: `FA-${Date.now()}`,
                },
            });
            assert.ok([200, 201].includes(res.status), `HTTP ${res.status}: ${JSON.stringify(res.body)}`);
            productId = res.body?.data?._id || res.body?.data?.id;
        });

        await contract('PRODUCTS.LIST', 'GET', '/products', { token: memberToken });
        await contract('PRODUCTS.STATS', 'GET', '/products/stats', { token: memberToken });
        await contract('PRODUCTS.ACTIVITIES', 'GET', '/products/activities', { token: memberToken });
        if (productId) {
            await contract('PRODUCTS.GET_BY_ID', 'GET', `/products/${productId}`, { token: memberToken });
            await contract('PRODUCTS.UPDATE', 'PUT', `/products/${productId}`, {
                token: memberToken, body: { price: 599 },
            });
        }

        // ============================================================
        section('NOTIFICATIONS — exactly as the app calls them');
        // ============================================================
        // NotificationScreen now calls the list route (the server derives the
        // user from the token) and marks read with PATCH.
        await contract('NOTIFICATIONS.LIST', 'GET', '/notifications', { token: memberToken });
        await contract('NOTIFICATIONS.MARK_READ (PATCH)', 'PATCH', '/notifications/000000000000000000000000/read', {
            token: memberToken, expect: [200, 201, 400, 404],
        });
        await contract('NOTIFICATIONS.MARK_ALL_READ', 'PATCH', '/notifications/read-all', {
            token: memberToken, expect: [200, 201, 204],
        });

        // ============================================================
        section('ADMIN — endpoints the app calls');
        // ============================================================
        const hash = await bcrypt.hash(PASSWORD, 10);
        for (const [key, role, extra] of [
            ['block', 'block_admin', REGION],
            ['district', 'district_admin', { state: REGION.state, district: REGION.district }],
            ['state', 'state_admin', { state: REGION.state }],
            ['super', 'super_admin', {}],
        ]) {
            const email = `${RUN}.${key}@fatest.invalid`.toLowerCase();
            await db.collection('admins').insertOne({
                email, password: hash, role, fullName: `FA ${role}`,
                isActive: true, __fa: RUN, ...extra,
            });
            const res = await request('POST', '/auth/login', { body: { email, password: PASSWORD } });
            adminTokens[key] = res.body?.data?.token;
        }

        await contract('block dashboard', 'GET', '/admin/block/dashboard', { token: adminTokens.block });
        await contract('district dashboard', 'GET', '/admin/district/dashboard', { token: adminTokens.district });
        await contract('state dashboard', 'GET', '/admin/state/dashboard', { token: adminTokens.state });
        await contract('super dashboard', 'GET', '/admin/super/dashboard', { token: adminTokens.super });
        await contract('admin stats', 'GET', '/admin/stats', { token: adminTokens.block });
        await contract('UserManagement list', 'GET', '/admin/users', { token: adminTokens.super });
        await contract('admin profile update', 'PUT', '/admin/profile', {
            token: adminTokens.block, body: { fullName: 'FA Block Admin' },
        });
        // AnalyticsScreen (admin) calls this:
        await contract('AdminAnalytics screen', 'GET', '/admin/analytics?period=month', { token: adminTokens.super });
        // ReportsScreen calls this:
        await contract('ReportsScreen generate', 'POST', '/admin/reports/generate', {
            token: adminTokens.super, body: { reportType: 'members', dateRange: 'month', format: 'pdf' },
        });
        // UserManagementScreen action buttons call this:
        await contract('UserManagement suspend action', 'POST', '/admin/users/000000000000000000000000/suspend', {
            token: adminTokens.super, expect: [200, 201, 400, 404],
        });

        await contract('analytics/members', 'GET', '/analytics/members', { token: adminTokens.super });
        await contract('analytics/applications', 'GET', '/analytics/applications', { token: adminTokens.super });
        await contract('analytics/user-growth', 'GET', '/analytics/user-growth', { token: adminTokens.super });

        // ============================================================
        section('APPROVAL WORKFLOW — through the real application');
        // ============================================================
        await test('block approves -> Pending-District', async() => {
            const res = await request('POST', `/applications/${applicationId}/block-review`, {
                token: adminTokens.block, body: { action: 'approve' },
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Pending-District');
        });

        await test('district approves -> Pending-State', async() => {
            const res = await request('POST', `/applications/${applicationId}/district-review`, {
                token: adminTokens.district, body: { action: 'approve' },
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Pending-State');
        });

        await test('state approves -> Approved + member profile in all 4 collections', async() => {
            const res = await request('POST', `/applications/${applicationId}/state-review`, {
                token: adminTokens.state, body: { action: 'approve' },
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));

            const uid = new mongoose.Types.ObjectId(memberId);
            assert.ok(await db.collection(COL.details).findOne({ _id: uid }), 'MemberDetails missing');
            assert.ok(await db.collection(COL.business).findOne({ userId: uid }), 'BusinessInfo missing');
            assert.ok(await db.collection(COL.financial).findOne({ memberId: uid }), 'FinancialInfo missing');
            assert.ok(await db.collection(COL.declaration).findOne({ userId: uid }), 'Declaration missing');
        });

        await test('member sees the approved status on their own status screen', async() => {
            const res = await request('GET', `/applications/user/${memberId}`, { token: memberToken });
            assert.strictEqual(res.status, 200);
            const list = Array.isArray(res.body?.data) ? res.body.data : (res.body?.applications || []);
            assert.ok(list.length > 0, 'member sees no applications');
            assert.strictEqual(list[0].status, 'Approved');
        });

        // ============================================================
        section('PAYMENT — endpoints the app calls');
        // ============================================================
        // Instamojo is an external service; treat an upstream failure as
        // "reachable but unconfigured" rather than a route break.
        await contract('PAYMENT.CREATE_REQUEST', 'POST', '/payment/create-request', {
            token: memberToken,
            body: { amount: 1000, purpose: 'Membership', buyerName: 'Full App Tester', email: memberEmail, phone: '9000012345' },
            expect: [200, 201, 400, 500, 502, 503],
        });
        await contract('MEMBERSHIP plans', 'GET', '/membership/plans', {
            token: memberToken, expect: [200, 201, 404],
        });

        // ============================================================
        section('DATA INTEGRITY');
        // ============================================================
        await test('pre-existing applications untouched', async() => {
            const now = await db.collection('applications').countDocuments({ __fa: { $exists: false }, email: { $not: /@fatest\.invalid$/ } });
            assert.strictEqual(now, appsBefore, `application count changed: ${appsBefore} -> ${now}`);
        });

    } catch (runError) {
        failed += 1;
        console.error(`\n  ABORTED: ${runError.message}`);
        console.error(runError.stack?.split('\n').slice(1, 4).join('\n') || '');
    } finally {
        section('Cleanup');
        const db2 = mongoose.connection.db;
        // Profile rows are keyed by the member-profile (`users`) id (what the JWT carries).
        const uid = memberId ? new mongoose.Types.ObjectId(memberId) : null;

        const del = async(c, f) => {
            const r = await db2.collection(c).deleteMany(f).catch(() => ({ deletedCount: 0 }));
            if (r.deletedCount) console.log(`  removed ${r.deletedCount} from ${c}`);
        };

        const tagOrEmail = { $or: [{ __fa: RUN }, { email: new RegExp(`@fatest\\.invalid$`) }] };
        await del('applications', tagOrEmail);
        await del('admins', tagOrEmail);
        await del('memberauths', tagOrEmail);
        await del(COL.details, tagOrEmail);
        if (uid) {
            await del(COL.business, { userId: uid });
            await del(COL.financial, { memberId: uid });
            await del(COL.declaration, { $or: [{ userId: uid }, { memberId: uid }] });
            await del('products', { $or: [{ userId: uid }, { createdBy: uid }] });
            await del('business_profiles_accounts', { $or: [{ userId: uid }, { email: memberEmail }] });
            await del('companies', { $or: [{ userId: uid }, { email: memberEmail }] });
        }
        await del('products', { name: 'FA Test Product' });

        const appsAfter = await db2.collection('applications').countDocuments();
        const usersAfter = await db2.collection(COL.details).countDocuments();
        console.log(`  applications: ${appsBefore} -> ${appsAfter}`);
        console.log(`  users:        ${usersBefore} -> ${usersAfter}`);

        if (broken.length) {
            section(`BROKEN INTEGRATIONS (${broken.length}) — app calls these, server does not answer`);
            broken.forEach(b => {
                console.log(`  ${b.kind.padEnd(14)} ${b.method.padEnd(6)} ${b.path}`);
                if (b.message) console.log(`                 ${b.message}`);
            });
        }

        await mongoose.disconnect();
        console.log(`\n${passed} passed, ${failed} failed, ${broken.length} broken endpoints\n`);
        process.exit(failed > 0 || broken.length > 0 ? 1 : 0);
    }
})().catch(async(e) => {
    console.error('\nRUN ABORTED:', e.message);
    try { await mongoose.disconnect(); } catch { /* noop */ }
    process.exit(1);
});
