/**
 * End-to-end test of the geofenced 3-tier approval workflow against a running
 * server and a real MongoDB.
 *
 *   BASE_URL=http://localhost:5055 node tests/e2e-approval-flow.test.js
 *
 * SAFETY: every document this test creates lives in a synthetic region
 * ("E2E Test State" / "E2E Test District" / "E2E Test Block") tagged with a
 * unique run id, so it cannot collide with or mutate real applications. All
 * created ids are tracked and removed in the cleanup phase, which runs even if
 * an assertion fails.
 */
require('dotenv').config();

const assert = require('assert');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5055';
const API = `${BASE_URL}/api/v1`;
const RUN = `e2e${Date.now()}`;

// Synthetic geography, isolated from anything real in the database.
const REGION = {
    state: 'E2E Test State',
    district: 'E2E Test District',
    block: 'E2E Test Block'
};
// A second region used to prove the geofence actually isolates admins.
const OTHER_REGION = {
    state: 'E2E Other State',
    district: 'E2E Other District',
    block: 'E2E Other Block'
};

const PASSWORD = 'E2ePassw0rd!';

// Three of the four member models write to legacy, human-named collections —
// NOT to the pluralised names Mongoose would infer. Cleanup must target these
// exact names or the test leaves orphaned rows behind in real collections.
//
// `MemberDetails` is the exception and was wrong here: its schema declares
// `collection: 'users'`, while this map still named the retired `web users`.
// Both halves of that failed silently in opposite directions — every assertion
// that a member profile had been created read an empty collection and reported
// "MemberDetails not created", and the cleanup then deleted from that same
// empty collection, so each run left two synthetic member rows behind in the
// real `users` collection of the shared cluster.
const COL = {
    details: 'users',                                  // MemberDetails
    business: 'additional form for bussiness 2',       // BusinessInfo  (sic)
    financial: 'additional form for financial 3',      // MemberFinancialInfo
    declaration: 'additional form for declaration 4'   // MemberDeclaration
};

let passed = 0;
let failed = 0;
const created = { admins: [], applications: [], memberauths: [], memberdetails: [], other: [] };

const test = async(name, fn) => {
    try {
        await fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${error.message}`);
    }
};

const section = (title) => console.log(`\n${title}`);

const request = async(method, path, { token, body } = {}) => {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });

    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, body: json };
};

const login = async(email) => {
    const res = await request('POST', '/auth/login', { body: { email, password: PASSWORD } });
    if (res.status !== 200) {
        throw new Error(`login failed for ${email}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
    }
    const token = res.body?.data?.token || res.body?.token;
    if (!token) throw new Error(`no token in login response for ${email}`);
    return token;
};

const bucketIds = (payload, bucket) =>
    ((payload?.applicants && payload.applicants[bucket]) || []).map(a => a.id);

(async() => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    console.log(`\nConnected to ${mongoose.connection.name}`);
    console.log(`Server:   ${BASE_URL}`);
    console.log(`Run id:   ${RUN}`);

    // Snapshot the real data so we can prove at the end that we did not touch it.
    const realAppCountBefore = await db.collection('applications').countDocuments();
    const realStatusesBefore = await db.collection('applications')
        .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();

    try {
        // ---------------------------------------------------------------
        section('Setup: seed isolated admins and one application');
        // ---------------------------------------------------------------
        const hash = await bcrypt.hash(PASSWORD, 10);

        const adminSpecs = [
            { key: 'block', role: 'block_admin', ...REGION },
            { key: 'district', role: 'district_admin', state: REGION.state, district: REGION.district },
            { key: 'state', role: 'state_admin', state: REGION.state },
            { key: 'otherBlock', role: 'block_admin', ...OTHER_REGION }
        ];

        const emails = {};
        for (const spec of adminSpecs) {
            // Lowercase: login normalizes the address before looking it up, so a
            // seeded address with any uppercase character would never be found.
            const email = `${RUN}.${spec.key}@e2e.invalid`.toLowerCase();
            emails[spec.key] = email;
            const doc = {
                email,
                password: hash,
                role: spec.role,
                fullName: `E2E ${spec.role}`,
                state: spec.state,
                district: spec.district,
                block: spec.block,
                isActive: true,
                __e2e: RUN
            };
            const r = await db.collection('admins').insertOne(doc);
            created.admins.push(r.insertedId);
        }
        console.log(`  seeded ${created.admins.length} admins`);

        // The applicant, and the application itself at stage 1.
        const memberAuthRes = await db.collection('memberauths').insertOne({
            email: `${RUN}.member@e2e.invalid`,
            password: hash,
            isActive: true,
            __e2e: RUN
        });
        created.memberauths.push(memberAuthRes.insertedId);
        const applicantUserId = memberAuthRes.insertedId;

        const appRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Applicant',
            email: `${RUN}.member@e2e.invalid`,
            phone: '9000000001',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'Pending-Block',
            reviewedBy: {},
            data: {
                personalDetails: {
                    fullName: 'E2E Applicant',
                    state: REGION.state,
                    district: REGION.district,
                    block: REGION.block,
                    city: 'E2E City',
                    aadhaarNumber: '999999999999',
                    education: 'Graduate',
                    religion: 'NA',
                    socialCategory: 'Others'
                },
                businessInfo: {
                    doingBusiness: true,
                    organizationName: 'E2E Traders',
                    constitutionType: 'Proprietorship',
                    businessTypes: ['Trader'],
                    businessActivities: 'Testing',
                    businessCommencementYear: '2020',
                    numberOfEmployees: '5'
                },
                financialInfo: {
                    panNumber: 'AAAAA1111A',
                    gstNumber: '33AAAAA1111A1Z5',
                    itrFiled: true,
                    turnoverRange: '1-5 Lakhs',
                    govtSchemeBenefit: false
                },
                declaration: {
                    sisterConcerns: false,
                    companyNames: [],
                    agreeToDeclaration: true
                }
            },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(appRes.insertedId);
        const appId = appRes.insertedId.toString();
        console.log(`  seeded application ${appId} at Pending-Block`);

        const tokens = {
            block: await login(emails.block),
            district: await login(emails.district),
            state: await login(emails.state),
            otherBlock: await login(emails.otherBlock)
        };
        console.log('  logged in all four admins');

        // ---------------------------------------------------------------
        section('JWT carries the geofence claims');
        // ---------------------------------------------------------------
        await test('district admin token includes its district', () => {
            const claims = JSON.parse(Buffer.from(tokens.district.split('.')[1], 'base64').toString());
            assert.strictEqual(claims.district, REGION.district,
                `expected district '${REGION.district}' in token, got '${claims.district}'`);
            assert.strictEqual(claims.state, REGION.state);
        });

        await test('block admin token includes its block', () => {
            const claims = JSON.parse(Buffer.from(tokens.block.split('.')[1], 'base64').toString());
            assert.strictEqual(claims.block, REGION.block);
        });

        // ---------------------------------------------------------------
        section('Stage 1: application starts in the Block queue only');
        // ---------------------------------------------------------------
        let blockDash = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
        let districtDash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
        let stateDash = (await request('GET', '/admin/state/dashboard', { token: tokens.state })).body?.data;

        await test('appears in Block pending', () => {
            assert.ok(bucketIds(blockDash, 'pending').includes(appId), 'not in block pending');
        });

        await test('District pending queue is EMPTY before block approval', () => {
            assert.ok(!bucketIds(districtDash, 'pending').includes(appId),
                'application reached the district queue before the block approved it');
        });

        await test('State pending queue is EMPTY before block approval', () => {
            assert.ok(!bucketIds(stateDash, 'pending').includes(appId));
        });

        // ---------------------------------------------------------------
        section('Geofence isolation');
        // ---------------------------------------------------------------
        await test('an admin from another block sees none of this block\'s applications', async() => {
            const other = (await request('GET', '/admin/block/dashboard', { token: tokens.otherBlock })).body?.data;
            assert.ok(!bucketIds(other, 'all').includes(appId),
                'out-of-region admin could see the application');
        });

        await test('out-of-region approve is rejected with 403', async() => {
            const res = await request('POST', `/applications/${appId}/block-review`, {
                token: tokens.otherBlock,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 403, `expected 403, got ${res.status} ${JSON.stringify(res.body)}`);
        });

        await test('the refused approve did not change the status', async() => {
            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Pending-Block');
        });

        // ---------------------------------------------------------------
        section('Out-of-order transitions are refused');
        // ---------------------------------------------------------------
        await test('district cannot approve before the block has', async() => {
            const res = await request('POST', `/applications/${appId}/district-review`, {
                token: tokens.district,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        await test('state cannot approve before the district has', async() => {
            const res = await request('POST', `/applications/${appId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        await test('a block admin cannot call the district endpoint at all (role gate)', async() => {
            const res = await request('POST', `/applications/${appId}/district-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        });

        // ---------------------------------------------------------------
        section('Stage 1 -> 2: Block approves');
        // ---------------------------------------------------------------
        await test('block approve returns 200 and forwards to district', async() => {
            const res = await request('POST', `/applications/${appId}/block-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Pending-District');
        });

        await test('blockApprovedAt was persisted', async() => {
            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Pending-District');
            assert.ok(doc.blockApprovedAt instanceof Date, 'blockApprovedAt not stored as a Date');
        });

        blockDash = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
        districtDash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
        stateDash = (await request('GET', '/admin/state/dashboard', { token: tokens.state })).body?.data;

        await test('now in District pending', () => {
            assert.ok(bucketIds(districtDash, 'pending').includes(appId), 'not in district pending');
        });

        await test('left the Block pending queue and is Block-approved', () => {
            assert.ok(!bucketIds(blockDash, 'pending').includes(appId), 'still in block pending');
            assert.ok(bucketIds(blockDash, 'approved').includes(appId), 'not in block approved');
        });

        await test('NOT double-counted as district-approved while district-pending', () => {
            assert.ok(!bucketIds(districtDash, 'approved').includes(appId),
                'appears in both district pending and district approved');
        });

        await test('State pending queue is still EMPTY', () => {
            assert.ok(!bucketIds(stateDash, 'pending').includes(appId));
        });

        // ---------------------------------------------------------------
        section('Stage 2 -> 3: District approves');
        // ---------------------------------------------------------------
        await test('district approve returns 200 and forwards to state', async() => {
            const res = await request('POST', `/applications/${appId}/district-review`, {
                token: tokens.district,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Pending-State');
        });

        await test('districtApprovedAt was persisted', async() => {
            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Pending-State');
            assert.ok(doc.districtApprovedAt instanceof Date);
        });

        districtDash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
        stateDash = (await request('GET', '/admin/state/dashboard', { token: tokens.state })).body?.data;

        await test('now in State pending', () => {
            assert.ok(bucketIds(stateDash, 'pending').includes(appId), 'not in state pending');
        });

        await test('left the District pending queue and is District-approved', () => {
            assert.ok(!bucketIds(districtDash, 'pending').includes(appId));
            assert.ok(bucketIds(districtDash, 'approved').includes(appId));
        });

        // ---------------------------------------------------------------
        section('Stage 3: State grants final approval and the member is created');
        // ---------------------------------------------------------------
        await test('state approve returns 200 and reports Approved', async() => {
            const res = await request('POST', `/applications/${appId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Approved');
        });

        await test('stateApprovedAt was persisted and status is Approved', async() => {
            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Approved');
            assert.ok(doc.stateApprovedAt instanceof Date);
        });

        await test('member profile created across all 4 collections', async() => {
            // Key fields differ per model: details/business/declaration use
            // `userId`, financial uses `memberId`.
            const memberDetails = await db.collection(COL.details).findOne({ userId: applicantUserId });
            assert.ok(memberDetails, `MemberDetails not created in '${COL.details}'`);

            const businessInfo = await db.collection(COL.business).findOne({ userId: applicantUserId });
            assert.ok(businessInfo, `BusinessInfo not created in '${COL.business}'`);

            const financial = await db.collection(COL.financial).findOne({ memberId: applicantUserId });
            assert.ok(financial, `MemberFinancialInfo not created in '${COL.financial}'`);

            const declaration = await db.collection(COL.declaration).findOne({ memberId: applicantUserId });
            assert.ok(declaration, `MemberDeclaration not created in '${COL.declaration}'`);
        });

        await test('approved member is linked back to their user account', async() => {
            const memberDetails = await db.collection(COL.details).findOne({ userId: applicantUserId });
            assert.ok(memberDetails, 'member profile has no userId link');
            assert.strictEqual(String(memberDetails.userId), String(applicantUserId));
        });

        await test('created member carries the correct geography', async() => {
            const memberDetails = await db.collection(COL.details).findOne({ userId: applicantUserId });
            assert.ok(memberDetails, 'member profile not found');
            assert.strictEqual(memberDetails.block, REGION.block);
            assert.strictEqual(memberDetails.district, REGION.district);
            assert.strictEqual(memberDetails.state, REGION.state);
        });

        await test('terminal state: re-approving is refused', async() => {
            const res = await request('POST', `/applications/${appId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        // ---------------------------------------------------------------
        section('Final approval is atomic');
        // ---------------------------------------------------------------
        // Drive an application to Pending-State, then make member creation fail
        // and assert the application is NOT left stranded in the terminal
        // 'Approved' state with no member record.
        //
        // The failure is forced with an out-of-enum `turnoverRange`, which makes
        // MemberFinancialInfo.save() throw partway through the profile write.
        // (A duplicate email no longer fails: registration already creates the
        // member row, so approval updates it in place by design.)
        const atomicAuth = await db.collection('memberauths').insertOne({
            email: `${RUN}.atomic@e2e.invalid`, password: hash, isActive: true, __e2e: RUN
        });
        created.memberauths.push(atomicAuth.insertedId);

        const atomicRes = await db.collection('applications').insertOne({
            userId: atomicAuth.insertedId,
            fullName: 'E2E Atomic Applicant',
            email: `${RUN}.atomic@e2e.invalid`,
            phone: '9000000005',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'Pending-State',
            blockApprovedAt: new Date(),
            districtApprovedAt: new Date(),
            reviewedBy: {},
            data: {
                personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state },
                // Not a member of the turnoverRange enum -> save() throws.
                financialInfo: { turnoverRange: 'NOT-A-VALID-RANGE' }
            },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(atomicRes.insertedId);
        const atomicId = atomicRes.insertedId.toString();

        await test('approval fails loudly when member creation cannot complete', async() => {
            const res = await request('POST', `/applications/${atomicId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 500, `expected 500, got ${res.status}`);
            assert.ok(/turnoverRange|Failed to create member profile/i.test(res.body?.message || ''),
                `error message should name the cause, got: ${res.body?.message}`);
        });

        await test('nothing was left behind by the rolled-back approval', async() => {
            const orphan = await db.collection(COL.details).findOne({ userId: atomicAuth.insertedId });
            assert.ok(!orphan, 'a member row survived the failed approval');
        });

        await test('a failed approval leaves the application retryable, not stranded', async() => {
            const doc = await db.collection('applications').findOne({ _id: atomicRes.insertedId });
            assert.strictEqual(doc.status, 'Pending-State',
                `expected the application to stay at Pending-State, found '${doc.status}' with no member profile`);
            assert.ok(!doc.stateApprovedAt, 'stateApprovedAt was set despite the failure');
        });

        await test('retry succeeds once the bad data is corrected', async() => {
            await db.collection('applications').updateOne(
                { _id: atomicRes.insertedId },
                { $set: { 'data.financialInfo.turnoverRange': '1-5 Lakhs' } }
            );
            const res = await request('POST', `/applications/${atomicId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));

            const doc = await db.collection('applications').findOne({ _id: atomicRes.insertedId });
            assert.strictEqual(doc.status, 'Approved');
            const member = await db.collection(COL.details).findOne({ userId: atomicAuth.insertedId });
            assert.ok(member, 'member profile missing after successful retry');
        });

        // ---------------------------------------------------------------
        section('Rejection path halts progression');
        // ---------------------------------------------------------------
        const rejectAppRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Reject Applicant',
            email: `${RUN}.reject@e2e.invalid`,
            phone: '9000000002',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'Pending-Block',
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(rejectAppRes.insertedId);
        const rejectId = rejectAppRes.insertedId.toString();

        await test('block reject returns 200', async() => {
            const res = await request('POST', `/applications/${rejectId}/block-review`, {
                token: tokens.block,
                body: { action: 'reject', rejectionReason: 'E2E rejection reason' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Rejected');
        });

        await test('rejectedBy.adminType and rejectedAt persisted', async() => {
            const doc = await db.collection('applications').findOne({ _id: rejectAppRes.insertedId });
            assert.strictEqual(doc.status, 'Rejected');
            assert.strictEqual(doc.rejectedBy?.adminType, 'BlockAdmin');
            assert.ok(doc.rejectedBy?.rejectedAt instanceof Date,
                'rejectedAt missing — it must be nested inside rejectedBy');
            assert.strictEqual(doc.rejectionReason, 'E2E rejection reason');
        });

        await test('a rejected application never reaches the district queue', async() => {
            const dash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
            assert.ok(!bucketIds(dash, 'pending').includes(rejectId), 'rejected file reached district pending');
        });

        await test('block-stage rejection is NOT in the district rejected bucket', async() => {
            const dash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
            assert.ok(!bucketIds(dash, 'rejected').includes(rejectId),
                'district sees a rejection it did not make');
        });

        await test('block-stage rejection IS in the block rejected bucket', async() => {
            const dash = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
            assert.ok(bucketIds(dash, 'rejected').includes(rejectId));
        });

        await test('a rejected application cannot be approved afterwards', async() => {
            const res = await request('POST', `/applications/${rejectId}/block-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        // ---------------------------------------------------------------
        section('Tier-agnostic /approve alias');
        // ---------------------------------------------------------------
        const aliasRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Alias Applicant',
            email: `${RUN}.alias@e2e.invalid`,
            phone: '9000000003',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'Pending-Block',
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(aliasRes.insertedId);
        const aliasId = aliasRes.insertedId.toString();

        await test('POST /:id/approve routes a block admin to the block tier', async() => {
            const res = await request('POST', `/applications/${aliasId}/approve`, { token: tokens.block });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Pending-District');
        });

        await test('POST /:id/approve by the same block admin is now refused', async() => {
            const res = await request('POST', `/applications/${aliasId}/approve`, { token: tokens.block });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        // ---------------------------------------------------------------
        section('Legacy status rows remain actionable');
        // ---------------------------------------------------------------
        const legacyRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Legacy Applicant',
            email: `${RUN}.legacy@e2e.invalid`,
            phone: '9000000004',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'pending_block_approval', // legacy spelling found in live data
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(legacyRes.insertedId);
        const legacyId = legacyRes.insertedId.toString();

        await test("legacy 'pending_block_approval' shows in the Block pending queue", async() => {
            const dash = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
            assert.ok(bucketIds(dash, 'pending').includes(legacyId), 'legacy row missing from block pending');
        });

        await test('legacy row can be approved and is written back canonically', async() => {
            const res = await request('POST', `/applications/${legacyId}/block-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            const doc = await db.collection('applications').findOne({ _id: legacyRes.insertedId });
            assert.strictEqual(doc.status, 'Pending-District');
        });

        // ---------------------------------------------------------------
        section('Real data untouched');
        // ---------------------------------------------------------------
        await test('pre-existing applications were not modified', async() => {
            const after = await db.collection('applications')
                .aggregate([
                    { $match: { __e2e: { $exists: false } } },
                    { $group: { _id: '$status', n: { $sum: 1 } } },
                    { $sort: { _id: 1 } }
                ]).toArray();
            assert.deepStrictEqual(after, realStatusesBefore,
                'status distribution of non-test applications changed');
        });

    } catch (runError) {
        // Record it as a failure so the finally block cannot exit 0 and hide it.
        failed += 1;
        console.error(`\n  ABORTED: ${runError.message}`);
        console.error(runError.stack?.split('\n').slice(1, 4).join('\n') || '');
    } finally {
        // ---------------------------------------------------------------
        section('Cleanup');
        // ---------------------------------------------------------------
        const db2 = mongoose.connection.db;
        const del = async(col, filter) => {
            const r = await db2.collection(col).deleteMany(filter).catch(() => ({ deletedCount: 0 }));
            if (r.deletedCount) console.log(`  removed ${r.deletedCount} from ${col}`);
        };

        // Everything the run created is tagged, plus the member docs the
        // workflow itself generated (which are keyed by the test user id).
        const testUserIds = created.memberauths;
        await del('applications', { __e2e: RUN });
        await del('admins', { __e2e: RUN });
        await del('memberauths', { __e2e: RUN });
        if (testUserIds.length) {
            await del(COL.details, { userId: { $in: testUserIds } });
            await del(COL.business, { userId: { $in: testUserIds } });
            await del(COL.financial, { memberId: { $in: testUserIds } });
            await del(COL.declaration, { $or: [{ userId: { $in: testUserIds } }, { memberId: { $in: testUserIds } }] });
        }
        // Belt and braces: anything this run tagged, plus any row that carries a
        // test email address, in every collection the workflow can write to.
        for (const col of [COL.details, COL.business, COL.financial, COL.declaration]) {
            await del(col, { $or: [{ __e2e: RUN }, { email: new RegExp(`^${RUN}\\.`) }] });
        }

        const finalCount = await db2.collection('applications').countDocuments();
        console.log(`  applications: ${realAppCountBefore} before -> ${finalCount} after`);
        if (finalCount !== realAppCountBefore) {
            console.error('  WARNING: application count differs from the pre-test snapshot');
        }

        await mongoose.disconnect();
        console.log(`\n${passed} passed, ${failed} failed\n`);
        process.exit(failed > 0 ? 1 : 0);
    }
})().catch(async(err) => {
    console.error('\nE2E RUN ABORTED:', err.message);
    try { await mongoose.disconnect(); } catch { /* already closed */ }
    process.exit(1);
});
