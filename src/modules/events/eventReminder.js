const { isPastEvent } = require('./eventLifecycle');

const timestamp = value => value == null || value === '' ? NaN : new Date(value).getTime();
// Two days and one day before the start, unless the organiser chose their own.
const DEFAULT_REMINDER_HOURS = '48,24';
const reminderOffsets = (event = {}) => {
    const own = Array.isArray(event.reminderOffsetsHours) ? event.reminderOffsetsHours : [];
    const fallback = process.env.EVENT_REMINDER_DEFAULT_HOURS === undefined ? DEFAULT_REMINDER_HOURS : String(process.env.EVENT_REMINDER_DEFAULT_HOURS);
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

/**
 * Each offset owns a window: from its moment until the next-closer reminder's
 * moment (or the start, for the closest one). An event published 30 hours out
 * has already missed its "2 days before" window; sending it now would be a
 * late 48h reminder immediately followed by the 24h one. A missed window is
 * skipped, never sent late.
 */
function windowClosed(start, hours, offsets, now = Date.now()) {
    const closer = (offsets || []).filter(h => h < hours);
    const end = closer.length ? start - Math.max(...closer) * 3600000 : start;
    // A short grace covers a restart or a retry; beyond it the moment was missed.
    const grace = Math.max(0, Number(process.env.EVENT_REMINDER_GRACE_HOURS ?? 12)) * 3600000;
    return now >= end || now > start - hours * 3600000 + grace;
}

module.exports = { reminderOffsets, reminderReason, windowClosed, DEFAULT_REMINDER_HOURS };
