/**
 * Verifies the geofenced PARALLEL approval workflow.
 *
 * The workflow this suite used to cover was a relay: Block approves, then
 * District, then State, and each tier saw a different stage of the same file.
 * It is not a relay any more. An application is submitted to the Block,
 * District and State admin of the applicant's own region at the same time, and
 * whichever of them acts first decides it for all three.
 *
 * So what is worth asserting has changed shape completely:
 *
 *   - the three tiers agree about every application (they used to disagree by
 *     design, and the disagreement was the thing under test);
 *   - every legacy spelling — including the two mid-relay statuses that exist
 *     in live data — is pending and actionable, because there is no migration;
 *   - the geofence is untouched, and is now the ONLY thing deciding who sees an
 *     application. That makes its tests the most important ones here.
 *
 * These are pure functions over an application document, so the suite runs
 * without a database. Run with:  node tests/approval-workflow.test.js
 */
const assert = require('assert');
const { classifyForLevel, reachedThisTier, buildGeoFilter, LEVELS } = require('../src/modules/admin/admin.service');
const { normalizeStatus, isPending, isTerminal, STATUS, PENDING_STORED_STATUSES } = require('../src/modules/common/applicationStatus');
const tierRouting = require('../src/modules/common/tierRouting');
const tierReviews = require('../src/modules/common/tierReviews');

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

const ALL_LEVELS = [LEVELS.BLOCK, LEVELS.DISTRICT, LEVELS.STATE];

// Application fixtures. The three mid-relay ones are not obsolete — they are
// exactly what is sitting in the collection from before the change.
const submitted = { status: 'Pending' };
const legacySubmitted = { status: 'PENDING' };
const legacyBlockStage = { status: 'Pending-Block' };
const legacyDistrictStage = { status: 'Pending-District', blockApprovedAt: new Date() };
const legacyStateStage = {
    status: 'Pending-State',
    blockApprovedAt: new Date(),
    districtApprovedAt: new Date()
};
const approvedByBlock = {
    status: 'Approved',
    blockApprovedAt: new Date(),
    stateApprovedAt: new Date(),
    approvedBy: { adminType: 'BlockAdmin', approvedAt: new Date() }
};
const approvedByState = {
    status: 'Approved',
    stateApprovedAt: new Date(),
    approvedBy: { adminType: 'StateAdmin', approvedAt: new Date() }
};
/**
 * The new shapes: a verdict recorded against ONE tier's slot.
 *
 * `status` stays 'Pending' on the two endorsement fixtures because a block or
 * district verdict is not the application's outcome — which is the single most
 * important thing about this model and the easiest to write a test that does
 * not notice.
 */
const blockEndorsed = {
    status: 'Pending',
    reviews: { block: { decision: 'approved', adminType: 'BlockAdmin', decidedAt: new Date() } }
};
const districtObjected = {
    status: 'Pending',
    reviews: { district: { decision: 'rejected', adminType: 'DistrictAdmin', decidedAt: new Date(), reason: 'Not trading' } }
};
/** The reported bug: the State approves, and the District's Hub reads Approved. */
const stateApprovedOnly = {
    status: 'Approved',
    stateApprovedAt: new Date(),
    approvedBy: { adminType: 'StateAdmin', approvedAt: new Date() },
    reviews: { state: { decision: 'approved', adminType: 'StateAdmin', decidedAt: new Date() } }
};

const blockRejected = { status: 'Rejected', rejectedBy: { adminType: 'BlockAdmin' } };
const districtRejected = { status: 'Rejected', rejectedBy: { adminType: 'DistrictAdmin' } };
const stateRejected = { status: 'Rejected', rejectedBy: { adminType: 'StateAdmin' } };

console.log('\nOne submission, three queues');

test('a new submission is pending for the block, the district AND the state', () => {
    ALL_LEVELS.forEach((level) => {
        assert.strictEqual(
            classifyForLevel(submitted, level), 'pending',
            `expected pending at the ${level} level`
        );
    });
});

test('an undecided file is pending for all three, and they agree on that', () => {
    [submitted, legacySubmitted].forEach((app) => {
        const answers = ALL_LEVELS.map(level => classifyForLevel(app, level));
        assert.strictEqual(
            new Set(answers).size, 1,
            `tiers disagreed about an undecided ${app.status}: ${answers.join(', ')}`
        );
        assert.strictEqual(answers[0], 'pending');
    });
});

test('A HIGHER TIER CARRIES THE ONES BELOW IT', () => {
    /*
     * The association's rule: the tiers are an authority hierarchy, not three
     * independent opinions. The State approving settles the District's step and
     * the Block's, so neither is left holding a decision that can no longer
     * change anything.
     */
    assert.strictEqual(classifyForLevel(stateApprovedOnly, LEVELS.STATE), 'approved');
    assert.strictEqual(classifyForLevel(stateApprovedOnly, LEVELS.DISTRICT), 'approved');
    assert.strictEqual(classifyForLevel(stateApprovedOnly, LEVELS.BLOCK), 'approved');
});

test('AND THE CARD STILL NAMES WHO ACTUALLY APPROVED IT', () => {
    /*
     * This is what the original complaint was really about. A District admin
     * saw "Approved" on a row they had never opened, with nothing saying the
     * State had done it — so the screen read as the District having approved.
     *
     * Carrying the tier is right; carrying it ANONYMOUSLY is not. The verdict
     * on a carried tier names the admin who really signed, and `auto` says the
     * tier did not act itself.
     */
    const carried = tierReviews.tierVerdict(stateApprovedOnly, 'district');
    assert.strictEqual(carried.decision, 'approved');
    assert.strictEqual(carried.adminType, 'StateAdmin');
    assert.strictEqual(carried.auto, true);

    const own = tierReviews.tierVerdict(stateApprovedOnly, 'state');
    assert.strictEqual(own.adminType, 'StateAdmin');
    assert.notStrictEqual(own.auto, true);
});

test('nothing is carried UPWARDS', () => {
    // A Block approval says nothing about the District or the State.
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.STATE), 'pending');
});

test("a block's endorsement is the block's alone", () => {
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.STATE), 'pending');
});

test("a district's objection does not reject it for anybody else", () => {
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.DISTRICT), 'rejected');
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.BLOCK), 'pending');
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.STATE), 'pending');
    // And the applicant is not rejected: only the State's verdict ends it.
    assert.strictEqual(normalizeStatus(districtObjected.status), 'Pending');
});

test('no application is ever withheld from a tier that owns its region', () => {
    // `upstream` and `closed` were the two stages that hid a file from a tier.
    // Neither can be produced any more.
    const everything = [
        submitted, legacySubmitted, legacyBlockStage, legacyDistrictStage,
        legacyStateStage, approvedByBlock, blockRejected, districtRejected, stateRejected
    ];
    everything.forEach((app) => {
        ALL_LEVELS.forEach((level) => {
            const stage = classifyForLevel(app, level);
            assert.ok(
                ['pending', 'approved', 'rejected'].includes(stage),
                `${app.status} produced the stage ${stage} at the ${level} level`
            );
        });
    });
});

console.log('\nOne decision ends it');

test('a tier that decided reads its own verdict back', () => {
    assert.strictEqual(classifyForLevel(blockEndorsed, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.DISTRICT), 'rejected');
    assert.strictEqual(classifyForLevel(stateApprovedOnly, LEVELS.STATE), 'approved');
});

test('a tier below an undecided one still reads pending', () => {
    // The Block endorsed; nothing above it has spoken, so nothing above it moves.
    assert.deepStrictEqual(
        ALL_LEVELS.filter(level => classifyForLevel(blockEndorsed, level) === 'pending'),
        [LEVELS.DISTRICT, LEVELS.STATE],
    );
});

test('a REJECTION is never carried in either direction', () => {
    /*
     * A District rejection is that District's objection and nobody else's. It
     * does not stamp "rejected" into the Block's slot — a tier that never
     * opened the file must not appear to have refused it — and it does not
     * reach the State, whose verdict is the outcome.
     */
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.DISTRICT), 'rejected');
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.BLOCK), 'pending');
    assert.strictEqual(classifyForLevel(districtObjected, LEVELS.STATE), 'pending');
});

test("THE DECIDING SEAT: a lower tier's legacy decision leaves the State's seat OPEN", () => {
    /*
     * Rows approved under the previous build were approved by whichever tier
     * got there first. The State never decided those, and only the State's
     * approval makes anybody a member — so the State still owes a verdict and
     * must still be offered the buttons.
     *
     * The member documents such a row already carries are protected on the
     * WRITE path, not by pretending the State has spoken: an approval upserts
     * the profile rather than duplicating it, and a rejection that would orphan
     * one is refused.
     */
    assert.strictEqual(classifyForLevel(approvedByBlock, LEVELS.STATE), 'pending');
    assert.strictEqual(classifyForLevel(blockRejected, LEVELS.STATE), 'pending');
    assert.strictEqual(classifyForLevel(districtRejected, LEVELS.STATE), 'pending');

    // The State's OWN legacy decision does close it.
    assert.strictEqual(classifyForLevel(approvedByState, LEVELS.STATE), 'approved');
    assert.strictEqual(classifyForLevel(stateRejected, LEVELS.STATE), 'rejected');
});

test('a legacy decision is attributed to the tier that actually made it', () => {
    // ...and NOT to the other two, who never decided anything.
    assert.strictEqual(classifyForLevel(approvedByBlock, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(approvedByBlock, LEVELS.DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(blockRejected, LEVELS.BLOCK), 'rejected');
    assert.strictEqual(classifyForLevel(blockRejected, LEVELS.DISTRICT), 'pending');
});

test('staffing does not change the answer', () => {
    // Coverage is still accepted by the signature and deliberately ignored.
    // Under the relay, an unstaffed tier below promoted a file into this one's
    // pending bucket; every tier already has it now.
    const staffed = { block: 2, district: 1, state: 1 };
    const nobody = { block: 0, district: 0, state: 0 };
    ALL_LEVELS.forEach((level) => {
        assert.strictEqual(classifyForLevel(submitted, level, staffed), 'pending');
        assert.strictEqual(classifyForLevel(submitted, level, nobody), 'pending');
        assert.strictEqual(classifyForLevel(submitted, level, null), 'pending');
    });
});

console.log('\nLegacy rows need no migration');

test('every spelling that meant "undecided" folds to one Pending', () => {
    ['PENDING', 'Pending-Block', 'Pending-District', 'Pending-State',
        'pending_block_approval', 'pending_district_approval', 'pending_state_approval',
        'pending_block', 'pending_district', 'pending_state',
        'submitted', 'blockApproved', 'districtApproved'].forEach((spelling) => {
        assert.strictEqual(normalizeStatus(spelling), STATUS.PENDING, `failed on ${spelling}`);
    });
});

test('terminal spellings still fold to their own value', () => {
    assert.strictEqual(normalizeStatus('approved'), STATUS.APPROVED);
    assert.strictEqual(normalizeStatus('state_approved'), STATUS.APPROVED);
    assert.strictEqual(normalizeStatus('rejected'), STATUS.REJECTED);
    assert.strictEqual(normalizeStatus('declined'), STATUS.REJECTED);
});

test('unknown or empty status falls back to pending, never to approved', () => {
    assert.strictEqual(normalizeStatus(''), STATUS.PENDING);
    assert.strictEqual(normalizeStatus(null), STATUS.PENDING);
    assert.strictEqual(normalizeStatus('something-unexpected'), STATUS.PENDING);
});

test('a file left mid-relay keeps the approvals it really collected', () => {
    /*
     * The case that would otherwise need a data migration: a row written at
     * `Pending-District` last month, whose block HAS already signed it.
     *
     * `blockApprovedAt` and `districtApprovedAt` are trustworthy — both
     * previous workflows wrote them only when that tier itself acted — so the
     * relay's completed steps become that tier's verdict, and the steps it
     * never reached are still owed. Reading them as "pending everywhere" threw
     * away real approvals; reading `stateApprovedAt` the same way would credit
     * the State with every one of them, which is why it is excluded.
     */
    assert.strictEqual(classifyForLevel(legacyDistrictStage, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(legacyDistrictStage, LEVELS.DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(legacyDistrictStage, LEVELS.STATE), 'pending');

    assert.strictEqual(classifyForLevel(legacyStateStage, LEVELS.BLOCK), 'approved');
    assert.strictEqual(classifyForLevel(legacyStateStage, LEVELS.DISTRICT), 'approved');
    // The step the relay never reached, and the only one that grants anything.
    assert.strictEqual(classifyForLevel(legacyStateStage, LEVELS.STATE), 'pending');
});

test('a mid-relay row is still ENROLLED by nobody but the State', () => {
    // However far up the old relay it got, the applicant is not a member until
    // the State signs — which is the whole of what the association asked for.
    assert.strictEqual(normalizeStatus(legacyStateStage.status), 'Pending');
    assert.strictEqual(tierRouting.canTierAct(legacyStateStage, 'state'), true);
    assert.strictEqual(tierRouting.canTierAct(legacyStateStage, 'super'), true);
});

test('the stored-status list covers every spelling a pending row can hold', () => {
    // This list is what Mongo queries match on — `normalizeStatus` fixes reads,
    // not the database — so a spelling missing here is a legacy applicant that
    // no dashboard query selects.
    ['Pending', 'PENDING', 'Pending-Block', 'Pending-District', 'Pending-State']
        .forEach(stored => assert.ok(
            PENDING_STORED_STATUSES.includes(stored),
            `${stored} is not in PENDING_STORED_STATUSES`
        ));
    PENDING_STORED_STATUSES.forEach(stored => assert.ok(
        isPending(stored), `${stored} is listed as pending but does not normalize to Pending`
    ));
});

test('isPending and isTerminal are exact opposites', () => {
    ['Pending', 'PENDING', 'Pending-State', 'Approved', 'Rejected', '', 'nonsense']
        .forEach(status => assert.strictEqual(isPending(status), !isTerminal(status), status));
});

console.log('\nWho may decide');

test('all three tiers hold a freshly submitted application', () => {
    assert.deepStrictEqual(tierRouting.reviewingTiers(submitted), ['block', 'district', 'state']);
    assert.deepStrictEqual(tierRouting.reviewingTiers(legacySubmitted), ['block', 'district', 'state']);
    // A row the old relay had carried to the state's step owes only the state's
    // verdict — the two beneath it really did sign.
    assert.deepStrictEqual(tierRouting.reviewingTiers(legacyStateStage), ['state']);
});

test('a tier that has signed stops holding it, and so does everything below it', () => {
    // The State approved: nobody is left owing a verdict.
    assert.deepStrictEqual(tierRouting.reviewingTiers(stateApprovedOnly), []);
    // The Block endorsed. Everything ABOVE it still owes one.
    assert.deepStrictEqual(tierRouting.reviewingTiers(blockEndorsed), ['district', 'state']);
    // A legacy row the BLOCK approved: the State has still to speak, and the
    // District with it — a block approval carries nothing.
    assert.deepStrictEqual(tierRouting.reviewingTiers(approvedByBlock), ['district', 'state']);
});

test('any tier may act on a fresh file', () => {
    ['block', 'district', 'state', 'super'].forEach((tier) => {
        assert.strictEqual(tierRouting.canTierAct(submitted, tier), true, tier);
    });
});

test('the carried tiers are no longer offered a decision', () => {
    /*
     * The screen this came from: a Block Admin looking at a live Approve /
     * Reject pair on an applicant the District had already approved — a
     * decision that could no longer change anything.
     */
    assert.strictEqual(tierRouting.canTierAct(stateApprovedOnly, 'district'), false);
    assert.strictEqual(tierRouting.canTierAct(stateApprovedOnly, 'block'), false);
    assert.strictEqual(tierRouting.canTierAct(stateApprovedOnly, 'state'), false);
    assert.strictEqual(tierRouting.canTierAct(stateApprovedOnly, 'super'), false);

    // A block approval carries nothing, so the two above it keep their buttons.
    assert.strictEqual(tierRouting.canTierAct(blockEndorsed, 'district'), true);
    assert.strictEqual(tierRouting.canTierAct(blockEndorsed, 'state'), true);
});

test('no tier can record two verdicts', () => {
    assert.strictEqual(tierRouting.canTierAct(blockEndorsed, 'block'), false);
    assert.strictEqual(tierRouting.canTierAct(districtObjected, 'district'), false);
});

test('ONLY the State can close the State seat', () => {
    /*
     * The rule the association asked for in one assertion: an application is
     * not finally decided until the State (or a Super Admin in that seat) says
     * so, whatever a Block or District admin did to it first.
     */
    ['state', 'super'].forEach((tier) => {
        assert.strictEqual(tierRouting.canTierAct(approvedByBlock, tier), true, tier);
        assert.strictEqual(tierRouting.canTierAct(blockRejected, tier), true, tier);
        assert.strictEqual(tierRouting.canTierAct(blockEndorsed, tier), true, tier);
    });

    // And once they have, they cannot sign twice.
    ['state', 'super'].forEach((tier) => {
        assert.strictEqual(tierRouting.canTierAct(stateApprovedOnly, tier), false, tier);
        assert.strictEqual(tierRouting.canTierAct(approvedByState, tier), false, tier);
        assert.strictEqual(tierRouting.canTierAct(stateRejected, tier), false, tier);
    });
});

test('an unknown role is not a tier', () => {
    assert.strictEqual(tierRouting.canTierAct(submitted, ''), false);
    assert.strictEqual(tierRouting.canTierAct(submitted, 'member'), false);
});

test('a region is unattended only when NO tier has an admin', () => {
    assert.strictEqual(tierRouting.isUnattended({ block: 0, district: 0, state: 0 }), true);
    // A missing block admin is no longer a gap: the district and state admin
    // are holding the same applications.
    assert.strictEqual(tierRouting.isUnattended({ block: 0, district: 1, state: 1 }), false);
    assert.strictEqual(tierRouting.isUnattended({ block: 0, district: 0, state: 1 }), false);
});

test('unknown staffing is not "nobody is there"', () => {
    assert.strictEqual(tierRouting.isUnattended(null), false);
    assert.deepStrictEqual(tierRouting.unstaffedTiers(null), []);
});

test('unstaffedTiers names the vacancies worth filling', () => {
    assert.deepStrictEqual(
        tierRouting.unstaffedTiers({ block: 0, district: 0, state: 2 }),
        ['block', 'district']
    );
});

console.log('\nGeofence filters — now the only thing deciding who sees a file');

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

test("one block's admin cannot match another block's applicants", () => {
    // The guarantee the association asked for in so many words: whatever the
    // applicant chose in the registration form is the only filter applied.
    const regex = buildGeoFilter('block', 'Ariyalur').$or[0].block;
    ['Udayarpalayam', 'Andimadam', 'Ariyalur West'].forEach(other => assert.ok(
        !regex.test(other), `${other} must not fall inside the Ariyalur geofence`
    ));
});

console.log('\nNothing is withheld from a tier');

test('reachedThisTier keeps every row', () => {
    const rows = [
        { id: 'a', stage: 'pending' },
        { id: 'b', stage: 'approved' },
        { id: 'c', stage: 'rejected' }
    ];
    assert.deepStrictEqual(reachedThisTier(rows).map(r => r.id), ['a', 'b', 'c']);
});

test('it returns a copy, so a caller cannot mutate the dashboard payload', () => {
    const rows = [{ id: 'a', stage: 'pending' }];
    const out = reachedThisTier(rows);
    out.push({ id: 'b' });
    assert.strictEqual(rows.length, 1);
});

test('classification never changes the stored status', () => {
    // Display-only, as it always was: the document goes in and comes back
    // untouched, so nothing here can move a file through the workflow.
    const app = { status: 'Pending-District', blockApprovedAt: new Date() };
    classifyForLevel(app, LEVELS.STATE);
    reachedThisTier([app]);
    assert.strictEqual(app.status, 'Pending-District');
});

test('a malformed row does not throw', () => {
    assert.doesNotThrow(() => reachedThisTier([null, undefined, {}]));
    assert.strictEqual(reachedThisTier([null, undefined, {}]).length, 3);
    assert.doesNotThrow(() => classifyForLevel({}, LEVELS.BLOCK));
    assert.strictEqual(classifyForLevel({}, LEVELS.BLOCK), 'pending');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
