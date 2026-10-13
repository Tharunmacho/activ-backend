process.env.NODE_ENV = 'test';
process.env.EVENT_PASS_SECRET = 'isolated-event-form-test-secret';
const assert = require('assert/strict');
const { buildResponses } = require('../src/modules/events/eventRegistrationFields');
const Event = require('../src/modules/events/event.model');
const EventBooking = require('../src/modules/events/eventbooking.model');
const service = require('../src/modules/events/eventbooking.service');
const pass = require('../src/modules/events/eventPass');

const fields = [
    { key: 'meal', label: 'Meal preference', type: 'select', required: true, options: ['Vegetarian', 'Other'] },
    { key: 'terms', label: 'Consent', type: 'checkbox', required: true },
    { key: 'arrival', label: 'Arrival date', type: 'date', required: true },
    { key: 'quantity', label: 'Quantity', type: 'number' },
    { key: 'mail', label: 'Contact email', type: 'email' }
];
const answers = { meal: 'vegetarian', terms: true, arrival: '2026-10-23', quantity: '0', mail: 'delegate@example.test', injected: 'ignore' };
const row = {
    _id: 'abcdef123456abcdef123456', eventId: '123456abcdef123456abcdef', bookingRef: 'ACTIVB-FORM-TEST',
    noOfPersons: 2, status: 'active', bookedBy: { name: 'Booker', email: 'booker@example.test', phone: '9000000001' },
    participants: [{ name: 'Booker' }, { name: 'Delegate' }], payment: { status: 'paid' }, totalAmount: 1200,
    responses: buildResponses(fields, answers)
};
const event = {
    _id: row.eventId, id: row.eventId, title: 'Conference', status: 'published', registrationEnabled: true,
    registrationFee: 1000, memberFee: 600, startAt: new Date(Date.now() + 86400000),
    registrationFields: fields, mode: 'offline', onlineUrl: 'https://example.test/private-meeting',
    whatsappChannelUrl: 'https://chat.whatsapp.com/example', attachments: [{ name: 'Agenda', url: '/uploads/agenda.pdf' }],
    contactEmail: 'events@example.test'
};
const query = value => ({ select() { return this; }, lean: async () => value });
let stored = null;
let announcements = 0;

(async () => {
    assert.deepEqual(row.responses.map(answer => answer.key), fields.map(field => field.key));
    assert.equal(row.responses[0].value, 'Vegetarian');
    assert.equal(row.responses[3].value, '0');
    for (const [key, value] of [['meal', 'Injected option'], ['terms', false], ['arrival', '2026-02-30'], ['quantity', 'NaN'], ['mail', 'invalid']]) {
        assert.throws(() => buildResponses(fields, { ...answers, [key]: value }), error => !!error.fields[`responses.${key}`]);
    }
    assert.throws(() => buildResponses(fields, {}), error => error.statusCode === 400 && !!error.fields['responses.meal']);
    service.resolveEvent = async () => event;
    service.seatsFor = async () => ({ capacity: 100, seatsTaken: 0, seatsLeft: 100 });
    service.assertNotAlreadyBooked = async () => {};
    service.announce = () => { announcements += 1; };
    EventBooking.findOne = () => query(null);
    EventBooking.create = async value => { stored = { ...value, _id: row._id }; return stored; };
    const bookable = await service.getBookableEvent(event.id, { isPaid: true });
    assert.deepEqual(bookable.registrationFields, fields);
    assert.equal(bookable.participantDetailsRequired, true);
    const person = index => ({ name: 'Delegate ' + index, email: 'delegate' + index + '@example.test', phone: '91736524' + String(index).padStart(2, '0') });
    const body = { name: 'Booker', email: 'booker@example.test', phone: '9000000001', noOfPersons: 2, participants: [{}, person(1)], responses: answers, amount: 1, totalAmount: 1 };
    const created = await service.createBooking(event.id, body, { id: 'member', isPaid: true });
    assert.equal(created.payment.status, 'pending');
    assert.equal(created.unitAmount, bookable.amount);
    assert.equal(created.totalAmount, bookable.amount * 2);
    assert.deepEqual(stored.responses, row.responses);
    assert.equal(announcements, 0, 'pending is not announced as confirmed');
    assert.deepEqual(stored.participants[0], { name: body.name, email: body.email, phone: body.phone }, 'first participant uses booking contact');
    for (const participants of [[], [body], [body, { name: 'Missing contacts' }], [body, { ...person(1), phone: '' }]]) {
        stored = null;
        await assert.rejects(service.createBooking(event.id, { ...body, noOfPersons: 10, participants }), error => error.statusCode === 400 && Object.keys(error.fields).some(key => key.startsWith('participants.')));
        assert.equal(stored, null, 'incomplete attendees cannot create a booking or payment');
    }
    await service.createBooking(event.id, { ...body, noOfPersons: 10, participants: [{}, ...Array.from({ length: 9 }, (_, index) => person(index + 1))] });
    assert.equal(stored.participants.length, 10);
    assert(stored.participants.every(person => person.name && person.email && person.phone), 'all ten exported participants have full contact details');
    stored = null;
    await assert.rejects(service.createBooking(event.id, { ...body, participants: [body, body] }), error => error.statusCode === 409 && !!error.fields['participants.1.email']);
    assert.equal(stored, null, 'duplicate contacts cannot create placeholder seats');
    stored = null;
    await assert.rejects(service.createBooking(event.id, { ...body, responses: {} }, { id: 'member', isPaid: true }), error => error.statusCode === 400);
    assert.equal(stored, null, 'invalid required answers do not write a booking');
    EventBooking.findOne = () => query(row);
    Event.findById = () => query(event);
    const confirmed = await service.getBooking(row.bookingRef);
    assert.equal(confirmed.passes.length, 2);
    confirmed.passes.forEach((entry, index) => assert.deepEqual(pass.verifyPass(pass.extractToken(entry.url)), { bookingId: row._id, index }));
    assert.equal(confirmed.whatsappChannelUrl, event.whatsappChannelUrl);
    assert.equal(confirmed.attachments.length, 1);
    assert.deepEqual(confirmed.responses, row.responses);
    assert.equal(confirmed.manageToken, undefined);
    for (const [status, payment] of [['active', 'pending'], ['active', 'failed'], ['cancelled', 'paid'], ['waitlist', 'not_required'], ['expired', 'pending']]) {
        row.status = status; row.payment.status = payment; row.payment.amountPaid = 100; // partial/unknown payment must not grant admission
        const pending = await service.getBooking(row.bookingRef);
        assert.equal(pending.passes.length, 0, `${status}/${payment} must have no passes`);
        assert.equal(pending.onlineUrl, ''); assert.equal(pending.whatsappChannelUrl, ''); assert.deepEqual(pending.attachments, []);
    }
    row.status = 'expired'; row.payment.status = 'paid';
    assert.equal((await service.getBooking(row.bookingRef)).passes.length, 2, 'late confirmed payment keeps its paid seats');
    event.archivedAt = new Date();
    const archived = await service.getBooking(row.bookingRef);
    assert.equal(archived.eventArchived, true); assert.equal(archived.passes.length, 0); assert.deepEqual(archived.responses, row.responses);
    event.archivedAt = null; event.mode = 'online'; row.status = 'active';
    const online = await service.getBooking(row.bookingRef);
    assert.equal(online.passes.length, 0); assert.equal(online.onlineUrl, event.onlineUrl);
    console.log('PASS: declared registration fields, persistence, server pricing, signed per-seat passes, pending/partial/failed/cancelled/archive access. No network or database.');
    process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
