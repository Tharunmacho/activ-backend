/**
 * Verifies the admin-first region architecture: coverage derivation, orphan
 * fallback routing, canonical region spelling, and CSV parsing.
 *
 * These are pure functions over plain objects, so the suite runs without a
 * database. Run with:  node tests/region-architecture.test.js
 */
const assert = require('assert');

const { buildCoverage } = require('../src/modules/regions/region.service');
const { buildKnownRegions } = require('../src/modules/admin/admin.regions');
const { toTierDocument, collectionForRole, isProvisioned } = require('../src/modules/admin/admin.repository');
const geography = require('../src/modules/regions/geography');
const tierRouting = require('../src/modules/common/tierRouting');
const { classifyForLevel, LEVELS } = require('../src/modules/admin/admin.service');
const { parseCsv, parseCsvRecords } = require('../src/core/utils/csv');
const { generatePassword } = require('../src/core/utils/password');

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

// --- fixtures ---------------------------------------------------------------

const admin = (role, state, district = '', block = '', extra = {}) => ({
    id: `${role}:${state}:${district}:${block}`,
    role,
    state,
    district,
    block,
    active: true,
    email: `${role}.${block || district || state}@activ.org`.toLowerCase().replace(/\s+/g, ''),
    ...extra
});

const STAFFED = [
    admin('state_admin', 'Tamil Nadu'),
    admin('district_admin', 'Tamil Nadu', 'Ariyalur'),
    admin('block_admin', 'Tamil Nadu', 'Ariyalur', 'Sendurai'),
    admin('block_admin', 'Tamil Nadu', 'Ariyalur', 'Andimadam'),
    // A second admin on the same block: the load-balancing case.
    admin('block_admin', 'Tamil Nadu', 'Ariyalur', 'Sendurai', { id: 'block:second', email: 'second@activ.org' }),
    admin('super_admin', '')
];

const flatten = (states) => {
    const out = [];
    states.forEach((stateNode) => {
        stateNode.districts.forEach((districtNode) => {
            districtNode.blocks.forEach((blockNode) => {
                out.push(`${stateNode.name}/${districtNode.name}/${blockNode.name}=${blockNode.admins.length}`);
            });
        });
    });
    return out.sort();
};

// --- coverage ---------------------------------------------------------------

console.log('\nCoverage derived from the admin database');

test('every staffed region appears exactly once, with its admin count', () => {
    const coverage = flatten(buildCoverage(STAFFED));
    assert.deepStrictEqual(coverage, [
        'Tamil Nadu/Ariyalur/Andimadam=1',
        'Tamil Nadu/Ariyalur/Sendurai=2'
    ]);
});

test('two admins on the same block collapse to one region with count 2', () => {
    const states = buildCoverage(STAFFED);
    const block = states.get('tamil nadu').districts.get('ariyalur').blocks.get('sendurai');
    assert.strictEqual(block.admins.length, 2, 'both admins share the one region node');
});

test('region names are matched case- and whitespace-insensitively', () => {
    const states = buildCoverage([
        admin('block_admin', 'Tamil Nadu', 'Ariyalur', 'Sendurai'),
        admin('block_admin', 'TAMIL  NADU', 'ariyalur', 'SENDURAI', { id: 'x', email: 'x@a.com' })
    ]);
    assert.strictEqual(states.size, 1, 'a casing difference must not create a second state');
    const block = states.get('tamil nadu').districts.get('ariyalur').blocks.get('sendurai');
    assert.strictEqual(block.admins.length, 2);
});

test('a super admin belongs to no region node', () => {
    const states = buildCoverage([admin('super_admin', '')]);
    assert.strictEqual(states.size, 0);
});

test('an admin with a blank region is ignored rather than creating an empty node', () => {
    const states = buildCoverage([admin('block_admin', '', '', '')]);
    assert.strictEqual(states.size, 0);
});

// --- who may decide, and where the gaps are ---------------------------------

console.log('\nParallel review, and unstaffed regions');

/*
 * There is no orphan fallback any more, and no queue to escalate.
 *
 * Under the sequential workflow a file belonged to one tier at a time, so a
 * region whose block admin had been deleted held applications nobody could
 * open — `effectiveTier` existed to walk that file up to the first tier that
 * was staffed, and `absorbedTiers` existed so the tier it landed on did not
 * have to approve it twice.
 *
 * Submitting to all three tiers at once removes the problem rather than routing
 * around it: a block with no admin is still covered, because the district and
 * state admin of that region were already holding the same file. What is left
 * to report is the one case that still strands an applicant — a region with
 * nobody at ANY tier — and that is what these assert.
 */

const FULL = { block: 1, district: 1, state: 1 };
const NO_BLOCK = { block: 0, district: 1, state: 1 };
const NO_BLOCK_OR_DISTRICT = { block: 0, district: 0, state: 1 };
const NOBODY = { block: 0, district: 0, state: 0 };

test('a pending application is held by all three tiers of its own region', () => {
    assert.deepStrictEqual(
        tierRouting.reviewingTiers({ status: 'Pending' }),
        ['block', 'district', 'state']
    );
});

test('any of the three may decide it, and so may the super admin', () => {
    ['block', 'district', 'state', 'super'].forEach(tier => assert.strictEqual(
        tierRouting.canTierAct({ status: 'Pending' }, tier), true, tier
    ));
});

test("an application the STATE decided is nobody's to decide again", () => {
    /*
     * The outcome is the State's verdict and it is terminal — but it has to
     * have been the STATE's. A bare `Approved` with no attribution is read as
     * the State's, because under both the previous workflows the state
     * timestamp was what an unattributed approval left behind.
     */
    [
        { status: 'Approved', approvedBy: { adminType: 'StateAdmin' } },
        { status: 'Rejected', rejectedBy: { adminType: 'StateAdmin' } },
        { status: 'Approved', stateApprovedAt: new Date() }
    ].forEach((app) => {
        assert.strictEqual(tierRouting.canTierAct(app, 'state'), false, app.status);
        assert.strictEqual(tierRouting.canTierAct(app, 'super'), false, app.status);
    });
});

test("an application a LOWER tier decided is still the State's to decide", () => {
    /*
     * The association's rule: nobody is a member until the State says so. A row
     * the previous build let a District admin approve has a member profile and
     * an `Approved` status, and the State has still never seen it — so the seat
     * stays open and the buttons stay on.
     */
    const byDistrict = { status: 'Approved', approvedBy: { adminType: 'DistrictAdmin' } };
    assert.strictEqual(tierRouting.canTierAct(byDistrict, 'state'), true);
    assert.strictEqual(tierRouting.canTierAct(byDistrict, 'super'), true);
    // ...and the district, which did decide, cannot decide twice.
    assert.strictEqual(tierRouting.canTierAct(byDistrict, 'district'), false);
});

test("a State approval carries the tiers below it", () => {
    /*
     * The association's rule: the tiers are an authority hierarchy. Once the
     * State has approved, the District's and Block's steps are settled — asking
     * them to decide would be asking for a decision that changes nothing.
     */
    const stateApproved = {
        status: 'Approved',
        approvedBy: { adminType: 'StateAdmin' },
        reviews: { state: { decision: 'approved', adminType: 'StateAdmin' } }
    };
    assert.deepStrictEqual(tierRouting.reviewingTiers(stateApproved), []);
    assert.strictEqual(tierRouting.canTierAct(stateApproved, 'block'), false);
    assert.strictEqual(tierRouting.canTierAct(stateApproved, 'district'), false);
});

test('legacy status spellings are held exactly the same way', () => {
    ['PENDING', 'Pending-Block', 'Pending-District', 'Pending-State', 'pending_block_approval']
        .forEach(status => assert.deepStrictEqual(
            tierRouting.reviewingTiers({ status }),
            ['block', 'district', 'state'],
            status
        ));
});

test('a missing block admin is not a coverage gap', () => {
    // It was the canonical one. The district and state admin hold the same
    // applications, so nothing is stranded and nothing needs escalating.
    assert.strictEqual(tierRouting.isUnattended(NO_BLOCK), false);
    assert.strictEqual(tierRouting.isUnattended(NO_BLOCK_OR_DISTRICT), false);
    assert.strictEqual(tierRouting.isUnattended(FULL), false);
});

test('a region with nobody at any tier is, and is the super admin\'s to clear', () => {
    assert.strictEqual(tierRouting.isUnattended(NOBODY), true);
    assert.deepStrictEqual(tierRouting.unstaffedTiers(NOBODY), ['block', 'district', 'state']);
});

test('unknown coverage is never reported as unattended', () => {
    // An unknown is not "nobody is there", and reporting a staffed region as
    // abandoned is worse than reporting nothing.
    assert.strictEqual(tierRouting.isUnattended(null), false);
    assert.deepStrictEqual(tierRouting.unstaffedTiers(null), []);
});

test('unstaffedTiers names the vacancies without claiming they strand anyone', () => {
    assert.deepStrictEqual(tierRouting.unstaffedTiers(NO_BLOCK), ['block']);
    assert.deepStrictEqual(tierRouting.unstaffedTiers(NO_BLOCK_OR_DISTRICT), ['block', 'district']);
});

// --- bucket classification ---------------------------------------------------

console.log('\nDashboard buckets');

test('an application in an unstaffed block is pending for every tier that covers it', () => {
    const app = { status: 'Pending' };
    [LEVELS.BLOCK, LEVELS.DISTRICT, LEVELS.STATE].forEach(level => assert.strictEqual(
        classifyForLevel(app, level, NO_BLOCK), 'pending', level
    ));
});

test('staffing changes no bucket at all', () => {
    const app = { status: 'Pending' };
    [FULL, NO_BLOCK, NO_BLOCK_OR_DISTRICT, NOBODY, null].forEach(coverage => assert.strictEqual(
        classifyForLevel(app, LEVELS.DISTRICT, coverage), 'pending'
    ));
});

test('classification never re-opens a tier\'s own decision', () => {
    const districtApproved = {
        status: 'Pending',
        reviews: { district: { decision: 'approved', adminType: 'DistrictAdmin' } }
    };
    const districtRejected = {
        status: 'Pending',
        reviews: { district: { decision: 'rejected', adminType: 'DistrictAdmin' } }
    };
    assert.strictEqual(classifyForLevel(districtApproved, LEVELS.DISTRICT, NOBODY), 'approved');
    assert.strictEqual(classifyForLevel(districtRejected, LEVELS.DISTRICT, NOBODY), 'rejected');
});

test("a tier's bucket is its own verdict, not the application's outcome", () => {
    /*
     * A row approved by the block under the previous build. The block's own
     * decision reads back; the district, which never decided anything, is
     * pending — and the APPLICATION is still Approved, which is what enrols the
     * member. Three different answers from one document, all true.
     */
    const approvedByBlock = {
        status: 'Approved',
        blockApprovedAt: new Date(),
        approvedBy: { adminType: 'BlockAdmin' }
    };
    assert.strictEqual(classifyForLevel(approvedByBlock, LEVELS.BLOCK, NOBODY), 'approved');
    assert.strictEqual(classifyForLevel(approvedByBlock, LEVELS.DISTRICT, NOBODY), 'pending');
    assert.strictEqual(tierRouting.normalizeStatus(approvedByBlock.status), 'Approved');
});

test("a file left mid-relay keeps the block's real approval and owes the rest", () => {
    const blockApproved = { status: 'Pending-District', blockApprovedAt: new Date() };
    // The block did approve it — `blockApprovedAt` was only ever written by the
    // block acting — so its own queue must not ask it again.
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.BLOCK, FULL), 'approved');
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.DISTRICT, FULL), 'pending');
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.STATE, FULL), 'pending');
});

test('stateApprovedAt alone is NOT read as the State having approved', () => {
    /*
     * The parallel build stamped `stateApprovedAt` on EVERY approval whoever
     * made it, because it is what the member screens read as the approval date.
     * Treating it as the State's own verdict would credit the State with every
     * decision a Block or District admin ever made — the exact bug the per-tier
     * verdicts exist to stop.
     */
    const approvedByBlockUnderParallel = {
        status: 'Approved',
        stateApprovedAt: new Date(),
        blockApprovedAt: new Date(),
        approvedBy: { adminType: 'BlockAdmin' }
    };
    assert.strictEqual(classifyForLevel(approvedByBlockUnderParallel, LEVELS.BLOCK, FULL), 'approved');
    assert.strictEqual(classifyForLevel(approvedByBlockUnderParallel, LEVELS.STATE, FULL), 'pending');
    assert.strictEqual(tierRouting.canTierAct(approvedByBlockUnderParallel, 'state'), true);
});

// --- canonical geography ----------------------------------------------------

console.log('\nCanonical region spelling');

test('the reference dataset loaded', () => {
    assert.ok(geography.isLoaded(), 'india-geography.json must be readable');
    assert.ok(geography.listStates().length > 25);
});

test('casing and stray whitespace normalise to one canonical spelling', () => {
    const result = geography.normalizeRegion({ state: 'TAMIL  NADU', district: 'ariyalur', block: 'sendurai' });
    assert.strictEqual(result.state, 'Tamil Nadu');
    assert.strictEqual(result.district, 'Ariyalur');
    assert.strictEqual(result.block, 'Sendurai');
    assert.deepStrictEqual(result.unknown, { state: false, district: false, block: false });
});

test('an unrecognised state is flagged rather than silently accepted', () => {
    const result = geography.normalizeRegion({ state: 'Tamilnadu Typo' });
    assert.strictEqual(result.unknown.state, true);
    assert.strictEqual(result.state, 'Tamilnadu Typo', 'the input is preserved for the error message');
});

test('an unlisted block is passed through with a flag, not rejected', () => {
    const result = geography.normalizeRegion({ state: 'Tamil Nadu', district: 'Ariyalur', block: 'Brand New Block' });
    assert.strictEqual(result.state, 'Tamil Nadu');
    assert.strictEqual(result.unknown.block, true);
    assert.strictEqual(result.block, 'Brand New Block');
});

test('a district is only recognised inside its own state', () => {
    assert.strictEqual(geography.canonicalDistrict('Kerala', 'Ariyalur'), '',
        'Ariyalur is a Tamil Nadu district and must not validate under Kerala');
});

// --- segregated collections -------------------------------------------------

console.log('\nSegregated per-tier storage');

test('each tier is written to its own collection', () => {
    assert.strictEqual(collectionForRole('block_admin'), 'blockadmins');
    assert.strictEqual(collectionForRole('district_admin'), 'districtadmins');
    assert.strictEqual(collectionForRole('state_admin'), 'stateadmins');
});

test('role spellings all route to the same collection', () => {
    assert.strictEqual(collectionForRole('BlockAdmin'), 'blockadmins');
    assert.strictEqual(collectionForRole('block admin'), 'blockadmins');
});

test('a document is written with the per-tier field names, not the unified ones', () => {
    const doc = toTierDocument({
        role: 'block_admin',
        email: 'A@B.COM',
        password: 'hashed',
        phone: '99999',
        isActive: true,
        state: 'Tamil Nadu',
        district: 'Ariyalur',
        block: 'Sendurai'
    }, 'BA0001');

    // Writing `password` / `phone` / `isActive` into a per-tier collection is a
    // silent no-op under Mongoose strict mode — the account would have no
    // credential and nothing would say so.
    assert.strictEqual(doc.passwordHash, 'hashed');
    assert.strictEqual(doc.phoneNumber, '99999');
    assert.strictEqual(doc.active, true);
    assert.strictEqual(doc.password, undefined);
    assert.strictEqual(doc.phone, undefined);
    assert.strictEqual(doc.email, 'a@b.com', 'email is lowercased for the unique index');
});

test('a tier never stores a region below its own level', () => {
    const stateDoc = toTierDocument({ role: 'state_admin', state: 'Kerala', district: 'Kollam', block: 'Anchal' }, 'SA0001');
    assert.strictEqual(stateDoc.district, undefined);
    assert.strictEqual(stateDoc.block, undefined);

    const districtDoc = toTierDocument({ role: 'district_admin', state: 'Kerala', district: 'Kollam', block: 'Anchal' }, 'DA0001');
    assert.strictEqual(districtDoc.district, 'Kollam');
    assert.strictEqual(districtDoc.block, undefined);
});

test('every created account is stamped, which is what separates it from scaffold', () => {
    assert.strictEqual(toTierDocument({ role: 'block_admin' }, 'BA0001').createdVia, 'super_admin_ui');
    assert.strictEqual(toTierDocument({ role: 'block_admin', createdVia: 'bulk_csv' }, 'BA0001').createdVia, 'bulk_csv');
});

test('an unstamped record does not count as staffing', () => {
    assert.strictEqual(isProvisioned({ email: 'x@y.com' }, 'adminsdb:blockadmins'), false);
    assert.strictEqual(isProvisioned({ createdVia: 'tn_pilot_seed' }, 'adminsdb:blockadmins'), true);
});

test('the legacy unified collection is always treated as real', () => {
    // It was never scaffolded, so an unstamped record there is a real account.
    assert.strictEqual(isProvisioned({ email: 'x@y.com' }, 'admins'), true);
});

// --- free-text region spelling ----------------------------------------------

console.log('\nFree-text regions with spelling reuse');

const KNOWN = buildKnownRegions([
    { state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai' },
    { state: 'Kerala', district: 'Ariyalur', block: '' }
]);

test('an existing region is found regardless of how it is typed', () => {
    assert.strictEqual(KNOWN.states.get('tamil nadu'), 'Tamil Nadu');
    assert.strictEqual(KNOWN.blocks.get('tamil nadu|ariyalur|sendurai'), 'Sendurai');
});

test('the same district name in two states stays two districts', () => {
    // Collapsing these would make one state adopt the other's spelling, and a
    // geofence built from the wrong one matches nothing.
    assert.strictEqual(KNOWN.districts.get('tamil nadu|ariyalur'), 'Ariyalur');
    assert.strictEqual(KNOWN.districts.get('kerala|ariyalur'), 'Ariyalur');
    assert.strictEqual(KNOWN.districts.size, 2);
});

test('a block is only known under its own district', () => {
    assert.strictEqual(KNOWN.blocks.get('kerala|ariyalur|sendurai'), undefined);
});

test('blank region levels create no entries', () => {
    const known = buildKnownRegions([{ state: '', district: '', block: '' }]);
    assert.strictEqual(known.states.size, 0);
    assert.strictEqual(known.districts.size, 0);
    assert.strictEqual(known.blocks.size, 0);
});

// --- CSV --------------------------------------------------------------------

console.log('\nCSV parsing');

test('quoted fields keep their embedded commas', () => {
    const rows = parseCsv('a,b\n"Doe, Jane",2\n');
    assert.deepStrictEqual(rows, [['a', 'b'], ['Doe, Jane', '2']]);
});

test('doubled quotes unescape to one literal quote', () => {
    const rows = parseCsv('a\n"She said ""hi"""\n');
    assert.deepStrictEqual(rows, [['a'], ['She said "hi"']]);
});

test('CRLF line endings and a trailing newline produce no phantom row', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    assert.deepStrictEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('a newline inside a quoted field does not split the row', () => {
    const rows = parseCsv('a,b\n"line1\nline2",2\n');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1][0], 'line1\nline2');
});

test('a UTF-8 BOM does not corrupt the first header name', () => {
    const { headers } = parseCsvRecords('﻿role,fullName\nblock_admin,Jane\n');
    assert.strictEqual(headers[0], 'role', 'a BOM-prefixed header would never match a lookup');
});

test('headers normalise so "Full Name" and "fullName" are the same column', () => {
    const { rows } = parseCsvRecords('Full Name,E-Mail\nJane,a@b.com\n');
    assert.strictEqual(rows[0].fullname, 'Jane');
});

test('row numbers match the spreadsheet, counting the header', () => {
    const { rows } = parseCsvRecords('role\na\nb\n');
    assert.deepStrictEqual(rows.map(r => r.lineNumber), [2, 3]);
});

test('a short row leaves the missing columns empty rather than undefined', () => {
    const { rows } = parseCsvRecords('role,fullName,email\nblock_admin\n');
    assert.strictEqual(rows[0].email, '');
});

// --- generated credentials --------------------------------------------------

console.log('\nGenerated passwords');

test('a generated password satisfies the platform minimum and every class', () => {
    for (let i = 0; i < 50; i += 1) {
        const pw = generatePassword();
        assert.ok(pw.length >= 12, `too short: ${pw}`);
        assert.ok(/[A-Z]/.test(pw), `no uppercase: ${pw}`);
        assert.ok(/[a-z]/.test(pw), `no lowercase: ${pw}`);
        assert.ok(/[0-9]/.test(pw), `no digit: ${pw}`);
        assert.ok(/[!@#$%&*?]/.test(pw), `no symbol: ${pw}`);
    }
});

test('generated passwords exclude glyphs that are misread when retyped', () => {
    for (let i = 0; i < 50; i += 1) {
        assert.ok(!/[l1IO0]/.test(generatePassword()), 'ambiguous characters must not appear');
    }
});

test('generated passwords do not repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(generatePassword());
    assert.strictEqual(seen.size, 200);
});

// --- the two shapes of the region tree ---------------------------------------

/**
 * `getTree` answers two different questions and the difference is load-bearing.
 *
 * The pruned tree is the applicant's: bottom-up, so a registration dropdown
 * cannot offer a state with no block beneath it to finish choosing through. The
 * unpruned one is every region the admin database knows, which is what content
 * targeting needs — a state carrying only a state admin is a real audience.
 *
 * Reading the pruned tree for targeting silently deleted such a state from the
 * super admin's event picker: two staffed states in the database, one offered on
 * screen, and nothing to say the other had been withheld or why. These assert
 * both shapes off one fixture, so the pruning cannot quietly migrate from one to
 * the other.
 *
 * `findActive` is stubbed rather than mocked at the connection: `getTree` calls
 * it through the module object at call time, and pointing it at a fixture keeps
 * this a pure test with no database.
 */
const runTreeTests = async() => {
    console.log('\nThe region tree, pruned and unpruned');

    const regionService = require('../src/modules/regions/region.service');
    const adminRepository = require('../src/modules/admin/admin.repository');

    // Tamil Nadu is staffed down to blocks; Kerala has a state admin and
    // nothing beneath it — the case that was disappearing.
    const MIXED = [
        admin('state_admin', 'Tamil Nadu'),
        admin('district_admin', 'Tamil Nadu', 'Ariyalur'),
        admin('block_admin', 'Tamil Nadu', 'Ariyalur', 'Sendurai'),
        admin('state_admin', 'Kerala')
    ];

    const realFindActive = adminRepository.findActive;
    adminRepository.findActive = async() => MIXED;

    try {
        const selectable = await regionService.getTree();
        const all = await regionService.getTree({ prune: false });
        const names = (tree) => tree.map(node => node.name).sort();

        await asyncTest('the selectable tree drops a state with no block admin', () => {
            assert.deepStrictEqual(names(selectable), ['Tamil Nadu']);
        });

        await asyncTest('the unpruned tree keeps it', () => {
            assert.deepStrictEqual(names(all), ['Kerala', 'Tamil Nadu']);
        });

        await asyncTest('a state with no districts is reported as having none, not omitted', () => {
            const kerala = all.find(node => node.name === 'Kerala');
            assert.ok(kerala, 'Kerala is in the unpruned tree');
            assert.deepStrictEqual(kerala.districts, [], 'and carries an empty district list');
            assert.strictEqual(kerala.admins, 1, 'with its own staffing count intact');
        });

        await asyncTest('the staffed branch is identical in both shapes', () => {
            const inSelectable = selectable.find(node => node.name === 'Tamil Nadu');
            const inAll = all.find(node => node.name === 'Tamil Nadu');
            assert.deepStrictEqual(
                inAll.districts.map(d => `${d.name}:${d.blocks.map(b => b.name).join(',')}`),
                inSelectable.districts.map(d => `${d.name}:${d.blocks.map(b => b.name).join(',')}`)
            );
        });

        await asyncTest('the two shapes do not evict each other from the cache', () => {
            // Both were cached in one slot at first, so asking for one shape
            // returned the other's answer to the next caller — which would put
            // an unreachable state in an applicant's dropdown.
            assert.deepStrictEqual(names(selectable), ['Tamil Nadu']);
            assert.deepStrictEqual(names(all), ['Kerala', 'Tamil Nadu']);
        });
    } finally {
        adminRepository.findActive = realFindActive;
    }
};

/** The sync harness above, for a check that has to be awaited. */
async function asyncTest(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  PASS  ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${error.message}`);
    }
}

runTreeTests()
    .catch((error) => {
        failed += 1;
        console.error('\nThe tree tests crashed:', error.message);
    })
    .then(() => {
        console.log(`\n${passed} passed, ${failed} failed\n`);
        process.exit(failed > 0 ? 1 : 0);
    });
