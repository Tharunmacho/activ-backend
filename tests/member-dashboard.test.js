/**
 * The pure logic behind the paid member dashboard.
 *
 * Region targeting for Association Updates (MEM-001), the agenda/speaker/
 * reminder sanitizers and the registration cutoff for events (EVT-001/002), the
 * directory's search filters (DIR-001) and the stock-state rule (BUS-002).
 *
 * No database: everything asserted here is a pure function over plain objects,
 * which is exactly why these are the parts worth pinning down — they are the
 * rules the UI copies, and a UI whose copy of a rule drifts from the server's
 * shows a member a button that answers 400.
 *
 * Run with:  node tests/member-dashboard.test.js
 */
const assert = require('assert');

const regionMatch = require('../src/modules/common/regionMatch');
const eventService = require('../src/modules/events/event.service');
const announcementService = require('../src/modules/announcements/announcement.service');
const directoryService = require('../src/modules/members/directory.service');
const { stockState } = require('../src/models/Product');
const { isPaidStatus } = require('../src/modules/common/memberContext');
const { dayRange } = require('../src/modules/analytics/memberAnalytics.service');

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

const section = (name) => console.log(`\n${name}`);

// ============================================================ MEM-001 targeting

section('Association Updates reach the right members');

test('an update with no region is for everyone', () => {
    assert.strictEqual(regionMatch.targetsMember({}, { state: 'Tamil Nadu' }), true);
    assert.strictEqual(regionMatch.targetsMember({ state: '', district: '', block: '' }, {}), true);
});

test('a state update reaches that state and no other', () => {
    const update = { state: 'Tamil Nadu' };
    assert.strictEqual(regionMatch.targetsMember(update, { state: 'Tamil Nadu' }), true);
    assert.strictEqual(regionMatch.targetsMember(update, { state: 'Kerala' }), false);
});

test('spelling is reconciled the way the region tree reconciles it', () => {
    // "tamil  nadu" and "Tamil Nadu" are one place to a person and two strings
    // to Mongo. Free-text region entry produces both.
    assert.strictEqual(regionMatch.targetsMember({ state: 'tamil  nadu' }, { state: 'Tamil Nadu' }), true);
    assert.strictEqual(regionMatch.targetsMember({ state: ' Tamil Nadu ' }, { state: 'tamil nadu' }), true);
});

test('matching is anchored, so one region is not a prefix of another', () => {
    assert.strictEqual(regionMatch.targetsMember({ district: 'Salem' }, { district: 'Salem West' }), false);
    assert.strictEqual(regionMatch.targetsMember({ block: 'Andi' }, { block: 'Andimadam' }), false);
});

test('a region named with regex metacharacters is matched literally', () => {
    const update = { district: 'Sivaganga (South)' };
    assert.strictEqual(regionMatch.targetsMember(update, { district: 'Sivaganga (South)' }), true);
    assert.strictEqual(regionMatch.targetsMember(update, { district: 'Sivaganga South' }), false);
});

test('a member with no district does not receive district-targeted updates', () => {
    // An unknown region is not "everywhere" — a notice for one district is not
    // for someone whose district nobody has recorded.
    assert.strictEqual(regionMatch.targetsMember({ district: 'Ariyalur' }, { state: 'Tamil Nadu' }), false);
});

test('the audience clause admits an untargeted update at every level', () => {
    const clause = regionMatch.audienceClause({ state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai' });
    assert.strictEqual(clause.$and.length, 3);
    clause.$and.forEach((level) => {
        // empty, missing, null, and the member's own region
        assert.strictEqual(level.$or.length, 4);
    });
});

test('a member missing a region gets only the "aimed at everyone" arms', () => {
    const clause = regionMatch.audienceClause({ state: 'Tamil Nadu' });
    assert.strictEqual(clause.$and[0].$or.length, 4, 'state is known');
    assert.strictEqual(clause.$and[1].$or.length, 3, 'district is not');
    assert.strictEqual(clause.$and[2].$or.length, 3, 'block is not');
});

test('the most local update sorts above the national one', () => {
    const national = { state: '', district: '', block: '' };
    const state = { state: 'Tamil Nadu' };
    const block = { state: 'Tamil Nadu', district: 'Ariyalur', block: 'Sendurai' };

    assert.strictEqual(regionMatch.targetDepth(national), 0);
    assert.strictEqual(regionMatch.targetDepth(state), 1);
    assert.strictEqual(regionMatch.targetDepth(block), 3);
});

test('the target reads as a trail for a person', () => {
    assert.strictEqual(
        regionMatch.targetLabel({ state: 'Tamil Nadu', district: 'Ariyalur', block: '' }),
        'Tamil Nadu › Ariyalur'
    );
    assert.strictEqual(regionMatch.targetLabel({}), '');
});

test('an excerpt strips markup before truncating, never after', () => {
    const body = '<p><strong>Sivaganga</strong> district office will remain closed ' + 'x'.repeat(300) + '</p>';
    const summary = announcementService.excerpt(body);

    assert.ok(!summary.includes('<'), 'no markup survives into the card');
    assert.ok(summary.length <= 181, `too long: ${summary.length}`);
    assert.ok(summary.endsWith('…'));
});

test('a short body is used whole, with no ellipsis', () => {
    assert.strictEqual(announcementService.excerpt('Office closed on Friday.'), 'Office closed on Friday.');
});

// ============================================================ EVT-001 agenda

section('Event agendas and speakers');

test('agenda rows are ordered by time whatever order they arrive in', () => {
    const agenda = eventService.sanitizeAgenda([
        { startTime: '14:00', title: 'Panel' },
        { startTime: '09:30', title: 'Keynote' },
        { startTime: '11:00', title: 'Break' }
    ]);

    assert.deepStrictEqual(agenda.map((row) => row.title), ['Keynote', 'Break', 'Panel']);
});

test('untimed rows fall to the end rather than sorting as midnight', () => {
    const agenda = eventService.sanitizeAgenda([
        { title: 'Networking' },
        { startTime: '09:30', title: 'Keynote' }
    ]);

    assert.deepStrictEqual(agenda.map((row) => row.title), ['Keynote', 'Networking']);
});

test('empty rows the editor tabbed through are dropped', () => {
    const agenda = eventService.sanitizeAgenda([
        { startTime: '', title: '', description: '' },
        { startTime: '09:30', title: 'Keynote' },
        null,
        'not an object'
    ]);

    assert.strictEqual(agenda.length, 1);
});

test('a time is normalised to HH:MM and nonsense becomes untimed', () => {
    assert.strictEqual(eventService.toClockTime('9:05'), '09:05');
    assert.strictEqual(eventService.toClockTime('09:05:00'), '09:05');
    assert.strictEqual(eventService.toClockTime('25:00'), '');
    assert.strictEqual(eventService.toClockTime('09:75'), '');
    assert.strictEqual(eventService.toClockTime('half nine'), '');
    assert.strictEqual(eventService.toClockTime(null), '');
});

test('a speaker with no name is not a speaker', () => {
    const speakers = eventService.sanitizeSpeakers([
        { name: '', role: 'Chief Guest' },
        { name: 'R. Selvam', role: 'President', org: 'ACTIV' }
    ]);

    assert.strictEqual(speakers.length, 1);
    assert.strictEqual(speakers[0].organization, 'ACTIV');
});

test('reminder offsets are whole hours, de-duplicated, furthest-out first', () => {
    assert.deepStrictEqual(eventService.sanitizeReminders([24, 1, 24, 2.4, 0, -5, 'x']), [24, 2, 1]);
});

test('reminders beyond a month are refused rather than stored', () => {
    assert.deepStrictEqual(eventService.sanitizeReminders([24 * 31]), []);
    assert.deepStrictEqual(eventService.sanitizeReminders([24 * 30]), [24 * 30]);
});

// ============================================================ EVT-002 registration

section('Event registration windows');

test('registration closes when the event starts, unless told otherwise', () => {
    const startAt = new Date('2026-09-14T09:30:00Z');
    assert.strictEqual(
        eventService.registrationClosesAt({ startAt }).getTime(),
        startAt.getTime()
    );
});

test('an explicit deadline wins over the start time', () => {
    const startAt = new Date('2026-09-14T09:30:00Z');
    const deadline = new Date('2026-09-10T23:59:00Z');

    assert.strictEqual(
        eventService.registrationClosesAt({ startAt, registrationDeadline: deadline }).getTime(),
        deadline.getTime()
    );
});

test('an event with no date has no cutoff to compute', () => {
    assert.strictEqual(eventService.registrationClosesAt({}), null);
});

test('the mapper carries the banner fields that used to be dropped', () => {
    // bannerAlt/bannerFit/bannerPosition were on the model and missing from
    // `toEvent`, so the CMS could set them and no client ever received them.
    const event = eventService.toEvent({
        title: 'Annual Meet',
        bannerAlt: 'Members at the 2025 meet',
        bannerFit: 'contain',
        bannerPosition: 'top'
    });

    assert.strictEqual(event.bannerAlt, 'Members at the 2025 meet');
    assert.strictEqual(event.bannerFit, 'contain');
    assert.strictEqual(event.bannerPosition, 'top');
});

test('an unknown fit falls back to cover rather than to nothing', () => {
    assert.strictEqual(eventService.toEvent({ bannerFit: 'squish' }).bannerFit, 'cover');
});

test('counts nobody has supplied are null, never a confident zero', () => {
    const event = eventService.toEvent({ title: 'Annual Meet' });
    assert.strictEqual(event.registeredCount, null);
    assert.strictEqual(event.myRegistration, null);
});

test('an event defaults to the open audience, never to members-only', () => {
    // Every event already in the collection predates this field. Defaulting to
    // `paid` would retire the entire published programme on deploy.
    assert.strictEqual(eventService.toEvent({ title: 'Annual Meet' }).audience, 'all');
});

// ============================================================ DIR-001 directory

section('Member directory filters');

test('a free-text term is escaped before it becomes a regex', () => {
    const filter = directoryService.textFilter('Raj (Kumar)');
    assert.ok(filter, 'a term produces a filter');
    assert.ok(filter.$or[0].fullName.test('Raj (Kumar) Textiles'));
    assert.ok(!filter.$or[0].fullName.test('Raj Kumar'));
});

test('search matches at a word boundary, not anywhere in the string', () => {
    const filter = directoryService.textFilter('raj');
    assert.ok(filter.$or[0].fullName.test('Raj Kumar'));
    assert.ok(filter.$or[0].fullName.test('Mohan Raj'));
    assert.ok(!filter.$or[0].fullName.test('Suraj'));
});

test('an empty search box filters nothing', () => {
    assert.strictEqual(directoryService.textFilter(''), null);
    assert.strictEqual(directoryService.textFilter('   '), null);
});

test('region filters are anchored so a district is not a prefix match', () => {
    const filter = directoryService.regionFilter({ district: 'Salem' });
    assert.ok(filter.district.test('Salem'));
    assert.ok(!filter.district.test('Salem West'));
});

test('an omitted region filter is absent, not an empty-string match', () => {
    // `{ district: '' }` would match only members whose district is blank —
    // the opposite of "no district filter".
    assert.deepStrictEqual(Object.keys(directoryService.regionFilter({ state: 'Tamil Nadu' })), ['state']);
});

test('the directory returns an allow-list and never the whole document', () => {
    const entry = directoryService.toDirectoryEntry({
        _id: 'abc',
        fullName: 'Raj Kumar',
        aadhaarNumber: '111122223333',
        paymentId: 'pay_123',
        email: 'raj@example.com',
        state: 'Tamil Nadu'
    });

    assert.ok(!('aadhaarNumber' in entry));
    assert.ok(!('paymentId' in entry));
    assert.ok(!('email' in entry));
    assert.strictEqual(entry.fullName, 'Raj Kumar');
});

test('sectors are the distinct business types of the member companies', () => {
    const entry = directoryService.toDirectoryEntry({ _id: 'a', fullName: 'Raj' }, [
        { _id: '1', businessName: 'A', businessType: 'Trader' },
        { _id: '2', businessName: 'B', businessType: 'Trader' },
        { _id: '3', businessName: 'C', businessType: 'Manufacturing' }
    ]);

    assert.deepStrictEqual(entry.sectors, ['Trader', 'Manufacturing']);
});

test('the sector list offers only types the database will accept', () => {
    // A dropdown must not offer a choice the enum refuses — the same rule
    // `businessTypes.js` was written to enforce.
    const { BUSINESS_TYPES } = require('../src/modules/members/businessTypes');
    assert.deepStrictEqual(directoryService.listSectors(), BUSINESS_TYPES);
});

// ============================================================ BUS-002 stock

section('Stock state');

test('nothing left is out of stock, whatever the threshold says', () => {
    assert.strictEqual(stockState({ stock: 0, minStock: 0 }), 'out');
    assert.strictEqual(stockState({ stock: 0, minStock: 10 }), 'out');
    assert.strictEqual(stockState({}), 'out');
});

test('a zero threshold means "do not warn me about this line"', () => {
    assert.strictEqual(stockState({ stock: 1, minStock: 0 }), 'ok');
    assert.strictEqual(stockState({ stock: 5000, minStock: 0 }), 'ok');
});

test('low is at or below the threshold, not strictly below it', () => {
    assert.strictEqual(stockState({ stock: 10, minStock: 10 }), 'low');
    assert.strictEqual(stockState({ stock: 9, minStock: 10 }), 'low');
    assert.strictEqual(stockState({ stock: 11, minStock: 10 }), 'ok');
});

// ============================================================ shared rules

section('Shared membership rules');

test('both stored spellings of an active membership count as paid', () => {
    // The website collapses exactly this pair. A dashboard that shows paid-only
    // cards and an endpoint that answers 403 behind them is a door that opens
    // onto a wall.
    assert.strictEqual(isPaidStatus('active'), true);
    assert.strictEqual(isPaidStatus('approved'), true);
    assert.strictEqual(isPaidStatus('Active'), true);
    assert.strictEqual(isPaidStatus('pending'), false);
    assert.strictEqual(isPaidStatus('expired'), false);
    assert.strictEqual(isPaidStatus(undefined), false);
});

test('an analytics window covers every day, including the quiet ones', () => {
    const days = dayRange(30);
    assert.strictEqual(days.length, 30);
    assert.strictEqual(new Set(days).size, 30, 'no duplicate days across a month boundary');
    assert.ok(days[0] < days[29], 'oldest first');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(days[0]));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
