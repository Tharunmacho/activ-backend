// Disposable loopback Mongo only. Every service worker has its own process and
// Mongoose pool; submission announcements are counted through IPC, never sent.
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const mongoose = require('mongoose');

Object.assign(process.env, {
    NODE_ENV: 'test', JWT_SECRET: 'local-concurrency-only',
    PUSH_ENABLED: 'false', REDIS_ENABLED: 'false',
});
// Do not load a developer's SMTP, WhatsApp or database credentials in a test.
require('dotenv').config = () => ({ parsed: {} });

const claimsPath = '../src/modules/applications/applicationSubmissionClaim';
const loopback = uri => assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//);
const activeWorkers = new Set();
let mongo;

function startWorker(uri, options) {
    loopback(uri);
    const child = fork(__filename, ['--worker'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, MONGODB_URI: uri },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    activeWorkers.add(child);
    const messages = [];
    const listeners = new Set();
    let output = '';
    let ended = false;
    child.stdout.on('data', data => { output = (output + data).slice(-4000); });
    child.stderr.on('data', data => { output = (output + data).slice(-4000); });
    child.on('message', message => {
        messages.push(message);
        for (const listener of listeners) listener();
    });
    child.once('error', error => {
        messages.push({ type: 'result', ok: false, message: error.message });
        for (const listener of listeners) listener();
    });
    child.once('exit', (code, signal) => {
        activeWorkers.delete(child);
        ended = true;
        output += `\nworker exit code=${code}, signal=${signal}`;
        for (const listener of listeners) listener();
    });
    const waitFor = type => new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}: ${output}`)), 45000);
        const finish = (error, value) => {
            clearTimeout(timer);
            listeners.delete(check);
            if (error) reject(error); else resolve(value);
        };
        const check = () => {
            const found = messages.find(message => message.type === type);
            if (found) return finish(null, found);
            const result = messages.find(message => message.type === 'result');
            if (result || ended) finish(new Error(`Worker did not reach ${type}: ${JSON.stringify(result)} ${output}`));
        };
        listeners.add(check);
        check();
    });
    child.send({ type: 'run', uri, ...options });
    return {
        child, messages, waitFor,
        resume: () => child.send({ type: 'resume' }),
        result: () => waitFor('result'),
        announcements: () => messages.filter(message => message.type === 'announcement'),
        kill: () => new Promise(resolve => {
            if (ended) return resolve();
            child.once('exit', resolve);
            child.kill();
        }),
    };
}

async function workerMain(options) {
    loopback(options.uri);
    process.env.MONGODB_URI = options.uri;
    await mongoose.connect(options.uri, { autoIndex: false });
    const claims = require(claimsPath);
    const ownerId = new mongoose.Types.ObjectId(options.ownerId);
    const pause = (type, id) => new Promise(resolve => {
        const listener = message => {
            if (message.type !== 'resume') return;
            process.off('message', listener);
            resolve();
        };
        process.on('message', listener);
        process.send({ type, id: String(id) });
    });
    if (options.reserveOnly) {
        const id = await claims.reserveApplicationId(ownerId);
        await pause('reserved', id);
        return { id: String(id) };
    }
    if (options.pauseAt === 'reserved') {
        const reserve = claims.reserveApplicationId;
        claims.reserveApplicationId = async (...args) => {
            const id = await reserve(...args);
            await pause('reserved', id);
            return id;
        };
    }
    if (options.pauseAt === 'insert') {
        const insert = claims.insertReservedApplication;
        claims.insertReservedApplication = async application => {
            await pause('insert', application._id);
            return insert(application);
        };
    }
    const service = require('../src/modules/applications/application.service');
    service.announceSubmission = async application => {
        process.send({ type: 'announcement', id: String(application._id) });
    };
    const application = await service.createApplication(ownerId, options.data);
    return { id: String(application._id), status: application.status, registrationType: application.registrationType };
}

const submission = kind => ({ data: {
    businessInfo: kind === 'business'
        ? { doingBusiness: true, businessCommencementYear: '2020', registrationType: 'business' }
        : { doingBusiness: false, registrationType: kind },
    declaration: { agreeToDeclaration: true, sisterConcerns: 0, companyNames: [] },
} });
const success = result => assert.equal(result.ok, true, JSON.stringify(result));

async function run() {
    const { MongoMemoryServer } = require('mongodb-memory-server-core');
    mongo = await MongoMemoryServer.create({
        binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') },
        instance: { ip: '127.0.0.1' },
    });
    const uri = mongo.getUri();
    loopback(uri);
    process.env.MONGODB_URI = uri;
    await mongoose.connect(uri, { autoIndex: false });
    const Member = require('../src/modules/members/memberdetails.model');
    const Application = require('../src/modules/applications/application.model');
    const { Claim } = require(claimsPath);
    const { normalizeStatus } = require('../src/modules/common/applicationStatus');
    let fixtureNumber = 0;
    const fixture = () => Member.create({
        fullName: 'Concurrent Applicant', email: `concurrent-${++fixtureNumber}@example.test`,
        phoneNumber: '+447911123456', isInternational: true, country: 'United Kingdom',
        place: 'London', city: 'London', religion: 'Hindu', socialCategory: 'SC', gender: 'Female',
        role: 'member', isActive: true,
    });
    const worker = (member, options = {}) => startWorker(uri, {
        ownerId: String(member._id), data: submission('student'), ...options,
    });
    const ownerRows = member => Application.find({ userId: member._id }).lean();
    const assertOneAnnouncement = workers => {
        const notices = workers.flatMap(item => item.announcements());
        assert.equal(notices.length, 1, `Expected one announcement: ${JSON.stringify(notices)}`);
    };

    // A process-local mutex cannot pass: both independent workers must have
    // reserved the same ID before either is allowed to insert an application.
    for (const kinds of [['student', 'student'], ['student', 'business']]) {
        const member = await fixture();
        const workers = kinds.map(kind => worker(member, { data: submission(kind), pauseAt: 'reserved' }));
        const reservations = await Promise.all(workers.map(item => item.waitFor('reserved')));
        assert.equal(reservations[0].id, reservations[1].id, 'application type is not part of the owner claim');
        assert.equal(await Application.countDocuments({ userId: member._id }), 0);
        workers.forEach(item => item.resume());
        const results = await Promise.all(workers.map(item => item.result()));
        results.forEach(success);
        assert.equal(results[0].id, results[1].id);
        const rows = await ownerRows(member);
        assert.equal(rows.length, 1, `Concurrent ${kinds.join('/')} submissions created siblings`);
        assert.equal(rows[0].status, 'Pending');
        assert(kinds.includes(rows[0].registrationType));
        assert.equal(await Claim.countDocuments({ _id: String(member._id) }), 1);
        assertOneAnnouncement(workers);
        console.log(`PASS independent concurrent ${kinds.join('/')} submissions share one application and announcement`);
    }

    // Kill a real worker after the durable claim but before any insertion.
    // A later process must recover that exact ID instead of minting a new one.
    {
        const member = await fixture();
        const crashed = worker(member, { reserveOnly: true });
        const reservation = await crashed.waitFor('reserved');
        assert.equal(await Application.countDocuments({ userId: member._id }), 0);
        await crashed.kill();
        const retry = worker(member);
        const result = await retry.result();
        success(result);
        assert.equal(result.id, reservation.id, 'retry resumes the durable pre-insert reservation');
        assert.equal(await Application.countDocuments({ userId: member._id }), 1);
        assertOneAnnouncement([crashed, retry]);
        console.log('PASS worker crash after reservation retries the same application ID');
    }

    // A slow first worker retains the original ID while another worker inserts
    // it, it is rejected, and two new workers race to reapply. The delayed write
    // must leave the rejected history untouched and cannot recreate Pending.
    {
        const member = await fixture();
        const delayed = worker(member, { pauseAt: 'insert' });
        const beforeInsert = await delayed.waitFor('insert');
        const winner = worker(member);
        const original = await winner.result();
        success(original);
        assert.equal(original.id, beforeInsert.id);
        await Application.collection.updateOne({ _id: new mongoose.Types.ObjectId(original.id) }, { $set: { status: 'Rejected', rejectionReason: 'Local test review' } });
        const rejectedBefore = await Application.collection.findOne({ _id: new mongoose.Types.ObjectId(original.id) });
        const reapplications = ['student', 'business'].map(kind => worker(member, { data: submission(kind), pauseAt: 'reserved' }));
        const reserved = await Promise.all(reapplications.map(item => item.waitFor('reserved')));
        assert.equal(reserved[0].id, reserved[1].id, 'reapplication rotation must compare and swap once');
        assert.notEqual(reserved[0].id, original.id);
        reapplications.forEach(item => item.resume());
        const renewed = await Promise.all(reapplications.map(item => item.result()));
        renewed.forEach(success);
        assert.equal(renewed[0].id, renewed[1].id);
        delayed.resume();
        const stale = await delayed.result();
        assert.equal(stale.ok, false, 'a delayed original insert must not acknowledge a rejected application');
        assert.equal(stale.statusCode, 409, JSON.stringify(stale));
        assert.deepEqual(await Application.collection.findOne({ _id: new mongoose.Types.ObjectId(original.id) }), rejectedBefore);
        const rows = await ownerRows(member);
        assert.equal(rows.length, 2, 'retain one rejected history row and one new application');
        assert.equal(rows.filter(row => normalizeStatus(row.status) === 'Pending').length, 1);
        assert.equal(String((await Claim.findById(String(member._id)).lean()).applicationId), renewed[0].id);
        assertOneAnnouncement([winner, delayed]);
        assertOneAnnouncement(reapplications);
        console.log('PASS rejected application rotates once; delayed old worker cannot recreate Pending or announce');
    }

    // Historical duplicate Pending rows must never bypass an approved sibling,
    // including an older lowercase status not admitted by today's schema enum.
    for (const approvedStatus of ['Approved', 'approved']) {
        const member = await fixture();
        const initial = worker(member);
        const created = await initial.result();
        success(created);
        const approvedId = new mongoose.Types.ObjectId(created.id);
        await Application.collection.updateOne({ _id: approvedId }, { $set: { status: approvedStatus } });
        const approved = await Application.collection.findOne({ _id: approvedId });
        const pendingId = new mongoose.Types.ObjectId();
        await Application.collection.insertOne({ ...approved, _id: pendingId, status: 'Pending', createdAt: new Date(Date.now() + 1000) });
        const pendingBefore = await Application.collection.findOne({ _id: pendingId });
        const claimBefore = await Claim.findById(String(member._id)).lean();
        const retry = worker(member, { data: submission('business') });
        const result = await retry.result();
        assert.equal(result.ok, false, `${approvedStatus} plus Pending must block resubmission`);
        assert.equal(result.statusCode, 409, JSON.stringify(result));
        assert.deepEqual(await Application.collection.findOne({ _id: approvedId }), approved);
        assert.deepEqual(await Application.collection.findOne({ _id: pendingId }), pendingBefore);
        assert.deepEqual(await Claim.findById(String(member._id)).lean(), claimBefore);
        assert.equal(await Application.countDocuments({ userId: member._id }), 2);
        assert.equal(retry.announcements().length, 0);
        console.log(`PASS ${approvedStatus} sibling blocks Pending resubmission without mutation or announcement`);
    }

    // A confirmed legacy login ID may own saved forms. Canonicalizing the
    // application owner must not discard those previously accepted sections.
    {
        const member = await fixture();
        const alias = member.userId;
        assert.notEqual(String(alias), String(member._id));
        const Personal = require('../src/modules/members/personalinfo1.model');
        const Business = require('../src/modules/members/businessinfo.model');
        const Declaration = require('../src/modules/members/memberdeclaration.model');
        await Personal.create({
            userId: alias, name: 'Saved Legacy Applicant', phoneNumber: member.phoneNumber,
            isInternational: true, place: 'London', city: 'London',
            religion: 'Hindu', socialCategory: 'SC', gender: 'Female',
        });
        await Business.create({ userId: alias, ...submission('student').data.businessInfo });
        await Declaration.create({ userId: alias, memberId: alias, ...submission('student').data.declaration });
        const legacy = worker(member, { ownerId: String(alias), data: {} });
        const result = await legacy.result();
        success(result);
        const row = await Application.findById(result.id).lean();
        assert.equal(String(row.userId), String(member._id));
        assert.equal(row.fullName, 'Saved Legacy Applicant');
        assert.equal(row.registrationType, 'student');
        assert.equal(row.data.declaration.agreeToDeclaration, true);
        assert.equal(await Claim.countDocuments({ _id: String(alias) }), 0);
        assert.equal(await Claim.countDocuments({ _id: String(member._id) }), 1);
        assertOneAnnouncement([legacy]);
        console.log('PASS legacy alias saved forms submit under one canonical owner');
    }

    // Active members must not create an application even if their old approval
    // row is absent. "completed" is a legacy profile status outside the enum.
    for (const membershipStatus of ['active', 'completed']) {
        const member = await fixture();
        await Member.collection.updateOne({ _id: member._id }, { $set: { membershipStatus } });
        const before = await Member.collection.findOne({ _id: member._id });
        const retry = worker(member);
        const result = await retry.result();
        assert.equal(result.ok, false, `${membershipStatus} member cannot start another application`);
        assert.equal(result.statusCode, 409, JSON.stringify(result));
        assert.equal(await Application.countDocuments({ userId: member._id }), 0);
        assert.equal(await Claim.countDocuments({ _id: String(member._id) }), 0);
        assert.deepEqual(await Member.collection.findOne({ _id: member._id }), before);
        assert.equal(retry.announcements().length, 0);
        console.log(`PASS ${membershipStatus} membership blocks a new application without a historical approval row`);
    }
    console.log('PASS application submission concurrency: independent workers, durable recovery, terminal history and single announcements');
}

if (process.argv.includes('--worker')) {
    process.once('message', async options => {
        let result;
        try { result = { type: 'result', ok: true, ...await workerMain(options) }; }
        catch (error) { result = { type: 'result', ok: false, message: error.message, statusCode: error.statusCode, stack: error.stack }; }
        await mongoose.disconnect();
        process.send(result, () => process.exit(0));
    });
} else {
    run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
        await Promise.all([...activeWorkers].map(child => new Promise(resolve => {
            child.once('exit', resolve);
            child.kill();
        })));
        await mongoose.disconnect();
        if (mongo) await mongo.stop();
        process.exit(process.exitCode || 0);
    });
}
