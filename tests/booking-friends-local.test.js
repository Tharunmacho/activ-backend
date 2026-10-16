// Real booking/member-price/attendee rules on disposable loopback Mongo only.
const assert = require('node:assert/strict');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'isolated-booking-test-key', PUSH_ENABLED: 'false' });
let mongo;
(async () => {
  mongo = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
  assert.match(mongo.getUri(), /^mongodb:\/\/127\.0\.0\.1:/);
  process.env.MONGODB_URI = mongo.getUri(); await mongoose.connect(mongo.getUri());
  const Event = require('../src/modules/events/event.model');
  const Booking = require('../src/modules/events/eventbooking.model');
  const service = require('../src/modules/events/eventbooking.service');
  const { Lock } = require('../src/modules/events/bookingLock');
  // Delivery itself is covered elsewhere. Never invoke an external provider.
  const announced = [];
  service.announce = async booking => { announced.push(booking.bookingRef); };
  service.announceParticipantChanges = async () => {};
  const context = { id: String(new mongoose.Types.ObjectId()), role: 'member', isPaid: true, fullName: 'Member Booker', email: 'member@example.test', phoneNumber: '9123456789', state: 'Tamil Nadu' };
  const makeEvent = async (overrides = {}) => {
    const event = { _id: new mongoose.Types.ObjectId(), title: 'Isolated booking fixture', slug: `fixture-${new mongoose.Types.ObjectId()}`, status: 'published', audience: 'all', reachEveryone: true, targets: [],
      registrationEnabled: true, capacity: 20, registrationFee: 1000, memberFee: 600, startAt: new Date(Date.now() + 86400000), endAt: new Date(Date.now() + 90000000), registrationFields: [], ...overrides };
    await Event.collection.insertOne(event); return String(event._id);
  };
  const person = (email, name = 'Friend') => ({ name, email, phone: '9123456789' });
  const payload = (attendees, overrides = {}) => ({ name: context.fullName, email: context.email, phone: context.phoneNumber, noOfPersons: attendees.length, participants: attendees, amount: 1, ...overrides });
  const event = await makeEvent();
  await assert.rejects(service.createBooking(event, { ...payload([{ name: '', email: '', phone: '' }]), useBookerForFirstParticipant: false }, context), error => error.statusCode === 400 && !!error.fields['participants.0.name']);
  await assert.rejects(service.createBooking(event, { ...payload([person('unused@example.test')]), useBookerForFirstParticipant: 'false' }, context), error => error.statusCode === 400);
  assert.equal(await Booking.countDocuments({ eventId: event }), 0, 'Explicit friend booking never falls back to the booker');
  const own = await service.createBooking(event, payload([person(context.email, context.fullName)]), context);
  const friendA = await service.createBooking(event, { ...payload([person('friend-a@example.test')]), useBookerForFirstParticipant: false }, context);
  const friendB = await service.createBooking(event, payload([person('friend-b@example.test')]), context);
  assert.notEqual(own.bookingRef, friendA.bookingRef); assert.notEqual(friendA.bookingRef, friendB.bookingRef);
  assert.equal(friendA.unitAmount, 600); assert.equal(friendA.totalAmount, 600); assert.equal(friendA.memberRateApplied, true);
  assert.equal(await Booking.countDocuments({ eventId: event }), 3);
  const retry = await service.createBooking(event, payload([person('friend-b@example.test')]), context);
  assert.equal(retry.bookingRef, friendB.bookingRef); assert.equal(retry.duplicate, true);
  await assert.rejects(service.createBooking(event, payload([person('FRIEND-A@EXAMPLE.TEST', 'Changed name')]), context), error => error.statusCode === 409 && !!error.fields['participants.0.email']);
  await assert.rejects(service.createBooking(event, payload([person('new@example.test'), person('NEW@example.test')]), context), error => error.statusCode === 409);
  const unpaid = { ...context, id: String(new mongoose.Types.ObjectId()), isPaid: false };
  const regular = await service.createBooking(event, payload([person('regular@example.test')]), unpaid);
  assert.equal(regular.unitAmount, 1000); assert.equal(regular.memberRateApplied, false);
  console.log('PASS repeated member bookings for different friends, canonical email uniqueness, shared contact phone and server member pricing');

  const duplicateEvent = await makeEvent();
  const concurrent = await Promise.allSettled([
    service.createBooking(duplicateEvent, payload([person('same@example.test')]), context),
    service.createBooking(duplicateEvent, payload([person('SAME@example.test')], { email: 'another-booker@example.test' }), { ...context, id: String(new mongoose.Types.ObjectId()) }),
  ]);
  assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(row => row.status === 'rejected').reason.statusCode, 409);
  assert.equal(await Booking.countDocuments({ eventId: duplicateEvent }), 1);
  const capacityEvent = await makeEvent({ capacity: 1 });
  const capacity = await Promise.all([
    service.createBooking(capacityEvent, payload([person('one@example.test')]), context),
    service.createBooking(capacityEvent, payload([person('two@example.test')]), context),
  ]);
  assert.equal(capacity.filter(row => row.status === 'active').length, 1);
  assert.equal(capacity.filter(row => row.status === 'waitlist').length, 1);
  assert.equal(capacity.find(row => row.status === 'waitlist').payment.status, 'not_required');
  assert.equal(await service.countSeats(capacityEvent), 1);
  const expired = await Booking.findOne({ bookingRef: friendA.bookingRef });
  expired.expiresAt = new Date(Date.now() - 1000); await expired.save();
  const reclaimed = await service.createBooking(event, payload([person('friend-a@example.test')]), context);
  assert.notEqual(reclaimed.bookingRef, friendA.bookingRef);
  assert.equal((await Booking.findOne({ bookingRef: friendA.bookingRef })).status, 'expired');
  console.log('PASS cross-request attendee lock, simultaneous capacity allocation, pending hold uniqueness and expired hold recovery');

  const { admissibility } = require('../src/modules/events/eventcheckin.service');
  const paid = ref => service.completePayment(ref, { gatewayPaymentId: `verified-${ref}`, signature: 'instamojo_webhook_verified', mode: 'online' });
  const conflictSettlement = await paid(friendA.bookingRef);
  assert.equal(conflictSettlement.payment.status, 'paid');
  assert.equal(conflictSettlement.totalAmount, 600);
  assert.equal(conflictSettlement.status, 'waitlist');
  assert.equal(conflictSettlement.payment.reconciliationRequired, true);
  assert.match(conflictSettlement.payment.reconciliationReason, /email/);
  const conflictReceipt = await service.getBooking(friendA.bookingRef);
  assert.equal(conflictReceipt.payment.reconciliationRequired, true);
  assert.deepEqual(conflictReceipt.passes, []);
  assert.equal(conflictReceipt.onlineUrl, '');
  assert.equal(admissibility(await Booking.findOne({ bookingRef: friendA.bookingRef }).lean()).ok, false);
  assert.equal(announced.includes(friendA.bookingRef), false, 'Do not send a false booking confirmation');
  assert.equal((await Booking.findOne({ bookingRef: reclaimed.bookingRef })).status, 'active');
  await assert.rejects(paid(friendA.bookingRef), /already paid/);
  const reviewStored = await Booking.findOne({ bookingRef: friendA.bookingRef });
  assert.equal(reviewStored.payment.gatewayPaymentId, `verified-${friendA.bookingRef}`);
  assert.ok(reviewStored.payment.paidAt);

  const lateCapacityEvent = await makeEvent({ capacity: 1 });
  const lateCapacity = await service.createBooking(lateCapacityEvent, payload([person('late-capacity@example.test')]), context);
  await Booking.updateOne({ bookingRef: lateCapacity.bookingRef }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const capacityWinner = await service.createBooking(lateCapacityEvent, payload([person('capacity-winner@example.test')]), context);
  const capacitySettlement = await paid(lateCapacity.bookingRef);
  assert.equal(capacitySettlement.status, 'waitlist');
  assert.equal(capacitySettlement.payment.status, 'paid');
  assert.match(capacitySettlement.payment.reconciliationReason, /seats/);
  assert.equal(await service.countSeats(lateCapacityEvent), 1);
  assert.equal((await paid(capacityWinner.bookingRef)).status, 'active');

  const offlineEvent = await makeEvent();
  const offline = await service.createBooking(offlineEvent, payload([person('offline-conflict@example.test')]), context);
  await Booking.updateOne({ bookingRef: offline.bookingRef }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await service.createBooking(offlineEvent, payload([person('offline-conflict@example.test')]), context);
  await assert.rejects(service.recordOfflinePayment(offline.bookingRef, { mode: 'cash', recordedBy: 'fixture-admin' }), error => error.statusCode === 409);
  assert.equal((await Booking.findOne({ bookingRef: offline.bookingRef })).payment.status, 'failed');
  assert.equal(announced.includes(offline.bookingRef), false);

  const recoverEvent = await makeEvent({ capacity: 1 });
  const recover = await service.createBooking(recoverEvent, payload([person('safe-late@example.test')]), context);
  await Booking.updateOne({ bookingRef: recover.bookingRef }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await service.sweepExpiredHolds(recoverEvent);
  const recoveredPayment = await paid(recover.bookingRef);
  assert.equal(recoveredPayment.status, 'active');
  assert.equal(recoveredPayment.payment.reconciliationRequired, false);
  assert.equal(await service.countSeats(recoverEvent), 1);
  assert.equal(announced.filter(ref => ref === recover.bookingRef).length, 1);

  const settlementRaceEvent = await makeEvent({ capacity: 1 });
  const raceHold = await service.createBooking(settlementRaceEvent, payload([person('settlement-race@example.test')]), context);
  await Booking.updateOne({ bookingRef: raceHold.bookingRef }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await Promise.allSettled([
    paid(raceHold.bookingRef),
    service.createBooking(settlementRaceEvent, payload([person('settlement-race@example.test')], { email: 'other-booker@example.test' }), { ...context, id: String(new mongoose.Types.ObjectId()) }),
  ]);
  assert.equal(await Booking.countDocuments({ eventId: settlementRaceEvent, status: 'active' }), 1);
  assert.equal(await service.countSeats(settlementRaceEvent), 1);
  console.log('PASS late verified payments preserve money without duplicate seats/passes, capacity holds, offline conflicts, safe recovery and concurrent settlement/create');

  const editEvent = await makeEvent({ registrationFee: 0, memberFee: 0 });
  const first = await service.createBooking(editEvent, payload([person('edit-a@example.test')]), context);
  const second = await service.createBooking(editEvent, payload([person('edit-b@example.test')]), context);
  await assert.rejects(service.updateParticipants(first.bookingRef, { participants: [{ name: '', email: '', phone: '' }] }, context), error => error.statusCode === 400 && !!error.fields['participants.0.name']);
  const unchanged = await service.updateParticipants(first.bookingRef, { participants: [person('edit-a@example.test')] }, context);
  assert.equal(unchanged.participants[0].email, 'edit-a@example.test');
  const renamed = await service.updateParticipants(first.bookingRef, { participants: [person('edit-a@example.test', 'Corrected Friend Name')] }, context);
  assert.equal(renamed.participants[0].name, 'Corrected Friend Name');
  await assert.rejects(service.updateParticipants(first.bookingRef, { participants: [person('EDIT-B@example.test')] }, context), error => error.statusCode === 409);
  await assert.rejects(service.updateParticipants(first.bookingRef, { participants: [person('replacement@example.test')] }, unpaid), error => error.statusCode === 403);
  const edited = await service.updateParticipants(first.bookingRef, { participants: [person('replacement@example.test')] }, context);
  assert.equal(edited.participants[0].email, 'replacement@example.test');
  const race = await Promise.allSettled([
    service.updateParticipants(first.bookingRef, { participants: [person('race-edit@example.test')] }, context),
    service.updateParticipants(second.bookingRef, { participants: [person('RACE-EDIT@example.test')] }, context),
  ]);
  assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(race.find(row => row.status === 'rejected').reason.statusCode, 409);
  assert.equal(await Lock.countDocuments(), 0);
  console.log('PASS attendee edits retain own seat, reject another booked email, preserve ownership and serialize concurrent replacement');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
