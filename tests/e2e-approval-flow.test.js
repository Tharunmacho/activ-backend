/**
 * End-to-end test of the geofenced PARALLEL approval workflow against a running
 * server and a real MongoDB.
 *
 * An application is submitted to the Block, District and State admin of the
 * applicant's own region at the same time, and the first of them to decide
 * decides it for all three. What this suite asserts is therefore the pair:
 * every tier that covers the applicant CAN see and act on the file, and no
 * other region's admin can see it at all.
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
            status: 'Pending',
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
        console.log(`  seeded application ${appId} as Pending`);

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
        section('One submission reaches all three tiers at once');
        // ---------------------------------------------------------------
        /*
         * The assertion this replaces was the opposite one.
         *
         * It checked that the district and state queues were EMPTY until the
         * block had approved — the defining property of the sequential
         * workflow. The association asked for the three tiers to review in
         * parallel instead, so the same three queues are now checked for the
         * presence of the file rather than its absence, and the geofence
         * section below is what carries the isolation guarantee.
         */
        let blockDash = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
        let districtDash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
        let stateDash = (await request('GET', '/admin/state/dashboard', { token: tokens.state })).body?.data;

        await test('appears in Block pending', () => {
            assert.ok(bucketIds(blockDash, 'pending').includes(appId), 'not in block pending');
        });

        await test('appears in District pending with no block approval', () => {
            assert.ok(bucketIds(districtDash, 'pending').includes(appId),
                'the district admin cannot see an applicant from their own district');
        });

        await test('appears in State pending with no block or district approval', () => {
            assert.ok(bucketIds(stateDash, 'pending').includes(appId),
                'the state admin cannot see an applicant from their own state');
        });

        // ---------------------------------------------------------------
        section('Geofence isolation — the only thing narrowing who sees a file');
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
            assert.strictEqual(doc.status, 'Pending');
        });

        // ---------------------------------------------------------------
        section('Role gates on the named endpoints');
        // ---------------------------------------------------------------
        /*
         * What is still refused, and what no longer is.
         *
         * "District cannot approve before the block has" was the out-of-order
         * rule, and it is gone with the order. The ROLE gate is not: the three
         * named endpoints still belong to their own tier, so a block admin
         * calling `/district-review` is still a 403. That is what stops an
         * approval being recorded under a tier that did not make it.
         */
        await test('a block admin cannot call the district endpoint (role gate)', async() => {
            const res = await request('POST', `/applications/${appId}/district-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        });

        await test('the district CAN record its verdict with no block approval in front of it', async() => {
            const res = await request('POST', `/applications/${appId}/district-review`, {
                token: tokens.district,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            // An ENDORSEMENT. The applicant is not a member: only the State's
            // approval writes the outcome.
            assert.strictEqual(res.body?.data?.status, 'Pending',
                "a district approval must not report the application as Approved");
            assert.strictEqual(res.body?.data?.decidesOutcome, false);
        });

        // ---------------------------------------------------------------
        section('Each tier keeps its own verdict');
        // ---------------------------------------------------------------
        await test("the district's verdict carries the block, and stops there", async() => {
            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Pending', 'an endorsement must not write the outcome');

            assert.strictEqual(doc.reviews?.district?.decision, 'approved');
            assert.strictEqual(doc.reviews?.district?.adminType, 'DistrictAdmin');
            assert.notStrictEqual(doc.reviews?.district?.auto, true, "the district's own decision is not 'auto'");
            assert.ok(doc.reviews?.district?.decidedAt instanceof Date, 'decidedAt not stored as a Date');

            // Carried, and HONESTLY carried: the block's slot names the admin
            // who really signed and is flagged as not the block's own act.
            assert.strictEqual(doc.reviews?.block?.decision, 'approved');
            assert.strictEqual(doc.reviews?.block?.adminType, 'DistrictAdmin');
            assert.strictEqual(doc.reviews?.block?.auto, true);

            // Nothing is carried upwards.
            assert.ok(!doc.reviews?.state?.decidedAt, 'the state is above the district and must not be touched');
            assert.ok(!doc.approvedBy?.adminType, 'approvedBy belongs to the outcome, which has not been written');
        });

        await test('no member profile exists yet — the State has not approved', async() => {
            const memberDetails = await db.collection(COL.details).findOne({ userId: applicantUserId });
            assert.ok(!memberDetails,
                'a district endorsement created a member profile; only the State may enrol');
        });

        blockDash = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
        districtDash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
        stateDash = (await request('GET', '/admin/state/dashboard', { token: tokens.state })).body?.data;

        await test('the district approving moves the block with it, but not the state', () => {
            // The district acted, so the district's own queue shows it approved.
            assert.ok(bucketIds(districtDash, 'approved').includes(appId), 'not in district approved');
            assert.ok(!bucketIds(districtDash, 'pending').includes(appId), 'still in district pending');

            // The block is below it and is carried — it must not be left holding
            // a decision that can no longer change anything.
            assert.ok(bucketIds(blockDash, 'approved').includes(appId), 'the block was not carried');
            assert.ok(!bucketIds(blockDash, 'pending').includes(appId), 'the block is still being asked');

            // The state is ABOVE it and keeps its own decision.
            assert.ok(bucketIds(stateDash, 'pending').includes(appId),
                "the state's queue lost an applicant it has never reviewed");
        });

        await test('the district cannot record a second verdict', async() => {
            const res = await request('POST', `/applications/${appId}/district-review`, {
                token: tokens.district,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        await test('the carried block is no longer offered a decision', async() => {
            // The screen this rule came from: a block admin looking at a live
            // Approve / Reject pair on a file already settled above them.
            const res = await request('POST', `/applications/${appId}/block-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
            assert.ok(/already/i.test(res.body?.message || ''),
                `expected a message naming what happened, got: ${res.body?.message}`);
        });

        // ---------------------------------------------------------------
        section("The State's approval is what enrols the member");
        // ---------------------------------------------------------------
        await test('the state approval writes the outcome and creates the member', async() => {
            const res = await request('POST', `/applications/${appId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Approved');
            assert.strictEqual(res.body?.data?.decidesOutcome, true);

            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Approved');
            assert.strictEqual(doc.approvedBy?.adminType, 'StateAdmin');
            assert.ok(doc.approvedBy?.approvedAt instanceof Date, 'approvedAt not stored as a Date');
            assert.ok(doc.stateApprovedAt instanceof Date,
                'stateApprovedAt is what the member screens read as the approval date');
            // All three verdicts survived the approval's transaction.
            assert.strictEqual(doc.reviews?.block?.decision, 'approved');
            assert.strictEqual(doc.reviews?.district?.decision, 'approved');
            assert.strictEqual(doc.reviews?.state?.decision, 'approved');
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

        await test('a tier that has already spoken is told plainly, not asked twice', async() => {
            const res = await request('POST', `/applications/${appId}/block-review`, {
                token: tokens.block,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
            assert.ok(/already/i.test(res.body?.message || ''),
                `expected a message naming what happened, got: ${res.body?.message}`);
        });

        await test('terminal outcome: the state admin cannot re-approve', async() => {
            // Two member profiles for one applicant is the failure this stops,
            // and the unique email index would make the second unrecoverable.
            const res = await request('POST', `/applications/${appId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
            assert.ok(/already been approved/i.test(res.body?.message || ''),
                `expected a message naming what happened, got: ${res.body?.message}`);
        });

        await test('nor can the state REJECT somebody it has already enrolled', async() => {
            const res = await request('POST', `/applications/${appId}/state-review`, {
                token: tokens.state,
                body: { action: 'reject', rejectionReason: 'should be refused' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);

            const doc = await db.collection('applications').findOne({ _id: appRes.insertedId });
            assert.strictEqual(doc.status, 'Approved', 'a refused rejection changed the outcome');
        });

        // ---------------------------------------------------------------
        section('Approval is atomic');
        // ---------------------------------------------------------------
        // Make member creation fail and assert the application is NOT left
        // stranded in the terminal 'Approved' state with no member record.
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
            status: 'Pending',
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
            assert.strictEqual(doc.status, 'Pending',
                `expected the application to stay Pending, found '${doc.status}' with no member profile`);
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
        section('A lower tier objects; only the State closes the file');
        // ---------------------------------------------------------------
        const rejectAppRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Reject Applicant',
            email: `${RUN}.reject@e2e.invalid`,
            phone: '9000000002',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'Pending',
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(rejectAppRes.insertedId);
        const rejectId = rejectAppRes.insertedId.toString();

        await test("a block objection is recorded and does NOT close the application", async() => {
            const res = await request('POST', `/applications/${rejectId}/block-review`, {
                token: tokens.block,
                body: { action: 'reject', rejectionReason: 'E2E rejection reason' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Pending',
                'a block rejection ended the application; only the State decides it');
            assert.strictEqual(res.body?.data?.decidesOutcome, false);

            const doc = await db.collection('applications').findOne({ _id: rejectAppRes.insertedId });
            assert.strictEqual(doc.status, 'Pending');
            assert.strictEqual(doc.reviews?.block?.decision, 'rejected');
            assert.strictEqual(doc.reviews?.block?.reason, 'E2E rejection reason');
            assert.ok(doc.reviews?.block?.decidedAt instanceof Date);
            assert.ok(!doc.rejectedBy?.adminType,
                'rejectedBy belongs to the outcome, which a block cannot write');
        });

        await test("the block's objection leaves the other two tiers holding it", async() => {
            const blockOnly = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
            assert.ok(bucketIds(blockOnly, 'rejected').includes(rejectId), 'not in block rejected');
            assert.ok(!bucketIds(blockOnly, 'pending').includes(rejectId), 'still in block pending');

            for (const [tier, route, token] of [
                ['district', '/admin/district/dashboard', tokens.district],
                ['state', '/admin/state/dashboard', tokens.state]
            ]) {
                const dash = (await request('GET', route, { token })).body?.data;
                assert.ok(bucketIds(dash, 'pending').includes(rejectId),
                    `the ${tier} admin lost an applicant they have not reviewed`);
                assert.ok(!bucketIds(dash, 'rejected').includes(rejectId),
                    `the ${tier} admin was shown as having rejected something they did not`);
            }
        });

        await test("the state CAN still approve over a block's objection", async() => {
            // The objection is on the record for the State to read; it is not a
            // veto. This is what "endorsement" means and it has to be tested,
            // because a veto is the obvious thing to assume and would strand
            // every applicant a block admin had doubts about.
            const res = await request('POST', `/applications/${rejectId}/approve`, { token: tokens.state });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            assert.strictEqual(res.body?.data?.status, 'Approved');

            const doc = await db.collection('applications').findOne({ _id: rejectAppRes.insertedId });
            assert.strictEqual(doc.status, 'Approved');
            // Both answers survive: the block said no, the state said yes.
            assert.strictEqual(doc.reviews?.block?.decision, 'rejected');
            assert.strictEqual(doc.reviews?.state?.decision, 'approved');
        });

        await test("the outcome is closed to the State once the State has spoken", async() => {
            for (const [route, token] of [
                [`/applications/${rejectId}/state-review`, tokens.state],
                [`/applications/${rejectId}/approve`, tokens.state]
            ]) {
                const res = await request('POST', route, { token, body: { action: 'approve' } });
                assert.strictEqual(res.status, 400, `expected 400 from ${route}, got ${res.status}`);
            }
            // ...and the district is carried by it, so it is not asked either.
            const res = await request('POST', `/applications/${rejectId}/district-review`, {
                token: tokens.district,
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
            status: 'Pending',
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(aliasRes.insertedId);
        const aliasId = aliasRes.insertedId.toString();

        await test('POST /:id/approve signs the decision as the caller\'s own tier', async() => {
            const res = await request('POST', `/applications/${aliasId}/approve`, { token: tokens.block });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            // A block admin, so an endorsement — the alias does not promote the
            // caller into the deciding seat.
            assert.strictEqual(res.body?.data?.status, 'Pending');

            const doc = await db.collection('applications').findOne({ _id: aliasRes.insertedId });
            assert.strictEqual(doc.reviews?.block?.decision, 'approved');
            assert.strictEqual(doc.reviews?.block?.adminType, 'BlockAdmin');
        });

        await test('POST /:id/approve by the same block admin is now refused', async() => {
            const res = await request('POST', `/applications/${aliasId}/approve`, { token: tokens.block });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
        });

        // ---------------------------------------------------------------
        section('Legacy status rows remain actionable — no migration');
        // ---------------------------------------------------------------
        /*
         * `Pending-District` is the case that matters here.
         *
         * It is a row the OLD workflow left mid-relay: the block had approved
         * it and it was waiting on the district. Nothing rewrote those rows, so
         * every tier must read one as plainly pending and any tier must be able
         * to clear it — including the block admin, whose approval it has
         * already had once.
         */
        const legacyRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Legacy Applicant',
            email: `${RUN}.legacy@e2e.invalid`,
            phone: '9000000004',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'pending_district_approval', // legacy spelling found in live data
            blockApprovedAt: new Date(),
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(legacyRes.insertedId);
        const legacyId = legacyRes.insertedId.toString();

        await test('a legacy mid-relay row keeps the approval it really collected', async() => {
            /*
             * `blockApprovedAt` is on this row, and both previous workflows
             * wrote it only when the BLOCK itself acted — so the block's step
             * really happened and its queue must not ask again. The two tiers
             * the relay never reached still owe their verdicts.
             */
            const blockDash2 = (await request('GET', '/admin/block/dashboard', { token: tokens.block })).body?.data;
            assert.ok(bucketIds(blockDash2, 'approved').includes(legacyId),
                "the block's real approval was thrown away");

            for (const [tier, route, token] of [
                ['district', '/admin/district/dashboard', tokens.district],
                ['state', '/admin/state/dashboard', tokens.state]
            ]) {
                const dash = (await request('GET', route, { token })).body?.data;
                assert.ok(bucketIds(dash, 'pending').includes(legacyId),
                    `legacy row missing from ${tier} pending`);
            }
        });

        await test('a legacy row accepts an endorsement without a migration', async() => {
            /*
             * THE REGRESSION THIS GUARDS.
             *
             * `pending_district_approval` is not in the schema's enum and never
             * was. Nothing noticed while every write also set `status` to a
             * valid value in the same breath — but an endorsement deliberately
             * does not touch the status, so saving one validated the legacy
             * spelling for the first time and Mongoose refused the document:
             * a real applicant no admin could endorse.
             *
             * `pre('validate')` folds the spelling to its canonical form on the
             * way to disk, which is what every reader has always seen anyway.
             */
            // The DISTRICT, which is the tier this row was actually waiting on.
            const res = await request('POST', `/applications/${legacyId}/district-review`, {
                token: tokens.district,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));

            const doc = await db.collection('applications').findOne({ _id: legacyRes.insertedId });
            assert.strictEqual(doc.status, 'Pending',
                'the legacy spelling was not folded to the canonical one');
            assert.strictEqual(doc.reviews?.district?.decision, 'approved');
            // And the block's own step was written into its slot on the way,
            // rather than left to be re-derived or lost by the next write.
            assert.strictEqual(doc.reviews?.block?.decision, 'approved',
                "the block's legacy approval was not preserved");
        });

        await test('a legacy row is enrolled by the state, as any other', async() => {
            const res = await request('POST', `/applications/${legacyId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));
            const doc = await db.collection('applications').findOne({ _id: legacyRes.insertedId });
            assert.strictEqual(doc.status, 'Approved');
        });

        // ---------------------------------------------------------------
        section('A row a LOWER tier approved under the old build');
        // ---------------------------------------------------------------
        /*
         * The shape found in live data: `Approved`, with `approvedBy` naming a
         * District admin. The previous build let any tier write the outcome.
         * Under this one a District approval never enrols anybody, so the
         * State's seat has to still be open on it — that is the whole of what
         * the association asked for.
         */
        const oldRes = await db.collection('applications').insertOne({
            userId: applicantUserId,
            fullName: 'E2E Old-Rule Applicant',
            email: `${RUN}.oldrule@e2e.invalid`,
            phone: '9000000005',
            state: REGION.state,
            district: REGION.district,
            block: REGION.block,
            status: 'Approved',
            stateApprovedAt: new Date(),
            districtApprovedAt: new Date(),
            approvedBy: { adminType: 'DistrictAdmin', approvedAt: new Date() },
            reviewedBy: {},
            data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
            notes: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            __e2e: RUN
        });
        created.applications.push(oldRes.insertedId);
        const oldId = oldRes.insertedId.toString();

        await test("the State still owes a verdict on a District-approved row", async() => {
            const dash = (await request('GET', '/admin/state/dashboard', { token: tokens.state })).body?.data;
            assert.ok(bucketIds(dash, 'pending').includes(oldId),
                'the State was shown as having approved a row a District approved');
            assert.ok(!bucketIds(dash, 'approved').includes(oldId),
                "the State's queue claimed a decision the State never made");

            // The district, which did decide, reads its own answer back.
            const dDash = (await request('GET', '/admin/district/dashboard', { token: tokens.district })).body?.data;
            assert.ok(bucketIds(dDash, 'approved').includes(oldId), 'not in district approved');
        });

        await test('the State ratifying it does not duplicate the member profile', async() => {
            const before = await db.collection(COL.details).countDocuments({ userId: applicantUserId });

            const res = await request('POST', `/applications/${oldId}/state-review`, {
                token: tokens.state,
                body: { action: 'approve' }
            });
            assert.strictEqual(res.status, 200, JSON.stringify(res.body));

            const after = await db.collection(COL.details).countDocuments({ userId: applicantUserId });
            assert.strictEqual(after, before,
                'the State approval created a second member profile; the unique email '
                + 'index would make that permanent');

            const doc = await db.collection('applications').findOne({ _id: oldRes.insertedId });
            assert.strictEqual(doc.status, 'Approved');
            assert.strictEqual(doc.approvedBy?.adminType, 'StateAdmin', 'the ratification was not recorded');
            assert.strictEqual(doc.reviews?.state?.decision, 'approved');
        });

        await test("a later write never erases an earlier tier's attribution", async() => {
            /*
             * THE DATA LOSS THIS GUARDS, which happened to a live applicant once.
             *
             * `approvedBy` holds ONE decision. On a row a District admin had
             * approved, the State later approving overwrote it — and the only
             * record that the District had approved was gone. Nothing but
             * `reviewedBy.districtAdmin` and `districtApprovedAt` survived to
             * rebuild it from.
             *
             * `materialiseLegacyVerdicts` now pins every verdict into its own
             * slot before any new write touches `approvedBy`.
             */
            const doc = await db.collection('applications').findOne({ _id: oldRes.insertedId });
            assert.strictEqual(doc.approvedBy?.adminType, 'StateAdmin',
                'the outcome should now be signed by the State');
            assert.strictEqual(doc.reviews?.district?.decision, 'approved',
                "the District's approval was erased by the State's");
            assert.strictEqual(doc.reviews?.district?.adminType, 'DistrictAdmin');
            assert.ok(doc.reviews?.district?.decidedAt, "the District's timestamp was lost");
        });

        await test('a rejection that would orphan a member profile is refused', async() => {
            const orphanRes = await db.collection('applications').insertOne({
                userId: applicantUserId,
                fullName: 'E2E Orphan Applicant',
                email: `${RUN}.orphan@e2e.invalid`,
                phone: '9000000006',
                state: REGION.state,
                district: REGION.district,
                block: REGION.block,
                status: 'Approved',
                approvedBy: { adminType: 'BlockAdmin', approvedAt: new Date() },
                reviewedBy: {},
                data: { personalDetails: { block: REGION.block, district: REGION.district, state: REGION.state } },
                notes: [],
                createdAt: new Date(),
                updatedAt: new Date(),
                __e2e: RUN
            });
            created.applications.push(orphanRes.insertedId);

            const res = await request('POST', `/applications/${orphanRes.insertedId}/state-review`, {
                token: tokens.state,
                body: { action: 'reject', rejectionReason: 'should be refused' }
            });
            assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
            assert.ok(/already has a member profile/i.test(res.body?.message || ''),
                `expected the message to explain why, got: ${res.body?.message}`);

            const doc = await db.collection('applications').findOne({ _id: orphanRes.insertedId });
            assert.strictEqual(doc.status, 'Approved', 'a refused rejection changed the status');
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
