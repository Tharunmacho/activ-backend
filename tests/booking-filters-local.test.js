// Disposable loopback database only. No messages, gateway calls or production writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const ExcelJS = require('exceljs');
process.env.NODE_ENV = 'test';
let mongo;
(async () => {
    mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
    process.env.MONGODB_URI = mongo.getUri();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    // Exercise the real location directory without opening the separate admin
    // connection or reading any configured server.
    const adminRepository = require('../src/modules/admin/admin.repository');
    adminRepository.findActive = async () => [
        { role: 'state_admin', state: 'Community State', email: 'state@example.test' },
        { role: 'district_admin', state: 'Community State', district: 'Community District', email: 'district@example.test' },
        { role: 'state_admin', state: 'State without districts', email: 'state-only@example.test' },
    ];
    const Event = require('../src/modules/events/event.model');
    const Booking = require('../src/modules/events/eventbooking.model');
    const service = require('../src/modules/events/eventbooking.service');
    const filters = require('../src/modules/events/bookingFilters');
    const geography = require('../src/modules/regions/geography');
    const regions = require('../src/modules/regions/region.service');
    const emptyOptions = await filters.filterOptions([]);
    for (const state of geography.listStates()) {
        assert(emptyOptions.states.includes(state), `empty event list offers ${state}`);
        for (const district of geography.listDistricts(state)) {
            assert(emptyOptions.districts.some(row => row.state === state && row.name === district), `empty event list offers ${state}/${district}`);
        }
    }
    assert(emptyOptions.states.includes('State without districts'), 'state-only admin region is selectable');
    assert(emptyOptions.districts.some(row => row.state === 'Community State' && row.name === 'Community District'), 'district without block admins is selectable');
    const nationwideOptions = await filters.filterOptions([{ title: 'National programme', targets: [], state: '', district: '' }]);
    assert.deepEqual(nationwideOptions.states, emptyOptions.states, 'untargeted events do not erase location choices');
    assert.deepEqual(nationwideOptions.districts, emptyOptions.districts);
    const retainedRegions = [
        { state: ' tamil nadu ', district: ' chennai ', targets: [{ state: 'Tamil Nadu', district: 'Chennai' }] },
        { bookingHistoryOnly: true, state: 'Retired Region', district: 'Historic District',
            targets: [{ state: 'Retired Region', district: 'Historic District' }, { state: 'Another Retired Region', district: 'Historic District' }] },
    ];
    const retainedBefore = JSON.stringify(retainedRegions);
    const mergedOptions = await filters.filterOptions(retainedRegions);
    assert.equal(mergedOptions.states.filter(state => state.toLowerCase() === 'tamil nadu').length, 1);
    assert.equal(mergedOptions.districts.filter(row => row.state === 'Tamil Nadu' && row.name === 'Chennai').length, 1, 'directory spelling wins and duplicate targets are merged');
    assert(mergedOptions.states.includes('Retired Region'), 'historical regions remain selectable');
    assert.deepEqual(mergedOptions.districts.filter(row => row.name === 'Historic District'), [
        { state: 'Another Retired Region', name: 'Historic District' },
        { state: 'Retired Region', name: 'Historic District' },
    ], 'district identity includes its parent state');
    assert.equal(JSON.stringify(retainedRegions), retainedBefore, 'building choices never changes saved region values');
    assert(!JSON.stringify(mergedOptions).includes('@example.test'), 'filter options expose names only');
    const originalTree = regions.getLocationTree;
    try {
        regions.getLocationTree = async () => { throw new Error('Region directory unavailable'); };
        await assert.rejects(filters.filterOptions([]), /Region directory unavailable/, 'directory failures are not disguised as empty options');
    } finally {
        regions.getLocationTree = originalTree;
    }
    const tomorrow = new Date(Date.now() + 86400000 * 2);
    const before = new Date(Date.now() - 86400000 * 2);
    const makeEvent = extra => Event.create({ title: 'Workshop', startAt: tomorrow, endAt: tomorrow,
        status: 'published', category: 'Training', language: 'Tamil, English', mode: 'offline',
        state: 'Tamil Nadu', district: 'Chennai', capacity: 20, ...extra });
    const current = await makeEvent({});
    const past = await makeEvent({ title: 'Completed', startAt: before, endAt: before });
    const deleted = await makeEvent({ title: 'Removed', archivedAt: new Date(), mode: 'online' });
    const multi = await makeEvent({ title: 'Multi region', state: 'Karnataka', district: 'Bengaluru',
        targets: [{ state: 'Tamil Nadu', district: 'Coimbatore' }, { state: 'Karnataka', district: 'Bengaluru' }] });
    const missingId = new mongoose.Types.ObjectId();
    let serial = 0;
    const book = (eventId, extra = {}) => Booking.create({ eventId, bookingRef: 'FILTER-' + (++serial), eventTitle: 'Saved title',
        bookedBy: { name: 'Test Person', email: 'person@example.test', phone: '9000000000' },
        participants: [{ name: 'Colleague', email: 'colleague@example.test', phone: '9000000001' }],
        status: 'active', payment: { status: 'not_required' }, noOfPersons: 1,
        responses: [{ key: 'city-1', label: 'City', value: 'Chennai' }, { key: 'state-1', label: 'State', value: 'Tamil Nadu' },
            { key: 'business-1', label: 'Business activity', value: 'Food processing' }], ...extra });
    await book(current._id, { createdAt: new Date('2026-10-11T18:30:00Z') });
    await book(current._id, { bookedBy: { name: 'Second', email: 'second@example.test' }, responses: [{ key: 'city-1', label: 'City', value: 'Madurai' }], createdAt: new Date('2026-10-11T18:29:59Z') });
    await book(past._id); await book(deleted._id); await book(missingId); await book(multi._id);
    const unchanged = JSON.stringify(await Booking.collection.find({}).sort({ _id: 1 }).toArray());
    for (const history of ['current', 'past', 'deleted']) {
        const result = await service.bookingOverview({ history });
        assert(result.events.every(row => row.historyCategory === history));
        assert.equal(result.events.length, history === 'past' ? 1 : 2);
    }
    const criteria = { history: 'current', language: 'Tamil', state: 'Tamil Nadu', district: 'Chennai', mode: 'offline', category: 'Training',
        city: 'chennai', attendeeState: 'Tamil Nadu', responseKey: 'business-1', responseValue: 'food', bookedFrom: '2026-10-12', bookedTo: '2026-10-12' };
    const overview = await service.bookingOverview(criteria);
    assert.equal(overview.events.length, 1); assert.equal(overview.events[0].id, String(current._id));
    assert.equal(overview.events[0].remainingSeats, 18, 'contact filtering never changes actual seat availability');
    assert.deepEqual(overview.filterOptions.cities, ['Chennai', 'Madurai']);
    assert(overview.filterOptions.languages.includes('Tamil'));
    const people = await service.listBookingPeople(criteria);
    assert.equal(people.people.length, 1); assert.equal(people.people[0].bookings, 1);
    const person = await service.getBookingPerson('person@example.test', criteria);
    assert.equal(person.bookings.length, 1, 'person drill-down keeps the selected history/filters');
    const page = await service.listBookings(String(current._id), criteria);
    assert.equal(page.pagination.total, 1); assert.equal(page.bookings.length, 1);
    const report = await service.exportFilteredBookings(criteria);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(report.buffer);
    const headerRow = require('../src/core/utils/spreadsheet').HEADER_ROW;
    const sheet = workbook.getWorksheet('Bookings');
    assert.equal(sheet.rowCount, headerRow + 1);
    assert(sheet.getRow(headerRow).values.includes('Registration: City'));
    assert(sheet.getRow(headerRow + 1).values.includes('Chennai'));
    assert(sheet.getRow(headerRow + 1).values.includes('Current'));
    assert.equal((await service.bookingOverview({ history: 'current', state: 'Tamil Nadu', district: 'Bengaluru' })).events.length, 0, 'state/district must match the same target');
    assert.equal((await service.bookingOverview({ history: 'current', state: 'Karnataka', district: 'Bengaluru' })).events.length, 1);
    assert.equal((await service.listBookings(String(current._id), { search: 'colleague@example.test' })).bookings.length, 2, 'participant search uses saved participant data');
    for (const bad of [{ history: 'all' }, { eventFrom: '2026-02-30' }, { eventFrom: '2026-10-12', eventTo: '2026-10-11' }, { state: { $ne: '' } }, { responseValue: 'x' }]) {
        assert.throws(() => filters.normalizeFilters(bad));
    }
    assert.equal(JSON.stringify(await Booking.collection.find({}).sort({ _id: 1 }).toArray()), unchanged, 'filters and reports preserve every booking byte for byte');
    assert.equal(await Event.collection.countDocuments({ _id: missingId }), 0, 'deleted event is never recreated');
    console.log('PASS booking filters: complete national/custom/historic region choices, deduplication, directory failures, strict history, region pairs, language, dates/IST, saved answers, search, pagination, matching Excel, unchanged retained records.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); await mongo?.stop(); });
