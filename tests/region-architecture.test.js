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

// --- orphan fallback --------------------------------------------------------

console.log('\nOrphan fallback routing');

const FULL = { block: 1, district: 1, state: 1 };
const NO_BLOCK = { block: 0, district: 1, state: 1 };
const NO_BLOCK_OR_DISTRICT = { block: 0, district: 0, state: 1 };
const NOBODY = { block: 0, district: 0, state: 0 };

test('a fully staffed region routes to the tier that formally owns the file', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-Block' }, FULL), 'block');
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-District' }, FULL), 'district');
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-State' }, FULL), 'state');
});

test('a deleted block admin escalates their queue to the district tier', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-Block' }, NO_BLOCK), 'district');
    assert.ok(tierRouting.isOrphaned({ status: 'Pending-Block' }, NO_BLOCK));
});

test('escalation keeps climbing past every unstaffed tier', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-Block' }, NO_BLOCK_OR_DISTRICT), 'state');
});

test('an entirely unstaffed region lands on the super admin, never nowhere', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-Block' }, NOBODY), 'super');
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-State' }, NOBODY), 'super');
});

test('terminal statuses owe nobody a decision', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Approved' }, NOBODY), null);
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Rejected' }, NOBODY), null);
    assert.strictEqual(tierRouting.isOrphaned({ status: 'Approved' }, NOBODY), false);
});

test('legacy status spellings escalate the same way as canonical ones', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'PENDING' }, NO_BLOCK), 'district');
    assert.strictEqual(tierRouting.effectiveTier({ status: 'pending_block_approval' }, NO_BLOCK), 'district');
});

test('unknown coverage never escalates — an unknown is not "nobody is there"', () => {
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-Block' }, null), 'block');
    assert.strictEqual(tierRouting.isOrphaned({ status: 'Pending-Block' }, null), false);
});

test('a still-staffed block keeps its own queue when the district is empty', () => {
    // District staffing is irrelevant to a file the block still owns.
    const coverage = { block: 1, district: 0, state: 1 };
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-Block' }, coverage), 'block');
    assert.strictEqual(tierRouting.effectiveTier({ status: 'Pending-District' }, coverage), 'state');
});

console.log('\nAbsorbed approval steps');

test('a district admin acting on an orphaned block file absorbs the block step', () => {
    assert.deepStrictEqual(tierRouting.absorbedTiers({ status: 'Pending-Block' }, 'district'), ['block']);
});

test('a state admin acting on a doubly-orphaned file absorbs both steps', () => {
    assert.deepStrictEqual(tierRouting.absorbedTiers({ status: 'Pending-Block' }, 'state'), ['block', 'district']);
});

test('a tier acting on its own file absorbs nothing', () => {
    assert.deepStrictEqual(tierRouting.absorbedTiers({ status: 'Pending-District' }, 'district'), []);
});

test('a lower tier can never absorb a higher one', () => {
    assert.deepStrictEqual(tierRouting.absorbedTiers({ status: 'Pending-State' }, 'block'), []);
});

test('the super admin absorbs every remaining step', () => {
    assert.deepStrictEqual(tierRouting.absorbedTiers({ status: 'Pending-Block' }, 'super'), ['block', 'district', 'state']);
});

test('the escalation reason names both the missing tier and the one that inherited', () => {
    const reason = tierRouting.fallbackReason({ status: 'Pending-Block' }, NO_BLOCK);
    assert.ok(reason.includes('Block'), reason);
    assert.ok(reason.includes('District'), reason);
    assert.strictEqual(tierRouting.fallbackReason({ status: 'Pending-Block' }, FULL), '');
});

// --- bucket classification with fallback ------------------------------------

console.log('\nDashboard buckets under fallback');

test('an orphaned block file lands in the district admin\'s pending bucket', () => {
    const app = { status: 'Pending-Block' };
    assert.strictEqual(classifyForLevel(app, LEVELS.DISTRICT), 'upstream', 'without coverage it is still upstream');
    assert.strictEqual(classifyForLevel(app, LEVELS.DISTRICT, NO_BLOCK), 'pending');
});

test('escalation does not leak the file into every tier at once', () => {
    const app = { status: 'Pending-Block' };
    assert.strictEqual(classifyForLevel(app, LEVELS.STATE, NO_BLOCK), 'upstream',
        'the state tier must not also claim a file the district inherited');
});

test('a doubly-orphaned file reaches the state tier and only the state tier', () => {
    const app = { status: 'Pending-Block' };
    assert.strictEqual(classifyForLevel(app, LEVELS.STATE, NO_BLOCK_OR_DISTRICT), 'pending');
    assert.strictEqual(classifyForLevel(app, LEVELS.DISTRICT, NO_BLOCK_OR_DISTRICT), 'upstream');
});

test('fallback never re-opens a terminal file', () => {
    const approved = { status: 'Approved', blockApprovedAt: new Date(), districtApprovedAt: new Date() };
    const rejected = { status: 'Rejected', rejectedBy: { adminType: 'BlockAdmin' } };
    assert.strictEqual(classifyForLevel(approved, LEVELS.DISTRICT, NOBODY), 'approved');
    assert.strictEqual(classifyForLevel(rejected, LEVELS.DISTRICT, NOBODY), 'closed');
});

test('full staffing leaves every existing bucket rule untouched', () => {
    const blockApproved = { status: 'Pending-District', blockApprovedAt: new Date() };
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.BLOCK, FULL), 'approved');
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.DISTRICT, FULL), 'pending');
    assert.strictEqual(classifyForLevel(blockApproved, LEVELS.STATE, FULL), 'upstream');
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
