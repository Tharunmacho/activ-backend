/** Nomination delivery and retry, with in-memory persistence and no providers/DB. */
const assert = require('assert/strict');
const Booking = require('../src/modules/events/eventbooking.model');
const Event = require('../src/modules/events/event.model');
const service = require('../src/modules/events/eventbooking.service');
const notifications = require('../src/modules/notifications/notification.service');
const pass = require('../src/modules/events/eventPass');

const clone = value => structuredClone(value);
const booker = { name: 'Booking Owner', email: 'owner@example.test', phone: '9567812345' };
const priya = { name: 'Priya', email: 'priya@example.test', phone: '9123456789' };
const ravi = { name: 'Ravi', email: 'ravi@example.test', phone: '9234567890' };
const anu = { name: 'Anu', email: 'anu@example.test', phone: '9345678901' };
let booking, sent, jobs, writes, online = false, failWrite = false, failEnqueue = false;
const old = { find: Booking.findOne, update: Booking.findOneAndUpdate, event: Event.findById,
    dispatch: notifications.dispatchLifecycleEvent, enqueue: notifications.dispatchInBackground, announce: service.announceParticipantChanges,
    lookup: service.bookingForLogRow };

function reset(participants = [priya, ravi], overrides = {}) {
    booking = { _id: '0123456789abcdef01234567', bookingRef: 'ACTIVB-TEST-1234', eventId: '1123456789abcdef01234567',
        userId: 'owner-id', manageToken: 'private-manage-token', bookedBy: booker, participants: clone(participants),
        noOfPersons: participants.length, status: 'active', eventStartAt: new Date(Date.now() + 86400000),
        totalAmount: 12345, unitAmount: 6172.5, payment: { status: 'paid', mode: 'online', gatewayPaymentId: 'private-payment-id' },
        ...overrides };
    sent = []; jobs = []; writes = 0; online = false; failWrite = false; failEnqueue = false;
}
async function edit(participants, context = { id: 'owner-id' }) {
    const result = await service.updateParticipants(booking.bookingRef, { participants }, context);
    await Promise.all(jobs);
    return result;
}
const confirmations = () => sent.filter(row => row.event === 'EVENT_PARTICIPANT_CONFIRMED');
const cancellations = () => sent.filter(row => row.event === 'EVENT_PARTICIPANT_CANCELLED');
function assertPrivate(row) {
    for (const key of ['amountLabel', 'paymentId', 'paymentModeLabel', 'paymentLabel', 'viewUrl', 'manageToken']) {
        assert.equal(row.payload[key], '', key);
    }
    assert.deepEqual(row.payload.passes, []);
    assert.equal(row.payload.seats, 1);
    assert.equal(row.target.id, '');
    assert.equal(JSON.stringify(row.payload).includes('private-payment-id'), false);
    assert.equal(JSON.stringify(row.payload).includes('private-manage-token'), false);
    assert.equal(JSON.stringify(row.payload).includes(booker.email), false);
}

async function main() {
    Booking.findOne = () => {
        const snapshot = clone(booking);
        return { select: async () => snapshot, lean: async () => snapshot };
    };
    Booking.findOneAndUpdate = async (filter, update, options) => {
        assert.equal(options.runValidators, true);
        if (failWrite) throw Error('Simulated persistence failure');
        if (JSON.stringify(filter.participants) !== JSON.stringify(booking.participants)
            || filter.status !== booking.status || filter['payment.status'] !== booking.payment.status) return null;
        writes++;
        booking.participants = clone(update.$set.participants);
        return clone(booking);
    };
    Event.findById = () => ({ lean: async () => ({ title: 'Future programme', startAt: booking.eventStartAt,
        mode: online ? 'online' : 'offline', onlineUrl: 'https://zoom.us/meeting/register/fixture', venue: 'Chennai' }) });
    notifications.dispatchLifecycleEvent = async (event, target, payload) => {
        sent.push(clone({ event, target, payload, mode: 'retry' }));
        return { channels: { email: { success: true }, whatsapp: { success: true } }, rows: {} };
    };
    notifications.dispatchInBackground = async (event, target, payload) => {
        sent.push(clone({ event, target, payload, mode: 'queued' }));
        if (failEnqueue) throw Error('Simulated enqueue failure');
        return { queued: true, outboxId: `intent-${sent.length}` };
    };
    service.announceParticipantChanges = function (...args) {
        const job = old.announce.apply(this, args); jobs.push(job); return job;
    };
    service.bookingForLogRow = async () => clone(booking);

    reset();
    const result = await edit([priya, anu]);
    assert.equal(result.participants[1].name, 'Anu');
    assert.equal(writes, 1);
    assert.equal(sent.length, 2);
    assert(sent.every(row => row.mode === 'queued'), 'Nomination edits enqueue without calling message providers');
    assert.equal(cancellations()[0].target.email, ravi.email);
    assert.equal(cancellations()[0].payload.participantRemoved, true);
    assert.equal(cancellations()[0].payload.ticketUrl, '');
    assert.equal(confirmations()[0].target.email, anu.email);
    assert.equal(pass.verifyPass(pass.extractToken(confirmations()[0].payload.ticketUrl)).index, 1);
    assert.equal(confirmations()[0].payload.registrationNo, 'ACTIVB-TEST-1234-P2');
    sent.forEach(assertPrivate);
    const removal = clone(cancellations()[0]);
    const confirmation = clone(confirmations()[0]);
    assert.equal(removal.payload.data.nominationChange.id, confirmation.payload.data.nominationChange.id);
    const removalRow = { _id: 'failed-removal', event: removal.event, channel: 'email', recipient: ravi.email,
        data: { lifecycleData: removal.payload.data } };

    const queuedReason = row => service.reasonToSkipQueuedNotification(row.event, row.target, row.payload);
    assert.equal(await queuedReason(removal), '', 'Removed nominee still eligible before delivery');
    assert.equal(await queuedReason(confirmation), '', 'Current nominee/pass still eligible before delivery');
    assert.match(await queuedReason({ ...confirmation, target: { ...confirmation.target, email: ravi.email } }), /nominee changed/i);
    assert.match(await queuedReason({ ...confirmation, payload: { ...confirmation.payload,
        ticketUrl: pass.passUrl(pass.signPass(booking._id, 0)) } }), /pass does not belong/i);
    assert.match(await queuedReason({ ...confirmation, payload: { ...confirmation.payload,
        data: { ...confirmation.payload.data, eventId: 'another-event' } } }), /event no longer matches/i);
    booking.participants = [clone(anu), clone(priya)];
    assert.match(await queuedReason(confirmation), /nominee changed/i, 'Queued old seat is obsolete after reorder');
    booking.participants = [clone(priya), { ...anu, name: 'Anu Kumar' }];
    assert.match(await queuedReason(confirmation), /nominee changed/i, 'Queued old identity is obsolete after correction');
    booking.participants = [clone(priya), clone(anu)];
    booking.status = 'cancelled';
    assert.match(await queuedReason(confirmation), /booking status/i);
    assert.equal(await queuedReason(removal), '', 'An already removed nominee still receives cancellation when the entire booking later cancels');
    booking.status = 'active';
    booking.payment.status = 'pending';
    assert.match(await queuedReason(confirmation), /booking status/i);
    booking.payment.status = 'paid';
    const bookerPayload = await service.messageContext(booking, 'confirmed');
    assert.equal(await service.reasonToSkipQueuedNotification('EVENT_BOOKING_CONFIRMED', { id: 'owner-id', ...booker }, bookerPayload), '');
    assert.match(await service.reasonToSkipQueuedNotification('EVENT_BOOKING_CONFIRMED', { ...booker, email: anu.email }, bookerPayload), /booking contact/i);
    assert.match(await service.reasonToSkipQueuedNotification('EVENT_BOOKING_CONFIRMED', booker, { ...bookerPayload, participantNames: ['Old name'] }), /attendee list changed/i);
    const regularParticipant = { ...confirmation, payload: { ...confirmation.payload, data: { bookingRef: booking.bookingRef } } };
    assert.equal(await queuedReason(regularParticipant), '', 'Original participant confirmation without edit metadata stays valid');
    booking.participants = [clone(anu), clone(priya)];
    assert.match(await queuedReason(regularParticipant), /another seat/i, 'Ordinary queued pass must match the current seat too');
    booking.participants = [clone(priya), clone(anu)];
    const findBeforeFailure = Booking.findOne;
    Booking.findOne = () => ({ lean: async () => { throw Error('Temporary database outage'); } });
    await assert.rejects(queuedReason(confirmation), /Temporary database outage/, 'Outbox can retry a failed state read');
    assert.equal(await service.reasonToSkipQueuedNotification('MEMBERSHIP_ACTIVATED', {}, {}), '', 'Unrelated notices use their own validator');
    assert.equal(await service.reasonToSkipQueuedNotification('EVENT_BOOKING_WAITLISTED', {}, { data: { registrationId: 'legacy-seat' } }), '');
    Booking.findOne = findBeforeFailure;

    const templates = require('../src/modules/notifications/notificationTemplates');
    const removalTemplate = templates.render(removal.event, removal.payload);
    assert.match(removalTemplate.email.bodyHtml, /nomination/i);
    assert.doesNotMatch(removalTemplate.email.bodyHtml, /cancelled by the organiser/i);
    assert.doesNotMatch(removalTemplate.email.bodyHtml + removalTemplate.email.preheader, /rest of the booking remains active/i);
    assert.equal(removalTemplate.inApp, undefined);
    assert.equal(removalTemplate.whatsapp.params.length, 5);

    sent = [];
    await edit([priya, { ...anu, email: ' ANU@EXAMPLE.TEST ', phone: '+91 93456 78901' }]);
    assert.equal(sent.length, 0, 'A repeated/normalization-only save sends nothing');
    assert.equal(writes, 1);

    const retry = await service.resendLoggedMessage(removalRow);
    assert.equal(retry.outcome.success, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.email, ravi.email);
    assert.equal(sent[0].payload.onlyChannel, 'email');
    assert.equal(sent[0].payload.participantRemoved, true);
    assert.equal(sent[0].payload.ticketUrl, '');
    assertPrivate(sent[0]);
    booking.participants[1] = clone(ravi);
    assert.match(await queuedReason(removal), /current attendee list/i, 'Queued removal is obsolete after nominee returns');
    assert.equal((await service.resendLoggedMessage(removalRow)).skipped, true, 'Do not cancel a re-added nominee');
    assert.equal((await service.resendLoggedMessage({ ...removalRow, recipient: anu.email })).skipped, true, 'Never retarget a removal');
    assert.equal((await service.resendLoggedMessage({ ...removalRow, data: {} })).skipped, true, 'Ordinary cancellation still requires cancelled booking');

    reset();
    await edit([ravi, priya]);
    assert.equal(cancellations().length, 0, 'Moving seats is not removal');
    assert.equal(confirmations().length, 2);
    assert.deepEqual(confirmations().map(row => [row.target.email, pass.verifyPass(pass.extractToken(row.payload.ticketUrl)).index]),
        [[ravi.email, 0], [priya.email, 1]]);

    reset();
    await edit([priya, { ...ravi, name: 'Ravi Kumar' }]);
    assert.equal(sent.length, 1, 'Name correction refreshes only that nominee');
    assert.equal(confirmations()[0].target.name, 'Ravi Kumar');

    reset();
    await edit([priya, { ...ravi, email: anu.email }]);
    assert.equal(cancellations().length, 1);
    assert.equal(cancellations()[0].target.email, ravi.email);
    assert.equal(cancellations()[0].target.phone, '', 'Do not cancel on the retained phone');
    assert.equal(confirmations()[0].target.phone, ravi.phone);

    reset();
    await edit([priya, { ...ravi, phone: anu.phone }]);
    assert.equal(cancellations()[0].target.email, '', 'Do not cancel on the retained email');
    assert.equal(cancellations()[0].target.phone, ravi.phone);

    reset([priya]);
    await edit([anu]);
    assert.equal(confirmations()[0].payload.registrationNo, 'ACTIVB-TEST-1234-P1');
    assert.equal(pass.verifyPass(pass.extractToken(confirmations()[0].payload.ticketUrl)).index, 0);

    reset([booker, ravi]);
    await edit([booker, anu]);
    assert.equal(sent.some(row => row.target.email === booker.email), false, 'Unchanged booker receives no duplicate receipt/pass');
    assert.equal(sent.some(row => /^EVENT_BOOKING_/.test(row.event)), false);

    reset();
    await service.updateParticipants(booking.bookingRef, { participants: [priya, anu], manageToken: 'private-manage-token' });
    await Promise.all(jobs);
    assert.equal(confirmations().length, 1, 'Guest manage-link authorization still works');

    reset(); online = true;
    await edit([priya, anu]);
    assert.equal(confirmations()[0].payload.ticketUrl, '');
    assert.equal(confirmations()[0].payload.registerUrl, 'https://zoom.us/meeting/register/fixture');
    assert.equal(cancellations()[0].payload.registerUrl, '');

    for (const overrides of [{ status: 'waitlist' }, { payment: { status: 'pending' } }, { payment: { status: 'failed' } }]) {
        reset([priya, ravi], overrides);
        await edit([priya, anu]);
        assert.equal(writes, 1);
        assert.equal(sent.length, 0, 'Unconfirmed bookings have no pass to announce');
    }
    reset([priya, ravi], { totalAmount: 0, payment: { status: 'not_required' } });
    await edit([priya, anu]);
    assert.equal(confirmations().length, 1, 'Free confirmed seats are announced');

    for (const overrides of [{ status: 'cancelled' }, { status: 'expired' }, { eventStartAt: new Date(Date.now() - 1000) }]) {
        reset([priya, ravi], overrides);
        await assert.rejects(edit([priya, anu]));
        assert.equal(writes, 0); assert.equal(sent.length, 0);
    }
    reset();
    await assert.rejects(edit([priya, anu], { id: 'someone-else' }));
    await assert.rejects(edit([priya, priya]));
    assert.equal(writes, 0); assert.equal(sent.length, 0);

    reset(); failWrite = true;
    await assert.rejects(edit([priya, anu]), /persistence failure/);
    assert.equal(sent.length, 0);
    reset(); failEnqueue = true;
    await edit([priya, anu]);
    assert.equal(writes, 1, 'Enqueue failure cannot roll back a saved nomination');
    assert.equal(sent.length, 2, 'One failed enqueue does not prevent the next recipient intent');

    reset();
    const concurrent = await Promise.allSettled([
        service.updateParticipants(booking.bookingRef, { participants: [priya, anu] }, { id: 'owner-id' }),
        service.updateParticipants(booking.bookingRef, { participants: [priya, anu] }, { id: 'owner-id' })
    ]);
    await Promise.all(jobs);
    assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(writes, 1); assert.equal(confirmations().length, 1); assert.equal(cancellations().length, 1);
    const firstIntent = clone(confirmations()[0]);
    await edit([priya, ravi]);
    sent = [];
    await edit([priya, anu]);
    const nextIntent = confirmations()[0];
    const { keyFor } = require('../src/modules/notifications/lifecycleOutbox');
    assert.notEqual(keyFor(firstIntent.event, firstIntent.target, firstIntent.payload),
        keyFor(nextIntent.event, nextIntent.target, nextIntent.payload), 'A later re-nomination gets a new outbox intent');

    reset();
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const entered = [deferred(), deferred()];
    const persisted = [deferred(), deferred()];
    const enqueue = notifications.dispatchInBackground;
    let intentIndex = 0;
    notifications.dispatchInBackground = async (...args) => {
        const index = intentIndex++;
        entered[index].resolve();
        await persisted[index].promise;
        return enqueue(...args);
    };
    let returned = false;
    const pendingEdit = service.updateParticipants(booking.bookingRef, { participants: [priya, anu] }, { id: 'owner-id' })
        .then(value => { returned = true; return value; });
    await entered[0].promise;
    assert.equal(writes, 1);
    assert.equal(returned, false, 'Response waits for removal intent persistence');
    persisted[0].resolve();
    await entered[1].promise;
    assert.equal(returned, false, 'Response also waits for replacement confirmation intent persistence');
    assert.equal(sent.length, 1);
    persisted[1].resolve();
    await pendingEdit;
    assert.equal(returned, true);
    assert.equal(sent.length, 2);
    assert(sent.every(row => row.mode === 'queued'), 'Waiting for persistence never invokes providers');
    notifications.dispatchInBackground = enqueue;
    console.log('Participant changes: recipient/channel deltas, own passes, privacy, state guards, safe retries, concurrent edits and awaited enqueue-only persistence passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Booking.findOne = old.find; Booking.findOneAndUpdate = old.update; Event.findById = old.event;
    notifications.dispatchLifecycleEvent = old.dispatch; notifications.dispatchInBackground = old.enqueue;
    service.announceParticipantChanges = old.announce;
    service.bookingForLogRow = old.lookup;
});
