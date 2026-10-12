// Isolated fixtures only: no database connection or outbound notification.
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const Member = require('../src/modules/members/memberdetails.model');
const Booking = require('../src/modules/events/eventbooking.model');
const service = require('../src/modules/events/eventbooking.service');
const actor = { role: 'super_admin', userId: 'admin-fixture' };
const eventId = new mongoose.Types.ObjectId().toString();
const ref = 'ACTIVB-DELETE-TEST';
const row = { eventId, bookingRef: ref, status: 'active', deletedAt: null,
    noOfPersons: 3, payment: { status: 'paid', paidAt: new Date(), mode: 'cash' } };
const notices = [];
const hooks = (model, name, query) => new Promise((resolve, reject) =>
    model.hooks.execPre(name, query, [], err => err ? reject(err) : resolve()));

async function main() {
    for (const model of [Member, Booking]) {
        for (const name of ['find', 'findOne', 'findOneAndUpdate', 'countDocuments']) {
            const query = name === 'findOneAndUpdate' ? model[name]({}, { $set: {} }) : model[name]({});
            await hooks(model, name, query);
            assert.equal(query.getFilter().deletedAt, null, `${model.modelName}.${name} excludes deleted rows`);
        }
        const aggregate = model.aggregate([{ $match: { status: 'active' } }]);
        await hooks(model, 'aggregate', aggregate);
        assert.deepEqual(aggregate.pipeline()[0], { $match: { deletedAt: null } });
    }
    const before = structuredClone(row);
    Booking.findOneAndUpdate = Booking.updateOne = Booking.deleteOne = () => { throw Error('Booking deletion must not write'); };
    service.announce = (...args) => notices.push(args);
    await assert.rejects(service.deleteBooking(eventId, ref, { role: 'events_admin' }), e => e.statusCode === 403);
    await assert.rejects(service.deleteBooking('bad-id', ref, actor), e => e.statusCode === 400);
    for (const id of [new mongoose.Types.ObjectId().toString(), eventId, eventId]) {
        await assert.rejects(service.deleteBooking(id, ref, actor), e => e.statusCode === 409 && /retained/.test(e.message));
    }
    assert.deepEqual(row, before, 'booking, payment and contact records remain unchanged');
    assert.equal(notices.length, 0, 'a rejected delete sends no notice');
    console.log('PASS: old booking delete requests are blocked, records unchanged, no notifications, query protections retained.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
