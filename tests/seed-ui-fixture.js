/**
 * Seeds (or tears down) an isolated fixture for driving the approval flow
 * through the app UI.
 *
 *   node tests/seed-ui-fixture.js up     # create admins + one application
 *   node tests/seed-ui-fixture.js down   # remove everything it created
 *   node tests/seed-ui-fixture.js state  # print current workflow state
 *
 * Everything is tagged `__uifix: true` and lives in a synthetic region, so it
 * cannot collide with real applications.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const TAG = { __uifix: true };
const REGION = { state: 'UI Test State', district: 'UI Test District', block: 'UI Test Block' };
const PASSWORD = 'UiTest123!';

const ADMINS = [
    { key: 'block', role: 'block_admin', ...REGION },
    { key: 'district', role: 'district_admin', state: REGION.state, district: REGION.district },
    { key: 'state', role: 'state_admin', state: REGION.state }
];

const COL = {
    details: 'web users',
    business: 'additional form for bussiness 2',
    financial: 'additional form for financial 3',
    declaration: 'additional form for declaration 4'
};

const run = async() => {
    const mode = process.argv[2] || 'up';
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;

    const purge = async() => {
        for (const c of ['applications', 'admins', 'memberauths', ...Object.values(COL)]) {
            const r = await db.collection(c).deleteMany({
                $or: [TAG, { email: /@uitest\.invalid$/ }]
            }).catch(() => ({ deletedCount: 0 }));
            if (r.deletedCount) console.log(`  removed ${r.deletedCount} from ${c}`);
        }
    };

    if (mode === 'down') {
        console.log('Tearing down UI fixture...');
        await purge();
        console.log(`applications now: ${await db.collection('applications').countDocuments()}`);
        await mongoose.disconnect();
        return;
    }

    if (mode === 'state') {
        const apps = await db.collection('applications')
            .find(TAG, { projection: { fullName: 1, status: 1, blockApprovedAt: 1, districtApprovedAt: 1, stateApprovedAt: 1, rejectedBy: 1 } })
            .toArray();
        console.log(`\nWorkflow state (${apps.length} fixture applications):`);
        apps.forEach(a => {
            const marks = [
                a.blockApprovedAt ? 'B' : '-',
                a.districtApprovedAt ? 'D' : '-',
                a.stateApprovedAt ? 'S' : '-'
            ].join('');
            console.log(`  ${(a.fullName || '').padEnd(22)} ${String(a.status).padEnd(18)} [${marks}]${a.rejectedBy?.adminType ? ' rejectedBy=' + a.rejectedBy.adminType : ''}`);
        });

        for (const [name, c] of Object.entries(COL)) {
            const n = await db.collection(c).countDocuments({ $or: [TAG, { email: /@uitest\.invalid$/ }] });
            console.log(`  member ${name.padEnd(12)}: ${n}`);
        }
        await mongoose.disconnect();
        return;
    }

    console.log('Seeding UI fixture...');
    await purge();

    const hash = await bcrypt.hash(PASSWORD, 10);

    for (const spec of ADMINS) {
        const email = `ui.${spec.key}@uitest.invalid`;
        await db.collection('admins').insertOne({
            email,
            password: hash,
            role: spec.role,
            fullName: `UI ${spec.role}`,
            state: spec.state,
            district: spec.district,
            block: spec.block,
            isActive: true,
            ...TAG
        });
        console.log(`  admin ${email}  (${spec.role})`);
    }

    const auth = await db.collection('memberauths').insertOne({
        email: 'ui.applicant@uitest.invalid', password: hash, isActive: true, ...TAG
    });

    await db.collection('applications').insertOne({
        userId: auth.insertedId,
        fullName: 'Priya Raman',
        email: 'ui.applicant@uitest.invalid',
        phone: '9876500011',
        state: REGION.state,
        district: REGION.district,
        block: REGION.block,
        status: 'Pending-Block',
        reviewedBy: {},
        data: {
            personalDetails: {
                fullName: 'Priya Raman',
                ...REGION,
                city: 'UI City',
                aadhaarNumber: '888888888888',
                education: 'Graduate',
                religion: 'NA',
                socialCategory: 'Others'
            },
            businessInfo: {
                doingBusiness: true,
                organizationName: 'Priya Agro Supplies',
                constitutionType: 'Proprietorship',
                businessTypes: ['Trader'],
                businessActivities: 'Agri inputs',
                businessCommencementYear: '2019',
                numberOfEmployees: '8'
            },
            financialInfo: {
                panNumber: 'BBBBB2222B',
                gstNumber: '33BBBBB2222B1Z5',
                itrFiled: true,
                turnoverRange: '1-5 Lakhs',
                govtSchemeBenefit: false
            },
            declaration: { sisterConcerns: 0, companyNames: [], agreeToDeclaration: true }
        },
        notes: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...TAG
    });

    console.log('  application "Priya Raman" @ Pending-Block');
    console.log(`\nLogins (password: ${PASSWORD})`);
    ADMINS.forEach(a => console.log(`  ui.${a.key}@uitest.invalid`));
    await mongoose.disconnect();
};

run().catch(async(e) => {
    console.error('FAILED:', e.message);
    try { await mongoose.disconnect(); } catch { /* noop */ }
    process.exit(1);
});
