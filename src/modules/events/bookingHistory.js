const Event = require('./event.model');
const EventBooking = require('./eventbooking.model');

/** Admin booking history only. Never recreates an event or changes a booking. */
async function deletedEventBookingHeaders() {
    const rows = await EventBooking.collection.aggregate([
        { $match: { eventId: { $type: 'objectId' }, deletedAt: null } },
        { $sort: { createdAt: 1, _id: 1 } },
        { $group: {
            _id: '$eventId', title: { $last: '$eventTitle' },
            startAt: { $last: '$eventStartAt' }, venue: { $last: '$eventVenue' },
        } },
        { $lookup: { from: Event.collection.name, localField: '_id', foreignField: '_id', as: 'event' } },
        { $match: { event: { $eq: [] } } },
        { $project: { event: 0 } },
    ]).toArray();
    return rows.map(row => ({
        ...row, title: row.title || 'Deleted event',
        status: 'deleted', bookingHistoryOnly: true, registrationEnabled: false,
    }));
}

module.exports = { deletedEventBookingHeaders };
