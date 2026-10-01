const NotificationLog = require('./notificationLog.model');
const { effectiveStatus } = require('./deliveryStatus.service');

/**
 * The Super Admin's delivery queries — filters, the effective status, and
 * matching messages to bookings. Pure helpers plus two reads; kept apart from
 * `notification.service` so the rules can be tested without a database.
 */

const escapeRe = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Everything a Super Admin means by "automation": email + WhatsApp, not the bot. */
const NOT_AUTOMATION = ['BOT_REPLY', 'CUSTOM'];
const BOOKING_EVENT_RE = /^EVENT_(BOOKING|PARTICIPANT|DOCUMENT)_/;
/** Account and donation mail (core/utils/mailer) — their own Super Admin tab. */
const ACCOUNT_EVENTS = ['PASSWORD_RESET', 'ADMIN_WELCOME', 'DONATION_RECEIPT', 'DONATION_STATEMENT'];

/**
 * The status a row is SHOWN with, as an aggregation expression — the same rule
 * as `deliveryStatus.effectiveStatus`, so the tiles and the badges agree.
 */
const EFFECTIVE_STATUS_EXPR = {
    $cond: [
        { $eq: ['$mock', true] }, 'mock',
        {
            /* Superseded by a re-send: its outcome is the NEWER row's, so it is
               shown as "resent", never counted as failed. */
            $cond: [{ $gt: [{ $ifNull: ['$resentAs', null] }, null] }, 'resent',
        {
            $ifNull: ['$deliveryStatus', {
                $switch: {
                    branches: [
                        { case: { $eq: ['$status', 'failed'] }, then: 'failed' },
                        { case: { $eq: ['$status', 'sent'] }, then: 'accepted' }
                    ],
                    default: 'queued'
                }
            }]
        }]
        }
    ]
};

/** The Mongo clause for one effective status. */
const deliveryClause = (delivery) => {
    const d = String(delivery || '').toLowerCase();
    if (!d) return null;
    if (d === 'mock') return { mock: true };
    const notMock = { mock: { $ne: true } };
    if (d === 'failed') {
        // A failure that was re-sent is not a failure any more — its newer row is the answer.
        return { ...notMock, resentAs: { $exists: false }, $or: [{ deliveryStatus: 'failed' }, { deliveryStatus: { $exists: false }, status: 'failed' }] };
    }
    if (d === 'resent') return { ...notMock, resentAs: { $exists: true } };
    if (d === 'accepted') {
        return { ...notMock, $or: [{ deliveryStatus: 'accepted' }, { deliveryStatus: { $exists: false }, status: 'sent' }] };
    }
    if (['sent', 'delivered', 'read'].includes(d)) return { ...notMock, deliveryStatus: d };
    /* `reached`: left the server and did not fail — the Automation view's
       single "Sent" answer (accepted, sent, delivered and read together). */
    if (d === 'reached') {
        return {
            ...notMock,
            $nor: [{ deliveryStatus: 'failed' }, { deliveryStatus: { $exists: false }, status: { $in: ['failed', 'queued'] } }]
        };
    }
    return null;
};

/** "2026-09-30" as the START of that day in IST; `endOfDay` for the day after. */
const istDay = (value, endOfDay = false) => {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+05:30`);
    if (Number.isNaN(d.getTime())) return null;
    return endOfDay ? new Date(d.getTime() + 24 * 60 * 60 * 1000) : d;
};

/** Build the log query from the Super Admin's filters. Pure. */
const buildLogQuery = ({ channel, status, event, search, delivery, group, eventId, bookingRef, from, to } = {}) => {
    const and = [];
    const ch = String(channel || '').trim();
    if (ch) and.push({ channel: ch });
    if (status) and.push({ status: String(status) });
    if (event) and.push({ event: String(event) });

    const g = String(group || '').toLowerCase();
    if (g === 'automation' || g === 'booking' || g === 'membership' || g === 'account') {
        if (!ch) and.push({ channel: { $in: ['email', 'whatsapp'] } });
        and.push({ event: { $nin: NOT_AUTOMATION } });
        if (g === 'booking') and.push({ event: { $regex: BOOKING_EVENT_RE.source } });
        if (g === 'membership') {
            and.push({ event: { $not: BOOKING_EVENT_RE } }, { event: { $not: /^EVENT_/ } }, { event: { $nin: ACCOUNT_EVENTS } });
        }
        if (g === 'account') and.push({ event: { $in: ACCOUNT_EVENTS } });
    }

    const dc = deliveryClause(delivery);
    if (dc) and.push(dc);

    if (eventId) and.push({ eventId: String(eventId) });
    if (bookingRef) {
        const ref = String(bookingRef).trim().toUpperCase();
        and.push({ $or: [{ bookingRef: ref }, { 'data.bookingRef': ref }] });
    }

    const start = istDay(from);
    const end = istDay(to, true);
    if (start || end) {
        and.push({ createdAt: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } });
    }

    const q = String(search || '').trim();
    if (q) {
        /*
         * What an operator has in hand when somebody says "I never got it": a
         * name, an address, a phone number in any spelling, or the booking
         * reference off their screenshot. A number is matched on its last ten
         * digits, because it is stored as `9199…` and typed as `+91 99…`.
         */
        const re = new RegExp(escapeRe(q), 'i');
        const or = [{ recipient: re }, { recipientName: re }, { bookingRef: re }, { subject: re }, { eventTitle: re }];
        const digits = q.replace(/\D/g, '');
        if (digits.length >= 6 && digits.length === q.replace(/[\s+\-()]/g, '').length) {
            or.push({ recipient: new RegExp(`${escapeRe(digits.slice(-10))}$`) });
        }
        and.push({ $or: or });
    }

    if (!and.length) return {};
    return and.length === 1 ? and[0] : { $and: and };
};

/** A row as the API returns it: with the one status to show. */
/*
 * `recipientName` falls back to the name stored in `data` — rows logged before
 * the top-level field existed carry it only there, and showed as "No name".
 */
const withEffectiveStatus = (row = {}) => ({
    ...row,
    recipientName: row.recipientName || (row.data && row.data.recipientName) || '',
    effectiveStatus: effectiveStatus(row)
});

/** Latest row per channel → `{ status, at, reason, count }`. */
const summarise = (rows = []) => {
    const out = {};
    ['email', 'whatsapp'].forEach((channel) => {
        const list = rows.filter((r) => r && r.channel === channel)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        if (!list.length) return;
        const latest = list[0];
        const status = effectiveStatus(latest);
        out[channel] = {
            status,
            at: latest.createdAt,
            reason: status === 'failed' ? (latest.failureReason || latest.lastError || '') : '',
            count: list.length,
            failed: list.filter((r) => effectiveStatus(r) === 'failed').length
        };
    });
    return out;
};

const phoneKey = (value) => String(value || '').replace(/\D/g, '').slice(-10);

/**
 * Rows from BEFORE delivery tracking (no `bookingRef`) that belong to these
 * bookings, matched by the address they went to.
 *
 * A row belongs to the most recent of the bookings that (a) it was addressed
 * to — booker or participant, email exactly or the last ten digits of the
 * phone — and (b) existed when it was sent. Resolves `Map<ref, rows[]>`.
 */
const matchLegacyRows = async(refs = []) => {
    const EventBooking = require('../events/eventbooking.model');
    const bookings = await EventBooking.find({ bookingRef: { $in: refs } })
        .select('bookingRef createdAt bookedBy participants')
        .lean()
        .catch(() => []);
    const out = new Map();
    if (!bookings || !bookings.length) return out;

    const addressesOf = (b) => {
        const people = [b.bookedBy || {}, ...(Array.isArray(b.participants) ? b.participants : [])];
        return {
            emails: new Set(people.map((p) => String((p && p.email) || '').trim().toLowerCase()).filter(Boolean)),
            phones: new Set(people.map((p) => phoneKey(p && p.phone)).filter((k) => k.length === 10))
        };
    };
    const index = bookings.map((b) => ({ b, ...addressesOf(b) }));

    const emails = [...new Set(index.flatMap((i) => [...i.emails]))];
    const phones = [...new Set(index.flatMap((i) => [...i.phones]))];
    const recipients = [...emails, ...phones.flatMap((p) => [p, `91${p}`, `+91${p}`, `0${p}`])];
    if (!recipients.length) return out;

    const since = new Date(Math.min(...bookings.map((b) => new Date(b.createdAt || 0).getTime())));
    const rows = await NotificationLog.find({
        bookingRef: { $exists: false },
        'data.bookingRef': { $exists: false },
        event: { $regex: BOOKING_EVENT_RE.source },
        channel: { $in: ['email', 'whatsapp'] },
        recipient: { $in: recipients },
        createdAt: { $gte: since }
    }).sort({ createdAt: -1 }).limit(2000).lean().catch(() => []);

    for (const row of rows || []) {
        const r = String(row.recipient || '').trim().toLowerCase();
        const key = r.includes('@') ? '' : phoneKey(r);
        const at = new Date(row.createdAt).getTime();
        const candidates = index
            .filter((i) => (key ? i.phones.has(key) : i.emails.has(r)) && new Date(i.b.createdAt).getTime() <= at)
            .sort((a, b) => new Date(b.b.createdAt) - new Date(a.b.createdAt));
        if (!candidates.length) continue;
        const ref = String(candidates[0].b.bookingRef).toUpperCase();
        if (!out.has(ref)) out.set(ref, []);
        out.get(ref).push(row);
    }
    return out;
};

module.exports = {
    EFFECTIVE_STATUS_EXPR, buildLogQuery, deliveryClause, withEffectiveStatus, summarise, matchLegacyRows, istDay,
    BOOKING_EVENT_RE, NOT_AUTOMATION
};
