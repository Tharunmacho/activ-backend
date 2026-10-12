// All event surfaces use the same finishing boundary. Stored timestamps are
// instants; an event without a finishing time lasts through its last IST day.
const DAY_MS = 86400000;
const IST_MS = 19800000;
const instant = value => {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
};
const eventEndsAt = (event = {}) => {
    const end = instant(event.endAt);
    if (end !== null) return end;
    const dates = [instant(event.startAt), ...(event.days || []).map(day => instant(day.date))]
        .filter(value => value !== null);
    if (!dates.length) return null;
    const last = Math.max(...dates);
    return Math.floor((last + IST_MS) / DAY_MS) * DAY_MS + DAY_MS - IST_MS;
};
const isPastEvent = (event = {}, now = Date.now()) => {
    const end = eventEndsAt(event);
    return end !== null && end <= Number(now);
};
const isUpcomingEvent = (event = {}, now = Date.now()) => !event.archivedAt && !isPastEvent(event, now);
const eventPhase = (event = {}, now = Date.now()) => {
    if (isPastEvent(event, now)) return 'past';
    const start = instant(event.startAt);
    return start !== null && start <= Number(now) ? 'live' : 'upcoming';
};

// Mongo equivalent of eventEndsAt, applied before limit so historical records
// cannot crowd a forthcoming event out of a public response.
const endingExpression = {
    $ifNull: ['$endAt', {
        $let: {
            vars: { last: { $max: ['$startAt', { $max: '$days.date' }] } },
            in: { $cond: [
                { $ne: ['$$last', null] },
                { $add: ['$$last', { $subtract: [DAY_MS, { $mod: [{ $add: [{ $toLong: '$$last' }, IST_MS] }, DAY_MS] }] }] },
                null,
            ] },
        },
    }],
};
const eventPeriodClause = (period, now = new Date()) => ({
    $expr: period === 'past'
        ? { $and: [{ $ne: [endingExpression, null] }, { $lte: [endingExpression, now] }] }
        : { $or: [{ $eq: [endingExpression, null] }, { $gt: [endingExpression, now] }] },
});

module.exports = { eventEndsAt, isPastEvent, isUpcomingEvent, eventPhase, eventPeriodClause };
