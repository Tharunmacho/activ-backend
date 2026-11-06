// Disposable loopback Mongo only. Exercise real identity selection and admin
// reads without modifying production data or contacting any message provider.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', PUSH_ENABLED: 'false' });
let mongo;

async function main() {
    mongo = await MongoMemoryServer.create({
        binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') },
        instance: { ip: '127.0.0.1' }
    });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Application = require('../src/modules/applications/application.model');
    const admin = require('../src/modules/admin/admin.service');
    const superAdmin = require('../src/modules/admin/superadmin.service');
    const regions = require('../src/modules/regions/region.service');
    const repository = require('../src/modules/admin/admin.repository');
    const coverage = { block: 1, district: 1, state: 1 };
    regions.coverageFor = async () => coverage;
    regions.coverageResolver = async () => () => coverage;
    repository.findAll = repository.findActive = async () => [];
    repository.sources = () => [];
    require('../src/modules/admin/adminsDb').ensureReady = async () => {};

    const id = () => new mongoose.Types.ObjectId();
    const ownerA = id(), aliasA = id(), ownerB = id(), ownerC = id();
    const email = 'same-contact@example.test';
    const region = { state: 'Tamil Nadu', district: 'Dharmapuri', block: 'Palakkodu' };
    await Member.collection.insertMany([
        { _id: ownerA, userId: aliasA, fullName: 'Approved member', email, ...region },
        { _id: ownerB, fullName: 'Different owner same contact', email, ...region },
        { _id: ownerC, fullName: 'Rejected member', email: 'rejected@example.test', state: 'Karnataka' }
    ]);
    const make = (owner, status, daysAgo, extra = {}) => ({
        _id: id(), userId: owner, fullName: 'Current member', email, phone: '9000000000', ...region,
        status, createdAt: new Date(Date.now() - daysAgo * 86400000),
        ...(status === 'Approved' ? { approvedBy: { adminType: 'SuperAdmin', approvedAt: new Date() } } : {}),
        ...(status === 'Rejected' ? { rejectedBy: { adminType: 'SuperAdmin', rejectedAt: new Date() } } : {}),
        data: { businessInfo: { doingBusiness: true } }, ...extra
    });
    const approved = make(ownerA, 'Approved', 8);
    const pending = make(ownerB, 'Pending', 3, { fullName: 'Independent pending' });
    const otherRegion = { state: 'Karnataka', district: 'Bengaluru', block: 'Bengaluru' };
    const rejected = make(ownerC, 'Rejected', 2, { ...otherRegion, fullName: 'Latest rejection' });
    const history = [make(ownerB, 'Pending', 6), make(ownerB, 'Rejected', 5),
        make(ownerC, 'Rejected', 7, otherRegion)];
    // More shadows than either UI cap: canonical selection must happen before
    // 300/500 limits, otherwise every slot can be consumed by this one owner.
    const shadows = Array.from({ length: 501 }, (_, index) => make(aliasA, 'Pending', 1, {
        fullName: `Shadow only ${index}`, state: 'Kerala', district: 'Old district', block: 'Old block'
    }));
    await Application.collection.insertMany([approved, pending, rejected, ...history, ...shadows]);
    const originalCount = await Application.countDocuments();
    const expected = [approved, pending, rejected].map(row => String(row._id)).sort();
    const scope = { role: 'super_admin' };

    const all = await superAdmin.computeApplications({ status: 'all', level: 'state', limit: 100 }, scope);
    assert.deepEqual(all.applicants.map(row => row.id).sort(), expected);
    assert.equal(all.pagination.total, 3);
    assert.equal(all.pagination.truncated, false);
    assert.equal(all.applicants.filter(row => row.email === email).length, 3,
        'matching contact text never merges different confirmed owners');
    const pages = await Promise.all([1, 2, 3].map(page =>
        superAdmin.computeApplications({ status: 'all', level: 'state', limit: 1, page }, scope)));
    assert.deepEqual(pages.flatMap(page => page.applicants.map(row => row.id)).sort(), expected);
    assert(pages.every(page => page.pagination.total === 3 && page.pagination.pages === 3));

    for (const filters of [
        { status: 'pending', q: 'Shadow only' },
        { state: 'Kerala' },
        { district: 'Old district', block: 'Old block', status: 'pending' }
    ]) {
        const result = await superAdmin.computeApplications({ level: 'state', ...filters }, scope);
        assert.equal(result.applicants.length, 0, JSON.stringify(filters));
        assert.equal(result.pagination.total, 0);
    }
    const pendingOnly = await superAdmin.computeApplications({ level: 'state', status: 'pending' }, scope);
    assert.deepEqual(pendingOnly.applicants.map(row => row.id), [String(pending._id)]);
    assert.deepEqual((await superAdmin.search('Shadow only')).applications, []);

    const totals = await admin.countApplicationBuckets({});
    assert.equal(totals.total, 3);
    assert.deepEqual(totals.outcome, { pending: 1, approved: 1, rejected: 1 });
    assert.equal((await admin.countApplicationBuckets({ state: 'Kerala' })).total, 0);
    assert.equal((await admin.getSuperDashboard()).stats.pendingApplications, 1);
    assert.equal((await admin.getDashboardStats()).pendingApplications, 1);
    const overview = await superAdmin.computeOverview();
    assert.equal(overview.stats.totalApplications, 3);
    assert.equal(overview.stats.pendingApplications, 1);

    const directory = await superAdmin.computeDirectory({ level: 'state' }, scope);
    assert(!directory.regions.some(row => row.name === 'Kerala'));
    assert.equal(directory.regions.reduce((sum, row) => sum + row.applications, 0), 3);
    const oldScope = { stateName: 'Kerala', districtName: 'Old district', blockName: 'Old block' };
    const oldDashboard = await admin.computeBlockDashboard({}, oldScope);
    assert.equal(oldDashboard.applicants.all.length, 0);
    assert.equal(oldDashboard.stats.totalApplications, 0);
    const currentDashboard = await admin.computeBlockDashboard({}, {
        stateName: region.state, districtName: region.district, blockName: region.block
    });
    assert.deepEqual(currentDashboard.applicants.all.map(row => row.id).sort(),
        [String(approved._id), String(pending._id)].sort());
    assert.equal(currentDashboard.stats.totalApplications, 2);
    const report = await admin.generateReport(scope, { dateRange: 'year' });
    assert.equal(report.totals.applicationsAllTime, originalCount, 'historical submission reports retain every attempt');
    assert.equal(report.totals.applicationsInRange, originalCount);
    assert.equal(await Application.countDocuments(), originalCount, 'all stored history remains intact');
    console.log('PASS: canonical admin queues, search, status/region filters, pagination, totals and directory; approved aliases win, same-email owners remain separate, history and historical reports unchanged.');
}

main().then(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(0); })
    .catch(async error => { console.error(error); await mongoose.disconnect(); if (mongo) await mongo.stop(); process.exit(1); });
