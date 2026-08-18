/**
 * Verifies the geofenced 3-tier approval workflow's bucket rules.
 *
 * These are pure functions over an application document, so the suite runs
 * without a database. Run with:  node tests/approval-workflow.test.js
 */
const assert = require('assert');
const { classifyForLevel, buildGeoFilter, LEVELS } = require('../src/modules/admin/admin.service');
const { normalizeStatus, STATUS } = require('../src/modules/common/applicationStatus');

let passed = 0;
let failed = 0;

const test = (name, fn) => {
    try {
        fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${error.message}`);
    }
};

// Application fixtures at each point in the lifecycle.
const submitted = { status: 'Pending-Block' };
const legacySubmitted = { status: 'PENDING' };
const blockApproved = { status: 'Pending-District', blockApprovedAt: new Date() };
const districtApproved = {
    status: 'Pending-State',
    blockApprovedAt: new Date(),
    districtApprovedAt: new Date()
};
const finalApproved = {
    status: 'Approved',
    blockApprovedAt: new Date(),
    districtApprovedAt: new Date(),
    stateApprovedAt: new Date()
};
const blockRejected = { status: 'Rejected', rejectedBy: { adminType: 'BlockAdmin' } };
const districtRejected = {
    status: 'Rejected',
    blockApprovedAt: new Date(),
    rejectedBy: { adminType: 'DistrictAdmin' }
};
const stateRejected = {
    status: 'Rejected',
    blockApprovedAt: new Date(),
    districtApprovedAt: new Date(),
    rejectedBy: { adminType: 'StateAdmin' }
};

console.log('\nStage 1 - Block Admin queue');

test('new submission is pending for the block', () => {
    assert.strictEqual(classifyForLevel(submitted, LEVELS.BLOCK), 'pending');
});

test("legacy 'PENDING' status is pending for the block", () => {
    assert.strictEqual(classifyForLevel(legacySubmitted, LEVELS.BLOCK), 'pending');
});

test('block-approved file leaves the block pending queue', () => {
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.BLOCK), 'approved');
});

test('district- and state-stage files are approved (not pending) for the block', () => {
    // Regression guard: substring matching on "pending" used to put
    // 'Pending-District' back into the block's pending queue.
    assert.strictEqual(classifyForLevel(districtApproved, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(finalApproved, LEVELS.BLOCK), 'approved');
});

test('rejections show in the block rejected bucket', () => {
    assert.strictEqual(classifyForLevel(blockRejected, LEVELS.BLOCK), 'rejected');
});

console.log('\nStage 2 - District Admin queue');

test('district pending queue is EMPTY until the block approves', () => {
    assert.notStrictEqual(classifyForLevel(submitted, LEVELS.DISTRICT), 'pending');
    assert.notStrictEqual(classifyForLevel(legacySubmitted, LEVELS.DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(submitted, LEVELS.DISTRICT), 'upstream');
});

test('block-approved file enters the district pending queue', () => {
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.DISTRICT), 'pending');
});

test('district-approved file leaves the district pending queue', () => {
    assert.strictEqual(classifyForLevel(districtApproved, LEVELS.DISTRICT), 'approved');
    assert.strictEqual(classifyForLevel(finalApproved, LEVELS.DISTRICT), 'approved');
});

test('a file cannot be both pending and approved for the district', () => {
    // Regression guard: the old `|| a.blockApprovedAt` clause double-counted
    // every 'Pending-District' file into the approved bucket as well.
    const stage = classifyForLevel(blockApproved, LEVELS.DISTRICT);
    assert.strictEqual(stage, 'pending');
    assert.notStrictEqual(stage, 'approved');
});

test('only district-authored rejections land in the district rejected bucket', () => {
    assert.strictEqual(classifyForLevel(districtRejected, LEVELS.DISTRICT), 'rejected');
    assert.strictEqual(classifyForLevel(blockRejected, LEVELS.DISTRICT), 'closed');
    assert.strictEqual(classifyForLevel(stateRejected, LEVELS.DISTRICT), 'closed');
});

console.log('\nStage 3 - State Admin queue');

test('state pending queue is EMPTY until the district approves', () => {
    assert.notStrictEqual(classifyForLevel(submitted, LEVELS.STATE), 'pending');
    assert.notStrictEqual(classifyForLevel(blockApproved, LEVELS.STATE), 'pending');
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.STATE), 'upstream');
});

test('district-approved file enters the state pending queue', () => {
    assert.strictEqual(classifyForLevel(districtApproved, LEVELS.STATE), 'pending');
});

test('final approval moves the file to the state approved bucket', () => {
    assert.strictEqual(classifyForLevel(finalApproved, LEVELS.STATE), 'approved');
});

test('only state-authored rejections land in the state rejected bucket', () => {
    assert.strictEqual(classifyForLevel(stateRejected, LEVELS.STATE), 'rejected');
    assert.strictEqual(classifyForLevel(blockRejected, LEVELS.STATE), 'closed');
    assert.strictEqual(classifyForLevel(districtRejected, LEVELS.STATE), 'closed');
});

console.log('\nRejections halt progression');

test('a rejected file never appears pending at any tier', () => {
    [blockRejected, districtRejected, stateRejected].forEach(app => {
        [LEVELS.BLOCK, LEVELS.DISTRICT, LEVELS.STATE].forEach(level => {
            assert.notStrictEqual(
                classifyForLevel(app, level),
                'pending',
                `${app.rejectedBy.adminType} rejection appeared pending at ${level}`
            );
        });
    });
});

console.log('\nLegacy status values present in the live database');

test('legacy spellings fold to the canonical enum', () => {
    assert.strictEqual(normalizeStatus('pending_block_approval'), STATUS.PENDING_BLOCK);
    assert.strictEqual(normalizeStatus('pending_district_approval'), STATUS.PENDING_DISTRICT);
    assert.strictEqual(normalizeStatus('pending_state_approval'), STATUS.PENDING_STATE);
    assert.strictEqual(normalizeStatus('approved'), STATUS.APPROVED);
    assert.strictEqual(normalizeStatus('rejected'), STATUS.REJECTED);
    assert.strictEqual(normalizeStatus('PENDING'), STATUS.PENDING_BLOCK);
    assert.strictEqual(normalizeStatus('pending_block'), STATUS.PENDING_BLOCK);
    assert.strictEqual(normalizeStatus('pending_district'), STATUS.PENDING_DISTRICT);
});

test('unknown or empty status falls back to the first review stage', () => {
    assert.strictEqual(normalizeStatus(''), STATUS.PENDING_BLOCK);
    assert.strictEqual(normalizeStatus(null), STATUS.PENDING_BLOCK);
    assert.strictEqual(normalizeStatus('something-unexpected'), STATUS.PENDING_BLOCK);
});

test("legacy lowercase 'approved' is NOT shown as pending to the block admin", () => {
    // 9 live rows carry this spelling; strict matching alone would have put
    // every one of them back into the block's pending queue.
    assert.strictEqual(classifyForLevel({ status: 'approved' }, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel({ status: 'approved' }, LEVELS.STATE), 'approved');
});

test("legacy lowercase 'rejected' is NOT shown as pending to any tier", () => {
    [LEVELS.BLOCK, LEVELS.DISTRICT, LEVELS.STATE].forEach(level => {
        assert.notStrictEqual(classifyForLevel({ status: 'rejected' }, level), 'pending');
    });
    assert.strictEqual(classifyForLevel({ status: 'rejected' }, LEVELS.BLOCK), 'rejected');
});

test("legacy 'pending_district_approval' reaches the district queue", () => {
    const legacy = { status: 'pending_district_approval' };
    assert.strictEqual(classifyForLevel(legacy, LEVELS.DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(legacy, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(legacy, LEVELS.STATE), 'upstream');
});

test("legacy 'pending_block_approval' stays in the block queue only", () => {
    const legacy = { status: 'pending_block_approval' };
    assert.strictEqual(classifyForLevel(legacy, LEVELS.BLOCK), 'pending');
    assert.strictEqual(classifyForLevel(legacy, LEVELS.DISTRICT), 'upstream');
    assert.strictEqual(classifyForLevel(legacy, LEVELS.STATE), 'upstream');
});

console.log('\nGeofence filters');

test('geo filter matches the three places a location can live', () => {
    const filter = buildGeoFilter('block', 'Ariyalur');
    const keys = filter.$or.map(clause => Object.keys(clause)[0]);
    assert.deepStrictEqual(keys, ['block', 'data.personalDetails.block', 'data.personal.block']);
});

test('geo filter is case-insensitive but anchored (no partial matches)', () => {
    const regex = buildGeoFilter('district', 'Ariyalur').$or[0].district;
    assert.ok(regex.test('ariyalur'), 'should match case-insensitively');
    assert.ok(!regex.test('Ariyalur North'), 'must not match a different district by prefix');
    assert.ok(!regex.test('South Ariyalur'), 'must not match a different district by suffix');
});

test('geo filter escapes regex metacharacters in location names', () => {
    const regex = buildGeoFilter('block', 'N.A. Block').$or[0].block;
    assert.ok(regex.test('N.A. Block'));
    assert.ok(!regex.test('NXAX Block'), 'unescaped dots would match any character');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
