// Offline confirmation fan-out: model/provider methods are replaced before use.
const assert = require('node:assert/strict');
Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_WORKER_ENABLED: 'false', EVENT_REMINDERS_ENABLED: 'false',
    JWT_SECRET: 'isolated-confirmation-test-key', FRONTEND_URL: 'https://activ.example.test' });
const Booking = require('../src/modules/events/eventbooking.model');
const Event = require('../src/modules/events/event.model');
const service = require('../src/modules/events/eventbooking.service');
const notifications = require('../src/modules/notifications/notification.service');
const outbox = require('../src/modules/notifications/lifecycleOutbox');
const templates = require('../src/modules/notifications/notificationTemplates');
const pass = require('../src/modules/events/eventPass');
const chain = value => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => value });
const event = { _id: '222222222222222222222222', title: 'Local event', slug: 'local-event', mode: 'offline',
    startAt: new Date(Date.now() + 86400000), venue: 'Test hall' };
const booker = { name: 'Booker', email: 'booker@example.test', phone: '9123456789' };
const makeBooking = (participants, overrides = {}) => ({ _id: '111111111111111111111111', eventId: event._id,
    bookingRef: 'ACTIVB-FIXTURE-0001', status: 'active', payment: { status: 'not_required' }, totalAmount: 0,
    noOfPersons: participants.length, bookedBy: { ...booker }, participants, confirmationPending: true,
    confirmationSentAt: null, createdAt: new Date(), ...overrides });
let booking;
let failRecipient = '';
let failCheckpoint = false;
let jobs = new Map();
const attempts = [];
Event.findById = () => chain(event);
Booking.find = query => {
    assert.equal(query.confirmationPending, true, 'historical bookings without the durable flag are excluded');
    return chain(booking.confirmationPending && !booking.confirmationSentAt ? [booking] : []);
};
Booking.findOne = () => chain(booking);
Booking.updateOne = async (query, update) => {
    if (failCheckpoint) throw new Error('simulated checkpoint interruption');
    if (booking.confirmationSentAt) return { matchedCount: 0, modifiedCount: 0 };
    assert.equal(query.confirmationSentAt, null);
    Object.assign(booking, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
};
notifications.dispatchLifecycleEvent = async () => { throw new Error('Primary providers must never run in the booking request'); };
notifications.dispatchInBackground = async (name, recipient, payload) => {
    attempts.push(recipient.email || recipient.phone);
    if (failRecipient && recipient.email === failRecipient) return { queued: false, error: 'simulated enqueue failure' };
    const key = outbox.keyFor(name, recipient, payload);
    if (!jobs.has(key)) jobs.set(key, { name, recipient, payload });
    return { queued: true, outboxId: key };
};
const reset = participants => { booking = makeBooking(participants); jobs = new Map(); attempts.length = 0; failRecipient = ''; failCheckpoint = false; };
const friend = (name, email, phone) => ({ name, email, phone });

async function main() {
    reset([booker, friend('Shared phone friend', 'friend@example.test', '+91 9123456789'), friend('Other friend', 'other@example.test', '9987654321')]);
    assert.equal((await service.announce(booking)).queued, true);
    assert.equal(jobs.size, 3);
    const rows = [...jobs.values()];
    const shared = rows.find(row => row.recipient.email === 'friend@example.test');
    assert(shared, 'shared phone never suppresses the separate email');
    assert.equal(shared.recipient.phone, '', 'same number receives the booker confirmation once');
    assert.equal(shared.payload.seats, 1);
    assert.deepEqual(shared.payload.participantNames, ['Shared phone friend']);
    assert.deepEqual(shared.payload.passes, []);
    assert.equal(shared.payload.amountLabel, '');
    assert.equal(shared.payload.viewUrl, '');
    assert.equal(shared.payload.manageUrl, '');
    assert.equal(shared.payload.registrationNo, 'ACTIVB-FIXTURE-0001-P2');
    assert.deepEqual(pass.verifyPass(pass.extractToken(shared.payload.ticketUrl)), { bookingId: booking._id, index: 1 });
    assert.equal(templates.render(shared.name, shared.payload).email.ticketQr, shared.payload.ticketUrl);
    assert.equal(templates.render(rows[0].name, rows[0].payload).email.passQrs.length, 3, 'booker keeps every seat QR');
    // Render through the real email delivery path, replacing only the SMTP
    // boundary and contact/log reads. No network or database is contacted.
    let smtp;
    require('../src/modules/notifications/regionalContacts.service').resolveForRegion = async () => null;
    require('../src/modules/notifications/email.service').sendEmail = async options => {
        smtp = options; return { success: true, messageId: 'fixture-smtp-accepted', provider: 'smtp' };
    };
    notifications.log = async row => row;
    const delivered = await notifications._deliverLifecycleEvent(shared.name, shared.recipient, shared.payload);
    assert.equal(delivered.channels.email.success, true);
    assert.equal(smtp.to, 'friend@example.test');
    const png = smtp.inlineImages.find(image => image.cid === 'ticket-qr');
    assert(png && Buffer.isBuffer(png.content));
    assert.equal(png.content.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert(smtp.html.includes('cid:ticket-qr'));
    assert(!smtp.html.includes('Other friend'));
    assert.equal(delivered.rows.email.deliveryStatus, 'accepted', 'SMTP acceptance is recorded without claiming inbox delivery');
    assert.equal(booking.confirmationPending, false);
    assert(booking.confirmationSentAt);
    console.log('PASS shared contact delivery and isolated signed participant QR');

    reset([friend('Separate phone', booker.email, '9987654321')]);
    await service.announce(booking);
    const phoneOnly = [...jobs.values()].find(row => row.name === 'EVENT_PARTICIPANT_CONFIRMED');
    assert.equal(phoneOnly.recipient.email, ''); assert.equal(phoneOnly.recipient.phone, '9987654321');
    assert.equal(phoneOnly.payload.registrationNo, 'ACTIVB-FIXTURE-0001-P1');

    reset([friend('One', 'one@example.test', '9987654321'), friend('Two', 'two@example.test', '9876543210')]);
    failRecipient = 'one@example.test';
    assert.equal((await service.announce(booking)).queued, false);
    assert.equal(jobs.size, 2, 'one failed enqueue does not stop other recipients');
    assert.equal(booking.confirmationPending, true); assert.equal(booking.confirmationSentAt, null);
    const oldKeys = [...jobs.keys()];
    failRecipient = ''; event.title = 'Updated event title';
    assert.equal(await service.queuePendingConfirmations(), 1);
    assert.equal(jobs.size, 3, 'recovery fills only missing recipient even after event content changes');
    oldKeys.forEach(key => assert(jobs.has(key)));
    assert(booking.confirmationSentAt); assert.equal(booking.confirmationPending, false);
    assert.equal(await service.queuePendingConfirmations(), 0);
    console.log('PASS partial enqueue recovery without duplicate confirmations');

    reset([friend('One', 'one@example.test', '9987654321')]);
    failCheckpoint = true;
    assert.equal((await service.announce(booking)).queued, false);
    assert.equal(jobs.size, 2); assert.equal(booking.confirmationPending, true);
    failCheckpoint = false;
    // A fresh module instance models a process restart; persisted booking/jobs survive.
    delete require.cache[require.resolve('../src/modules/events/eventbooking.service')];
    const restarted = require('../src/modules/events/eventbooking.service');
    await restarted.queuePendingConfirmations();
    assert.equal(jobs.size, 2); assert(booking.confirmationSentAt);

    reset([friend('One', 'one@example.test', '9987654321')]);
    const snapshot = { ...booking };
    await Promise.all([service.announce(snapshot), service.announce(snapshot)]);
    assert.equal(jobs.size, 2, 'concurrent callbacks retain one job per recipient');
    assert(booking.confirmationSentAt);
    console.log('PASS restart after checkpoint failure and concurrent confirmation idempotence');

    reset([friend('Old name', 'nominee@example.test', '9987654321')]);
    failCheckpoint = true;
    await service.announce(booking);
    failCheckpoint = false;
    const previous = booking.participants;
    booking.participants = [friend('Corrected name', 'nominee@example.test', '9987654321')];
    await service.announceParticipantChanges(booking, previous);
    const revised = [...jobs.values()].filter(row => row.payload.participantNames.includes('Corrected name'));
    assert.equal(revised.length, 2, 'recovery gives both booker and corrected nominee a current payload');
    assert.equal(revised.filter(row => row.name === 'EVENT_PARTICIPANT_CONFIRMED').length, 1);
    assert(revised.every(row => !row.payload.data.nominationChange), 'no additional nomination confirmation while initial fanout is pending');
    for (const row of revised) assert.equal(await service.reasonToSkipQueuedNotification(row.name, row.recipient, row.payload), '');
    const obsolete = [...jobs.values()].find(row => row.name === 'EVENT_BOOKING_CONFIRMED' && row.payload.participantNames.includes('Old name'));
    assert.match(await service.reasonToSkipQueuedNotification(obsolete.name, obsolete.recipient, obsolete.payload), /attendee list changed/);
    event.archivedAt = new Date();
    assert.match(await service.reasonToSkipQueuedNotification(revised[0].name, revised[0].recipient, revised[0].payload), /no longer published/);
    delete event.archivedAt;
    const future = event.startAt; event.startAt = new Date(Date.now() - 86400000);
    assert.match(await service.reasonToSkipQueuedNotification(revised[0].name, revised[0].recipient, revised[0].payload), /event has ended/i);
    event.startAt = future;
    console.log('PASS nomination edit during recovery and archived/ended event guards');

    reset([friend('Online guest', 'online@example.test', '9987654321')]);
    event.mode = 'online'; event.onlineUrl = 'https://zoom.example.test/j/123';
    await service.announce(booking);
    const online = [...jobs.values()].find(row => row.name === 'EVENT_PARTICIPANT_CONFIRMED');
    assert.equal(online.payload.registerUrl, event.onlineUrl);
    assert.equal(online.payload.ticketUrl, ''); assert.deepEqual(online.payload.passes, []);
    assert(templates.render(online.name, online.payload).email.actionButton.url.includes('/j/123'));
    for (const status of ['pending', 'failed']) {
        reset([booker]); booking.payment.status = status;
        await service.announce(booking); assert.equal(jobs.size, 0, 'unsettled payments do not issue entry passes');
    }
    console.log('PASS online joining links and unpaid booking safeguards');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
