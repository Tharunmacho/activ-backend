const mongoose = require('mongoose');
const ApiError = require('../../core/utils/ApiError');
const layout = require('../../config/dataLayout');

const collection = name => {
    const [area, table] = layout.MODELS[name];
    return layout.nativeDb(area).collection(table);
};
function authorize(id, body, actor) {
    if (actor?.role !== 'super_admin') throw ApiError.forbidden('Only the Super Admin can permanently delete archived records.');
    if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) throw ApiError.badRequest('A valid record ID is required.');
    if (body?.confirmation !== 'DELETE' || body?.recordId !== id) {
        throw ApiError.badRequest('Confirm permanent deletion with this exact record ID and confirmation DELETE.');
    }
    return new mongoose.Types.ObjectId(id);
}
const ids = value => [...new Set([String(value || '')].filter(Boolean))]
    .flatMap(id => mongoose.isValidObjectId(id) ? [id, new mongoose.Types.ObjectId(id)] : [id]);
const safeAudit = async entry => require('../audit/audit.service').record(entry);

/** Exact-reference deletes only; never look up related records by recycled email/phone. */
function createService({ collections = collection, audit = safeAudit, now = () => new Date() } = {}) {
    const drop = async (name, filter, removed) => {
        removed[name] = (await collections(name).deleteMany(filter)).deletedCount;
    };
    const record = (action, category, id, actor, removed) => audit({
        action, category, targetId: id, targetLabel: 'Archived record',
        summary: category === 'event' ? 'Archived event and its booking history permanently deleted' : 'Archived membership payment permanently deleted',
        actorId: String(actor.userId || actor.id || actor._id || ''), actorRole: actor.role,
        actorEmail: actor.email || '', actorName: actor.fullName || actor.name || '',
        metadata: { permanent: true, removed },
    });
    return {
        async deleteMembershipPayment(id, body, actor) {
            const _id = authorize(id, body, actor);
            const orders = collections('PaymentOrder');
            const order = await orders.findOne({ _id });
            if (!order) throw ApiError.notFound('Archived payment not found. Refresh the payment list.');
            if (order.orderType !== 'membership') throw ApiError.conflict('Only an archived membership payment can be deleted here.');
            if (!order.memberId) throw ApiError.conflict('This payment has no verifiable member reference.');
            const owner = { $in: ids(order.memberId) };
            // Legacy orders can point to the login ID stored as MemberDetails.userId.
            if (await collections('MemberDetails').findOne({ $or: [{ _id: owner }, { userId: owner }] }, { projection: { _id: 1 } })) {
                throw ApiError.conflict('This payment belongs to an existing account and is not an archived payment.');
            }
            if (order.settlementStartedAt && new Date(order.settlementStartedAt).getTime() > now().getTime() - 5 * 60000) {
                throw ApiError.conflict('This payment is being processed. Refresh and try again after processing finishes.');
            }
            const expiry = new Date(order.expiresAt).getTime();
            if (order.status === 'created' && (!Number.isFinite(expiry) || expiry > now().getTime())) {
                throw ApiError.conflict('This payment still has an open checkout. Wait for it to finish or expire before deleting it.');
            }
            const outboxFilter = order.orderId ? { $or: [{ 'payload.orderId': String(order.orderId) }, { 'payload.data.orderId': String(order.orderId) }] } : null;
            if (outboxFilter && await collections('LifecycleOutbox').findOne({ $and: [outboxFilter,
                { status: 'processing', leaseUntil: { $gt: now() } }] }, { projection: { _id: 1 } })) {
                throw ApiError.conflict('A payment notification is still processing. Refresh and retry when it finishes.');
            }
            // CAS closes the settlement window: gateway settlement can claim only
            // status=created. A concurrent claim changes settlementStartedAt and
            // makes this write fail before any dependent record is removed.
            const claimedStatus = order.status === 'created' ? 'cancelled' : order.status;
            const claimed = await orders.updateOne({ _id, orderType: 'membership', memberId: order.memberId,
                status: order.status, settlementStartedAt: order.settlementStartedAt || null,
            }, { $set: { status: claimedStatus, archiveDeletionStartedAt: now() } });
            if (claimed.matchedCount !== 1) throw ApiError.conflict('The payment changed or processing started. Refresh before deleting it.');
            const removed = {};
            if (order.orderId) {
                const reference = String(order.orderId);
                await drop('LifecycleOutbox', outboxFilter, removed);
                await drop('Notification', { 'data.orderId': reference }, removed);
                await drop('NotificationLog', { $or: [{ 'data.orderId': reference }, { 'data.lifecycleData.orderId': reference }] }, removed);
            }
            // Keep the root until its dependencies are removed so a failed cascade is retryable.
            if (await collections('MemberDetails').findOne({ $or: [{ _id: owner }, { userId: owner }] }, { projection: { _id: 1 } })) {
                throw ApiError.conflict('This payment is now linked to an existing account and cannot be deleted.');
            }
            removed.PaymentOrder = (await orders.deleteOne({ _id, orderType: 'membership', memberId: order.memberId,
                status: claimedStatus, settlementStartedAt: order.settlementStartedAt || null })).deletedCount;
            if (removed.PaymentOrder !== 1) throw ApiError.conflict('The payment changed. Refresh before deleting it.');
            await record('membership.archived_payment_deleted', 'admin', id, actor, removed);
            return { id, deleted: true, removed };
        },
        async deleteEventHistory(id, body, actor) {
            const _id = authorize(id, body, actor);
            const event = await collections('Event').findOne({ _id });
            if (event && !event.archivedAt) {
                throw ApiError.conflict('Archive the event before permanently deleting its booking history. Current and unarchived events are protected.');
            }
            const eventIds = { $in: ids(id) };
            const eventFilter = { eventId: eventIds };
            const bookings = await collections('EventBooking').find(eventFilter, { projection: { _id: 1, bookingRef: 1, expiresAt: 1, payment: 1 } }).toArray();
            const refs = bookings.map(row => row.bookingRef).filter(value => typeof value === 'string' && value);
            // Old orders sometimes lack eventId. A matching booking ref is then required;
            // an order explicitly attached to a different event is never touched.
            const orderFilter = { orderType: 'event_booking', $or: [eventFilter,
                ...(refs.length ? [{ eventId: { $in: [null, ''] }, bookingRef: { $in: refs } }] : []),
            ] };
            const orders = await collections('PaymentOrder').find(orderFilter, { projection: { _id: 1, orderId: 1, status: 1, expiresAt: 1, settlementStartedAt: 1 } }).toArray();
            if (!event && !bookings.length && !orders.length
                && !await collections('EventRegistration').findOne(eventFilter, { projection: { _id: 1 } })) {
                throw ApiError.notFound('Archived event history not found. Refresh the event list.');
            }
            const time = now().getTime();
            if (orders.some(order => (order.settlementStartedAt && new Date(order.settlementStartedAt).getTime() > time - 5 * 60000)
                || (order.status === 'created' && new Date(order.expiresAt).getTime() > time))
                || bookings.some(booking => booking.payment?.status === 'pending' && new Date(booking.expiresAt).getTime() > time)) {
                throw ApiError.conflict('This event still has an open checkout or payment being processed. Wait for it to finish before deleting its history.');
            }
            const orderIds = orders.map(row => row.orderId).filter(value => typeof value === 'string' && value);
            const notificationFilter = { $or: [
                eventFilter, { 'data.eventId': eventIds }, { 'data.lifecycleData.eventId': eventIds },
                ...(refs.length ? [{ bookingRef: { $in: refs } }, { 'data.bookingRef': { $in: refs } }, { 'data.lifecycleData.bookingRef': { $in: refs } }] : []),
                ...(orderIds.length ? [{ 'data.orderId': { $in: orderIds } }, { 'data.lifecycleData.orderId': { $in: orderIds } }] : []),
            ] };
            const outboxFilter = { $or: [
                { 'payload.eventId': eventIds }, { 'payload.data.eventId': eventIds },
                ...(refs.length ? [{ 'payload.data.bookingRef': { $in: refs } }] : []),
                ...(orderIds.length ? [{ 'payload.orderId': { $in: orderIds } }, { 'payload.data.orderId': { $in: orderIds } }] : []),
            ] };
            const broadcastFilter = { kind: 'event', sourceId: eventIds };
            for (const [name, filter] of [['LifecycleOutbox', outboxFilter], ['ContentBroadcast', broadcastFilter]]) {
                if (await collections(name).findOne({ $and: [filter, { status: 'processing', leaseUntil: { $gt: new Date(time) } }] }, { projection: { _id: 1 } })) {
                    throw ApiError.conflict('An event notification is still processing. Refresh and retry when it finishes.');
                }
            }
            const removed = {};
            // No transactions required: archived events cannot be edited/reopened by the
            // existing event APIs. Dependencies go first, bookings and event root last.
            // Any failed write leaves the source references available for a safe retry.
            await drop('LifecycleOutbox', outboxFilter, removed);
            await drop('ContentBroadcast', broadcastFilter, removed);
            await drop('Notification', notificationFilter, removed);
            await drop('NotificationLog', notificationFilter, removed);
            await drop('EventCheckin', eventFilter, removed);
            await drop('EventRegistration', eventFilter, removed);
            await drop('PaymentOrder', orderFilter, removed);
            await drop('EventBooking', eventFilter, removed);
            removed.Event = event ? (await collections('Event').deleteOne({ _id, archivedAt: event.archivedAt })).deletedCount : 0;
            if (event && removed.Event !== 1) throw ApiError.conflict('The archived event changed. Refresh before deleting it.');
            await record('event.archived_history_deleted', 'event', id, actor, removed);
            return { id, deleted: true, removed };
        },
    };
}
module.exports = createService();
module.exports.createService = createService;
module.exports.authorize = authorize;
