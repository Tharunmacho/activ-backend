const { isPastEvent } = require('./eventLifecycle');

const timestamp = value => value == null || value === '' ? NaN : new Date(value).getTime();
const reminderOffsets = (event = {}) => {
    const own = Array.isArray(event.reminderOffsetsHours) ? event.reminderOffsetsHours : [];
    const fallback = process.env.EVENT_REMINDER_DEFAULT_HOURS === undefined ? '24' : String(process.env.EVENT_REMINDER_DEFAULT_HOURS);
    return [...new Set((own.length ? own : fallback.split(',')).map(Number)
        .filter(hours => Number.isFinite(hours) && hours > 0 && hours <= 168))];
};

// A reminder is an invitation to a future start, even when a multi-day event
// has not finished yet. Keep its original window so a retry cannot turn an old
// reminder into a new invitation after the organiser changes the schedule.
function reminderReason(event, data = {}, bookedAt, now = Date.now()) {
    if (!event || event.archivedAt || event.bookingHistoryOnly || event.status !== 'published') {
        return 'The reminder event is no longer published or available.';
    }
    const start = timestamp(event.startAt);
    if (!Number.isFinite(start)) return 'The reminder event has no verified start time.';
    if (start <= now || isPastEvent(event, now)) return 'The event has already started or finished; its reminder is obsolete.';
    const originalStart = timestamp(data.reminderEventStartAt);
    const hours = Number(data.reminderHours);
    if (!Number.isFinite(originalStart) || !Number.isFinite(hours) || hours <= 0 || hours > 168) {
        return 'The original event reminder window could not be verified.';
    }
    if (originalStart !== start) return 'The event schedule changed after this reminder was created.';
    const moment = start - hours * 3600000;
    if (!reminderOffsets(event).includes(hours) || moment > now) return 'This event reminder window is no longer due.';
    if (!(timestamp(bookedAt) < moment)) return 'This booking was not confirmed before the reminder window.';
    return '';
}

module.exports = { reminderOffsets, reminderReason };
