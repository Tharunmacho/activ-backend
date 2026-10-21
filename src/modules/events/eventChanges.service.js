const crypto = require('node:crypto');
const { isPastEvent } = require('./eventLifecycle');
const logger = require('../../config/logger');

const clean = value => String(value == null ? '' : value).trim();
const dateKey = value => {
    if (!value) return '';
    const stamp = new Date(value).getTime();
    return Number.isFinite(stamp) ? new Date(stamp).toISOString() : '';
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only changes that affect attending. Prices already agreed, artwork, spelling
// in descriptions, display order and admin-only fields do not trigger a broadcast.
const attendanceDetails = (event = {}) => ({
    schedule: [dateKey(event.startAt), dateKey(event.endAt), (event.days || []).map(day =>
        [dateKey(day.date), clean(day.startTime), clean(day.endTime)]).sort((a, b) => a[0].localeCompare(b[0]))],
    venue: [clean(event.venue || event.location), clean(event.venueAddress), clean(event.venueMapUrl)],
    format: [event.mode === 'online' ? 'online' : 'offline', clean(event.onlinePlatform)],
    joiningLink: clean(event.onlineUrl),
    video: clean(event.videoUrl),
    whatsapp: clean(event.whatsappChannelUrl),
    documents: (Array.isArray(event.attachments) ? event.attachments : []).filter(item => item?.url)
        .map(item => [clean(item.name), clean(item.url)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    attendeeNote: clean(event.registrationNote),
});

function describeChange(before, after, { now = Date.now() } = {}) {
    if (!before || !after || before.archivedAt || isPastEvent(before, now)) return null;
    if (after.archivedAt) {
        return {
            kind: 'event_cancelled', cancelledScope: 'event',
            reason: 'The organiser has withdrawn this event. It is no longer available for attendance. Contact the events team about your registration or payment.',
            changeSummary: 'Event withdrawn by the organiser',
        };
    }
    // Draft edits do not tell attendees that a new schedule is ready. Unpublishing
    // alone also does not mean an event was cancelled; only explicit archival does.
    if (before.status !== 'published' || after.status !== 'published' || isPastEvent(after, now)) return null;
    const oldDetails = attendanceDetails(before);
    const newDetails = attendanceDetails(after);
    const labels = { schedule: 'date or time', venue: 'venue or directions', format: 'attendance format',
        joiningLink: 'online registration or joining link', video: 'event video', whatsapp: 'WhatsApp updates link',
        documents: 'supporting documents', attendeeNote: 'attendee instructions' };
    const changes = Object.keys(labels).filter(key => JSON.stringify(oldDetails[key]) !== JSON.stringify(newDetails[key]));
    if (!changes.length) return null;
    return { kind: 'updated', changeSummary: `The organiser updated the ${changes.map(key => labels[key]).join(', ')}. Please check the latest details before attending.` };
}

const eventSnapshotKey = event => digest(attendanceDetails(event));
const eventChangeKey = (before, after, change) => {
    const revision = Math.max(0, new Date(after.updatedAt || after.archivedAt || 0).getTime() || 0);
    return `event:${revision}:${digest({
        eventId: String(after._id || after.id || ''), kind: change.kind, revision,
        before: attendanceDetails(before), after: attendanceDetails(after),
    })}`;
};
const registrationStateKey = row => digest({
    id: String(row._id), status: row.status, paymentStatus: row.payment?.status,
    registeredAt: dateKey(row.registeredAt), cancelledAt: dateKey(row.cancelledAt),
});
const registrationReminderKey = (startAt, hours) => {
    const start = new Date(startAt).getTime();
    const offset = Number(hours);
    return Number.isFinite(start) && Number.isFinite(offset) && offset > 0 && offset <= 168
        ? `${start}:${offset}` : '';
};
const currentReminderOffsets = event => {
    const own = Array.isArray(event.reminderOffsetsHours) ? event.reminderOffsetsHours : [];
    const fallback = process.env.EVENT_REMINDER_DEFAULT_HOURS === undefined ? '24' : String(process.env.EVENT_REMINDER_DEFAULT_HOURS);
    return (own.length ? own : fallback.split(',')).map(Number).filter(hours => Number.isFinite(hours) && hours > 0 && hours <= 168);
};

const currentBookings = eventId => ({
    eventId, deletedAt: null,
    $or: [
        { status: 'active', 'payment.status': { $in: ['paid', 'not_required'] } },
        { status: 'waitlist' },
    ],
});
const currentRegistrations = eventId => ({
    eventId,
    $or: [
        { status: 'registered', 'payment.status': { $in: ['paid', 'not_required'] } },
        { status: 'waitlist' },
    ],
});

/** The saved event is the source of truth; booking/payment history stays intact. */
async function notifyEventChange(before, after, options = {}) {
    const change = describeChange(before, after, options);
    if (!change) return { notified: 0, skipped: true };
    const Booking = require('./eventbooking.model');
    const Registration = require('./eventregistration.model');
    const bookingService = require('./eventbooking.service');
    const eventId = after._id || after.id;
    const changeId = eventChangeKey(before, after, change);
    let notified = 0;
    // A claim on the row makes repeated saves/parallel workers harmless. Reading
    // one row at a time avoids truncating larger events at an arbitrary list cap.
    for (const [Model, query, legacy] of [[Booking, currentBookings(eventId), false], [Registration, currentRegistrations(eventId), true]]) {
        while (true) {
            const row = await Model.findOneAndUpdate({ ...query, eventChangesSent: { $ne: changeId } },
                { $addToSet: { eventChangesSent: changeId } }, { new: true }).lean();
            if (!row) break;
            const extra = { ...change, changeId, changeSnapshotKey: eventSnapshotKey(after),
                eventSnapshot: after, bookingStatus: row.status };
            if (legacy) await announceRegistration(row, after, change.kind, { ...extra, claimed: true });
            else await bookingService.announce(row, change.kind, extra);
            notified += 1;
        }
    }
    return { notified, changeId };
}

// Call sites have already committed the user action. A failed send must never
// turn that committed save into an error, and every asynchronous failure is logged.
function announceChange(before, after) {
    return notifyEventChange(before, after).catch(error => {
        logger.warn('Event change announcement failed', { eventId: String(after?._id || ''), error: error && error.message });
        return { notified: 0, failed: true };
    });
}

function registrationContext(row, event, extra = {}) {
    const { describeSchedule, attendanceOf } = require('./eventbooking.service');
    const schedule = describeSchedule(event.startAt, event.endAt);
    const { isOnline, platform } = attendanceOf(event);
    const venue = isOnline ? (platform ? `Online (${platform})` : 'Online')
        : [clean(event.venue || event.location), clean(event.venueAddress)].filter(Boolean).join(', ');
    const paid = ['paid', 'not_required'].includes(row.payment?.status);
    const canAttend = row.status === 'registered' && paid && !extra.cancelledScope;
    const { documentUrl } = require('./eventDocument');
    const { appUrl } = require('../notifications/notificationTemplates');
    const eventUrl = appUrl(`/events/${encodeURIComponent(event.slug || String(event._id || row.eventId))}`);
    return {
        ...extra, eventTitle: event.title || 'ACTIV event', ...schedule,
        venue, venueLabel: venue, isOnline, onlinePlatform: platform,
        mapUrl: isOnline ? '' : clean(event.venueMapUrl),
        posterUrl: documentUrl(event.bannerUrl),
        videoUrl: canAttend ? clean(event.videoUrl) : '',
        whatsappChannelUrl: canAttend ? clean(event.whatsappChannelUrl) : '',
        attachments: canAttend && Array.isArray(event.attachments) ? event.attachments.filter(item => item?.url)
            .map(item => ({ name: clean(item.name) || 'Document', url: documentUrl(item.url), type: clean(item.type), size: Number(item.size) || 0 })) : [],
        attendeeNote: canAttend ? clean(event.registrationNote) : '',
        // A waitlist is not a ticket: it must never receive a paid joining URL.
        registerUrl: canAttend && isOnline ? clean(event.onlineUrl) : '',
        settledVia: row.payment?.status === 'not_required' ? 'free' : '',
        amountLabel: paid && Number(row.payment?.amount) > 0 ? `Rs ${Number(row.payment.amount).toLocaleString('en-IN')}` : '',
        paymentLabel: row.payment?.status === 'paid' ? 'Paid' : row.payment?.status === 'not_required' ? 'Not required' : 'Not paid',
        bookingRef: clean(row.payment?.reference) || String(row._id),
        bookingStatus: row.status === 'registered' && !paid ? 'pending' : row.status,
        seats: 1, seatsLabel: '1 seat', eventUrl, viewUrl: eventUrl,
        contactEmail: require('../notifications/eventContact').email,
        contactLine: require('../notifications/eventContact').email,
        data: { eventId: String(row.eventId), registrationId: String(row._id), changeId: extra.changeId || '',
            changeSnapshotKey: extra.changeSnapshotKey || eventSnapshotKey(event),
            changeScope: extra.changeScope || 'event', cancelledScope: extra.cancelledScope || '',
            bookingStatus: row.status === 'registered' && !paid ? 'pending' : row.status,
            registrationStateKey: registrationStateKey(row),
            ...(extra.reminderKey ? { reminderKey: extra.reminderKey, reminderHours: extra.reminderHours,
                reminderEventStartAt: extra.reminderEventStartAt } : {}) },
    };
}

/** Existing /events/:id/register clients get the same truthful lifecycle notices. */
async function announceRegistration(row, eventOrId, requestedKind, extra = {}) {
    if (!row) return { skipped: true };
    try {
        const suppliedEvent = eventOrId && typeof eventOrId === 'object'
            && ('title' in eventOrId || 'status' in eventOrId || 'startAt' in eventOrId);
        const event = suppliedEvent && requestedKind !== 'reminder' ? eventOrId
            : await require('./event.model').findById(eventOrId?._id || eventOrId || row.eventId).lean();
        if (!event || isPastEvent(event) || (event.archivedAt && requestedKind !== 'event_cancelled')) return { skipped: true };
        const paid = ['paid', 'not_required'].includes(row.payment?.status);
        const kind = requestedKind || (row.status === 'waitlist' ? 'waitlist'
            : row.status === 'registered' && paid ? 'confirmed' : '');
        if (!kind) return { skipped: true };
        if (['confirmed', 'reminder'].includes(kind) && (row.status !== 'registered' || !paid)) return { skipped: true };
        const eventName = { confirmed: 'EVENT_REGISTERED', reminder: 'EVENT_REMINDER', waitlist: 'EVENT_BOOKING_WAITLISTED', updated: 'EVENT_UPDATED',
            event_cancelled: 'EVENT_CANCELLED', cancelled: 'EVENT_CANCELLED' }[kind];
        if (!eventName) return { skipped: true };
        let changeId = extra.changeId;
        if (kind === 'reminder') {
            const start = new Date(event.startAt).getTime();
            const hours = Number(extra.reminderHours);
            const moment = start - hours * 60 * 60 * 1000;
            const key = registrationReminderKey(start, hours);
            if (!key || event.status !== 'published' || start <= Date.now() || moment > Date.now()
                || !currentReminderOffsets(event).includes(hours)
                || !(new Date(row.registeredAt).getTime() < moment)
                || (extra.reminderEventStartAt && dateKey(extra.reminderEventStartAt) !== dateKey(event.startAt))
                || (extra.reminderKey && extra.reminderKey !== key)) return { skipped: true };
            if ((row.remindersSent || []).includes(key)) return { skipped: true };
            extra = { ...extra, reminderKey: key, reminderHours: hours, reminderEventStartAt: dateKey(event.startAt) };
        } else if (!extra.claimed) {
            const key = digest([String(row._id), kind, dateKey(row.registeredAt),
                kind === 'cancelled' ? dateKey(row.cancelledAt) : kind === 'confirmed' ? dateKey(row.payment?.paidAt) : '']);
            const claim = await require('./eventregistration.model').updateOne({
                _id: row._id, status: row.status, 'payment.status': row.payment?.status, eventChangesSent: { $ne: key },
            }, { $addToSet: { eventChangesSent: key } });
            if (!claim || !claim.modifiedCount) return { skipped: true };
            changeId = key;
        }
        const context = registrationContext(row, event, { ...extra, changeId,
            ...(!extra.claimed ? { changeScope: 'registration' } : {}),
            ...(kind === 'cancelled' ? { cancelledScope: 'registration' } : {}) });
        if (kind === 'reminder') {
            // The outbox may run before the source checkpoint. Current
            // registration/window validation remains authoritative; the
            // checkpoint is a sweep optimization, never proof of delivery.
            context.data.reminderDurablyQueued = true;
            const reason = await reasonToSkipRegistrationNotice({ event: eventName, user: row.userId,
                channel: row.email ? 'email' : 'whatsapp', recipient: row.email || row.phone,
                data: { lifecycleData: context.data } });
            if (reason) return { skipped: true, reason };
            const result = await require('../notifications/notification.service').dispatchInBackground(eventName, {
                id: row.userId, name: row.memberName, email: row.email, phone: row.phone,
            }, context);
            if (!result?.queued) return { failed: true, error: result?.error || 'Reminder intent could not be saved.' };
            const checkpoint = await require('./eventregistration.model').updateOne({
                _id: row._id, status: 'registered', 'payment.status': { $in: ['paid', 'not_required'] },
                registeredAt: row.registeredAt, email: row.email, phone: row.phone,
                remindersSent: { $ne: extra.reminderKey },
            }, { $addToSet: { remindersSent: extra.reminderKey } });
            return { ...result, checkpointed: !!checkpoint.modifiedCount };
        }
        return require('../notifications/notification.service').dispatchLifecycleEvent(eventName, {
            id: row.userId, name: row.memberName, email: row.email, phone: row.phone,
        }, context);
    } catch (error) {
        logger.warn('Legacy event registration message failed', { registrationId: String(row._id), error: error && error.message });
        return { failed: true };
    }
}

const idOf = value => clean(value && (value._id || value));
const phoneKey = value => {
    const digits = clean(value).replace(/\D/g, '').replace(/^00/, '');
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
};
const recipientMatches = (row, person = {}) => row.channel === 'email'
    ? !!clean(person.email) && clean(person.email).toLowerCase() === clean(row.recipient).toLowerCase()
    : row.channel === 'whatsapp' && !!phoneKey(person.phone) && phoneKey(person.phone) === phoneKey(row.recipient);

/** Legacy receipts use their registration, never a modern booking lookup. */
async function reasonToSkipRegistrationNotice(row = {}) {
    if (!['EVENT_REGISTERED', 'EVENT_BOOKING_WAITLISTED', 'EVENT_REMINDER'].includes(row.event)) return '';
    const data = row.data?.lifecycleData || row.data || {};
    if (!data.registrationId) return 'The original event registration could not be verified.';
    try {
        const registration = await require('./eventregistration.model').findById(data.registrationId).lean();
        if (!registration || registration.deletedAt) return 'The event registration no longer exists.';
        const eventId = idOf(registration.eventId);
        if (!eventId || idOf(data.eventId) !== eventId || (row.eventId && idOf(row.eventId) !== eventId)) {
            return 'The message no longer matches the registered event.';
        }
        if (!recipientMatches(row, registration)) return 'The recipient is no longer on this registration.';
        const ownerId = idOf(registration.userId);
        if (!ownerId || (row.user && idOf(row.user) !== ownerId)) return 'The message no longer matches the member account.';
        const member = await require('../members/memberdetails.model').findById(ownerId).lean();
        if (!member || member.deletedAt || member.isActive === false
            || clean(member.membershipStatus).toLowerCase() === 'cancelled') return 'The member account is no longer active.';
        const paid = ['paid', 'not_required'].includes(registration.payment?.status);
        if (row.event === 'EVENT_BOOKING_WAITLISTED') {
            if (registration.status !== 'waitlist') return 'This registration is no longer waitlisted.';
        } else if (registration.status !== 'registered' || !paid) {
            return 'This registration no longer holds a paid or free confirmed seat.';
        }
        if (!data.registrationStateKey || data.registrationStateKey !== registrationStateKey(registration)) {
            return 'This registration has changed since the message was created.';
        }
        const event = await require('./event.model').findById(eventId).lean();
        if (!event || event.archivedAt || event.status !== 'published' || isPastEvent(event)) {
            return 'The event is no longer current and published.';
        }
        if (!data.changeSnapshotKey || data.changeSnapshotKey !== eventSnapshotKey(event)) {
            return 'Event details have changed since this message.';
        }
        if (row.event === 'EVENT_REMINDER') {
            const start = new Date(event.startAt).getTime();
            const hours = Number(data.reminderHours);
            const moment = start - hours * 60 * 60 * 1000;
            const key = registrationReminderKey(start, hours);
            if (!key || start <= Date.now() || moment > Date.now()
                || !currentReminderOffsets(event).includes(hours)
                || dateKey(data.reminderEventStartAt) !== dateKey(event.startAt)
                || !(new Date(registration.registeredAt).getTime() < moment)) {
                return 'This event reminder window is no longer due.';
            }
            if (data.reminderKey !== key || (!data.reminderDurablyQueued && !(registration.remindersSent || []).includes(key))) {
                return 'The original event reminder could not be verified.';
            }
        } else if (!data.changeId || !(registration.eventChangesSent || []).includes(data.changeId)) {
            return 'The original registration notice could not be verified.';
        }
        return '';
    } catch {
        return 'Current registration, event or member details could not be checked. Retry after they can be verified.';
    }
}

const latestEventClaim = record => (record.eventChangesSent || [])
    .filter(key => /^event:\d+:[a-f0-9]{64}$/.test(key))
    .reduce((latest, key) => !latest || Number(key.split(':')[1]) >= Number(latest.split(':')[1]) ? key : latest, '');

/** Stored change messages may only be retried while their facts still hold. */
async function reasonToSkipChange(row = {}) {
    if (!['EVENT_UPDATED', 'EVENT_CANCELLED'].includes(row.event)) return '';
    if (!['email', 'whatsapp'].includes(row.channel)) return 'Only external event messages can be retried.';
    const data = row.data?.lifecycleData || row.data || {};
    try {
        const legacy = !!data.registrationId;
        const bookingRef = clean(data.bookingRef || row.bookingRef).toUpperCase();
        if (!legacy && !bookingRef) return 'The original event booking could not be verified.';
        const record = legacy
            ? await require('./eventregistration.model').findById(data.registrationId).lean()
            : await require('./eventbooking.model').findOne({ bookingRef }).lean();
        if (!record || record.deletedAt) return 'The event booking or registration no longer exists.';

        const eventId = idOf(record.eventId);
        if (!eventId || (data.eventId && idOf(data.eventId) !== eventId)
            || (row.eventId && idOf(row.eventId) !== eventId)) return 'The message no longer matches this event.';
        const people = legacy ? [record] : [record.bookedBy || {}, ...(record.participants || [])];
        if (!people.some(person => recipientMatches(row, person))) return 'This recipient is no longer on the event booking.';

        const ownerId = idOf(record.userId);
        const messageUserId = idOf(row.user);
        if ((legacy && !ownerId) || (messageUserId && messageUserId !== ownerId)) {
            return 'The message no longer matches the member account.';
        }
        if (ownerId) {
            const member = await require('../members/memberdetails.model').findById(ownerId).lean();
            if (!member || member.deletedAt || member.isActive === false
                || clean(member.membershipStatus).toLowerCase() === 'cancelled') return 'The member account is no longer active.';
        }

        const event = await require('./event.model').findById(eventId).lean();
        if (!event) return 'The event no longer exists.';
        if (isPastEvent(event)) return 'The event has already finished.';
        const individualCancellation = legacy && row.event === 'EVENT_CANCELLED' && data.cancelledScope === 'registration';
        const registrationUpdate = legacy && row.event === 'EVENT_UPDATED' && data.changeScope === 'registration';
        const paid = ['paid', 'not_required'].includes(record.payment?.status);
        const currentStatus = legacy && record.status === 'registered' && !paid ? 'pending' : record.status;
        if (!data.bookingStatus || data.bookingStatus !== currentStatus) return 'The registration status has changed since this message.';

        if (individualCancellation) {
            if (record.status !== 'cancelled') return 'This registration is no longer cancelled.';
        } else if (registrationUpdate) {
            // A legacy waitlist promotion asks for payment; it must stop being
            // replayable as soon as the seat is paid, cancelled or retaken.
            if (record.status !== 'registered' || record.payment?.status !== 'pending') {
                return 'This registration no longer needs the pending payment update.';
            }
        } else if (!(record.status === 'waitlist' || (record.status === (legacy ? 'registered' : 'active') && paid))) {
            return 'This event booking is no longer confirmed or waitlisted.';
        }

        if (row.event === 'EVENT_UPDATED') {
            if (event.archivedAt || event.status !== 'published') return 'The updated event is no longer published.';
        } else if (!individualCancellation && (!event.archivedAt || data.cancelledScope !== 'event')) {
            return 'The event is no longer withdrawn.';
        }
        if (!data.changeSnapshotKey || data.changeSnapshotKey !== eventSnapshotKey(event)) {
            return 'Event details have changed since this message.';
        }
        if (!data.changeId || !(record.eventChangesSent || []).includes(data.changeId)) {
            return 'The original event change could not be verified.';
        }
        if (individualCancellation || registrationUpdate) {
            if (!data.registrationStateKey || data.registrationStateKey !== registrationStateKey(record)) {
                return 'This registration has changed since the message was created.';
            }
        } else if (latestEventClaim(record) !== data.changeId) {
            return 'A newer event change has replaced this message.';
        }
        return '';
    } catch {
        return 'Current event, booking or member details could not be checked. Retry after they can be verified.';
    }
}

module.exports = { attendanceDetails, describeChange, eventChangeKey, notifyEventChange, announceChange, announceRegistration,
    registrationContext, currentBookings, currentRegistrations, reasonToSkipChange,
    registrationReminderKey, reasonToSkipRegistrationNotice };
