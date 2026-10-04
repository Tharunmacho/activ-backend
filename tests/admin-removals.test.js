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
    const matches = f => f.eventId === row.eventId && f.bookingRef === row.bookingRef && row.deletedAt == null;
    Booking.findOne = f => ({ lean: async () => matches(f) ? structuredClone(row) : null });
    Booking.findOneAndUpdate = async (f, update) => {
        if (!matches(f)) return null;
        Object.assign(row, update.$set);
        return structuredClone(row);
    };
    service.announce = (...args) => notices.push(args);
    await assert.rejects(service.deleteBooking(eventId, ref, { role: 'events_admin' }), e => e.statusCode === 403);
    await assert.rejects(service.deleteBooking('bad-id', ref, actor), e => e.statusCode === 400);
    await assert.rejects(service.deleteBooking(new mongoose.Types.ObjectId().toString(), ref, actor), e => e.statusCode === 404);
    assert.equal(row.status, 'active', 'a different event cannot delete this booking');
    const result = await service.deleteBooking(eventId, ref, actor);
    assert.equal(result.deleted, true);
    assert.equal(row.status, 'cancelled');
    assert.equal(row.expiresAt, null);
    assert.equal(row.deletedBy, actor.userId);
    assert.equal(row.payment.status, 'paid', 'receipt is retained and not falsely refunded');
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'cancelled');
    await assert.rejects(service.deleteBooking(eventId, ref, actor), e => e.statusCode === 404);
    assert.equal(notices.length, 1, 'repeat delete does not send another notice');
    console.log('Admin deletion: Super Admin permission, event ownership, retained receipts, seat release, notices and archived-query protections passed.');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
