const mongoose = require('mongoose');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const pass = require('./eventPass');

/**
 * ============================================================================
 * EVENT CHECK-IN — look a pass up, let its holder in, count who came
 * ============================================================================
 *
 * The door, step by step:
 *
 *   1. The attendee shows the QR from their confirmation email. It holds a
 *      signed pass token (eventPass.js) naming ONE SEAT on ONE booking.
 *   2. Events staff scan it in the ACTIV app -> `lookup`. Nothing is written.
 *      The app shows the name on that seat, the event, the ticket, whether it
 *      is paid, and whether the seat is admissible at all.
 *   3. Staff press "Allow entry" -> `admit`. One `EventCheckin` row is
 *      inserted; the unique index on (booking, seat) makes a second press, a
 *      second scan or a second gate answer "already checked in at <time> by
 *      <staff>" instead of a second row.
 *
 * WHO MAY BE LET IN is `admissibility()` and nothing else:
 *
 *   cancelled                        never
 *   waitlist                         never — no seat was confirmed
 *   paid, or free (not_required)     yes, even if the hold was swept to
 *                                    `expired` after the money arrived (the
 *                                    same rule `bookingAsRegistration` uses)
 *   expired and unpaid               no — the hold lapsed
 *   pending / failed payment         no — send them to the organiser, who can
 *                                    record the payment (then scan again)
 *
 * The service is built from its dependencies so the tests can run it against
 * in-memory models with no database.
 */

const TZ = 'Asia/Kolkata';
const str = (value) => String(value === null || value === undefined ? '' : value).trim();

/** Bookings whose seats may walk in — the Mongo form of `admissibility`. */
const ADMISSIBLE_CLAUSE = {
    status: { $nin: ['cancelled', 'waitlist'] },
    'payment.status': { $in: ['paid', 'not_required'] }
};

/** Seats on a booking, however it was written. */
const seatCount = (b = {}) => Math.max(
    1,
    Number(b.noOfPersons || 0) || 0,
    Array.isArray(b.participants) ? b.participants.length : 0
);

/** The person in seat `index`: the participant line, or the booker for seat 1 when the line is blank. */
const personAt = (b = {}, index = 0) => {
    const p = (Array.isArray(b.participants) ? b.participants[index] : null) || {};
    const booker = b.bookedBy || {};
    const useBooker = index === 0 && !str(p.name);
    return {
        name: str(useBooker ? booker.name : p.name) || `Guest ${index + 1}`,
        email: str(useBooker ? booker.email : p.email),
        phone: str(useBooker ? booker.phone : p.phone)
    };
};

/** "•••• 3210" — enough for staff to confirm a number the attendee reads out. */
const maskPhone = (phone) => {
    const digits = str(phone).replace(/\D/g, '');
    return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '';
};

const PAYMENT_LABELS = {
    paid: 'Paid',
    not_required: 'Free entry',
    pending: 'Payment pending',
    failed: 'Payment failed'
};

/**
 * May this seat be let in? `{ ok: true }`, or `{ ok: false, code, message }`
 * with the sentence the staff screen prints. Pure.
 */
const admissibility = (booking, index = 0, event = null, expectedEventId = '') => {
    if (!booking) return { ok: false, code: 'not_found', message: 'No booking matches this pass.' };
    const status = str(booking.status) || 'active';
    const paymentStatus = str(booking.payment && booking.payment.status) || 'pending';

    if (status === 'cancelled') {
        return { ok: false, code: 'cancelled', message: 'This booking was cancelled. Do not admit — send the attendee to the organiser.' };
    }
    if (status === 'waitlist') {
        return { ok: false, code: 'waitlist', message: 'This booking is on the waitlist. No seat was confirmed.' };
    }
    if (paymentStatus !== 'paid' && paymentStatus !== 'not_required') {
        if (status === 'expired') {
            return { ok: false, code: 'expired', message: 'This booking lapsed before payment was completed. Send the attendee to the organiser.' };
        }
        return { ok: false, code: 'unpaid', message: 'Payment for this booking has not been completed. Send the attendee to the organiser’s desk.' };
    }
    if (!Number.isInteger(index) || index < 0 || index >= seatCount(booking)) {
        return { ok: false, code: 'no_seat', message: 'This seat is no longer on the booking.' };
    }
    /*
     * AT A DOOR (`expectedEventId` given — `lookup` / `admit` refuse to run
     * without one): a pass works only at its OWN event's door, and an online
     * event has no door at all. Without a door (the public pass page, the
     * booking's own pass list) the pass is judged on its own.
     */
    const bookingEvent = str(booking.eventId);
    if (expectedEventId && event && str(event.mode) === 'online') {
        return { ok: false, code: 'online_event', message: 'This pass is for an online event — there is no check-in at a door.' };
    }
    if (expectedEventId && bookingEvent && str(expectedEventId) !== bookingEvent) {
        const title = str(event && event.title) || str(booking.eventTitle) || 'another event';
        return { ok: false, code: 'wrong_event', message: `This pass is for “${title}”, not the event you are checking in.` };
    }
    return { ok: true, code: 'ok', message: '' };
};

const istLabel = (date) => {
    const d = date ? new Date(date) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
        timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
    });
};

const isSameIstDay = (a, b) => {
    const da = a ? new Date(a) : null;
    const db = b ? new Date(b) : null;
    if (!da || !db || Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
    return da.toLocaleDateString('en-CA', { timeZone: TZ }) === db.toLocaleDateString('en-CA', { timeZone: TZ });
};

/** Whether an event is on today (IST), or running now across several days. */
const isOnToday = (event = {}, now = new Date()) => {
    if (!event.startAt) return false;
    if (isSameIstDay(event.startAt, now)) return true;
    const start = new Date(event.startAt).getTime();
    const end = event.endAt ? new Date(event.endAt).getTime() : NaN;
    return !Number.isNaN(end) && start <= now.getTime() && now.getTime() <= end;
};

const eventSummary = (event = {}, booking = {}) => ({
    id: str(event._id || booking.eventId),
    title: str(event.title) || str(booking.eventTitle) || 'ACTIV event',
    startAt: event.startAt || booking.eventStartAt || null,
    endAt: event.endAt || null,
    venue: str(event.venue) || str(booking.eventVenue),
    mode: str(event.mode) || 'offline',
    category: str(event.category)
});

const checkinSummary = (c) => (c ? {
    id: str(c._id),
    admittedAt: c.admittedAt || c.createdAt || null,
    admittedAtLabel: istLabel(c.admittedAt || c.createdAt),
    admittedBy: {
        name: str(c.admittedBy && c.admittedBy.name) || str(c.admittedBy && c.admittedBy.email) || 'Events staff',
        email: str(c.admittedBy && c.admittedBy.email),
        role: str(c.admittedBy && c.admittedBy.role)
    },
    method: str(c.method) || 'qr',
    attendeeName: str(c.attendeeName)
} : null);

/**
 * One seat as the staff screen shows it. Contact details are MASKED at the
 * door: staff need a name to match against an ID, not every attendee's
 * number in their pocket.
 */
const describeSeat = ({ booking, index, event, checkin = null, expectedEventId = '' }) => {
    const verdict = admissibility(booking, index, event, expectedEventId);
    const person = personAt(booking, index);
    const paymentStatus = str(booking.payment && booking.payment.status) || 'pending';
    const unit = Number(booking.unitAmount || 0);
    return {
        registrationNo: pass.registrationNo(booking.bookingRef, index),
        bookingRef: str(booking.bookingRef),
        participantIndex: index,
        participantNumber: index + 1,
        seats: seatCount(booking),
        attendee: { name: person.name, phoneMasked: maskPhone(person.phone) },
        bookedBy: { name: str(booking.bookedBy && booking.bookedBy.name) },
        isGuest: !!booking.isGuest,
        event: eventSummary(event || {}, booking),
        ticket: {
            category: str(event && event.category),
            label: unit <= 0 ? 'Free entry' : (booking.memberRateApplied ? 'Member rate' : 'Standard ticket'),
            unitAmount: unit
        },
        payment: {
            status: paymentStatus,
            label: PAYMENT_LABELS[paymentStatus] || paymentStatus,
            mode: str(booking.payment && booking.payment.mode)
        },
        bookingStatus: str(booking.status) || 'active',
        admissible: verdict.ok,
        reason: verdict.ok ? null : { code: verdict.code, message: verdict.message },
        eventIsToday: isOnToday(event || {}),
        checkedIn: !!checkin,
        checkin: checkinSummary(checkin)
    };
};

/* ----------------------------------------------------------------- CSV */
const FORMULA_START = /^[=+@\-\t\r]/;
const csvCell = (value) => {
    let text = String(value === null || value === undefined ? '' : value);
    // A cell a spreadsheet would evaluate is a cell that can run on the organiser's machine.
    if (FORMULA_START.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const lean = (q) => (q && typeof q.lean === 'function' ? q.lean() : q);
const oid = (value) => (mongoose.Types.ObjectId.isValid(str(value)) ? new mongoose.Types.ObjectId(str(value)) : null);

/**
 * @param deps { Booking, Event, Checkin, findStaff(id) -> { fullName } | null }
 */
const createCheckinService = (deps = {}) => {
    const { Booking, Event, Checkin } = deps;
    const findStaff = deps.findStaff || (async() => null);
    const staffNames = new Map();

    const staffOf = async(user = {}) => {
        const id = str(user.userId || user.id || user._id);
        let name = staffNames.get(id);
        if (name === undefined && id) {
            try {
                const row = await findStaff(id);
                name = str(row && (row.fullName || row.name));
            } catch (error) {
                name = '';
            }
            staffNames.set(id, name);
        }
        return { id, name: name || '', email: str(user.email).toLowerCase(), role: str(user.role) };
    };

    const loadEvent = async(eventId) => {
        const id = oid(eventId);
        if (!id) return null;
        return lean(Event.findById(id, 'title startAt endAt venue mode category status slug')) || null;
    };

    const loadCheckin = (bookingId, index) =>
        lean(Checkin.findOne({ bookingId: oid(bookingId), participantIndex: index }));

    /**
     * Resolve what staff scanned or typed to `{ booking, index | null }`.
     *   token          the QR (or the whole pass URL)
     *   registrationNo `<ref>-P<n>`, or a bare booking reference
     *   bookingRef + participantIndex
     */
    const resolve = async(input = {}) => {
        const token = pass.extractToken(input.token || input.code || '');
        if (token) {
            const seat = pass.verifyPass(token);
            if (!seat) throw ApiError.notFound('This is not a valid ACTIV event pass.');
            const booking = await lean(Booking.findById(oid(seat.bookingId)));
            if (!booking) throw ApiError.notFound('No booking matches this pass.');
            return { booking, index: seat.index, method: 'qr' };
        }
        if (str(input.token || input.code)) {
            // Something was scanned, and it was not a pass (a menu, a UPI code…).
            throw ApiError.badRequest('This QR code is not an ACTIV event pass.');
        }

        let ref = str(input.bookingRef).toUpperCase();
        let index = input.participantIndex === undefined || input.participantIndex === null || input.participantIndex === ''
            ? null : Number(input.participantIndex);
        const parsed = pass.parseRegistrationNo(input.registrationNo || (ref ? '' : input.query));
        if (parsed) {
            ref = ref || parsed.bookingRef;
            if (index === null) index = parsed.index;
        } else if (ref) {
            const fromRef = pass.parseRegistrationNo(ref);
            if (fromRef) { ref = fromRef.bookingRef; if (index === null) index = fromRef.index; }
        }
        if (!ref) throw ApiError.badRequest('Scan a pass, or enter a booking ID or registration number.');
        const booking = await lean(Booking.findOne({ bookingRef: ref }));
        if (!booking) throw ApiError.notFound(`No booking with ID ${ref}.`);
        if (index !== null && (!Number.isInteger(index) || index < 0)) throw ApiError.badRequest('Invalid participant number.');
        return { booking, index, method: 'manual' };
    };

    /**
     * What staff see after a scan. Never writes. A booking reference with no
     * seat number answers every seat on it, so the staff app can offer a list.
     */
    const lookup = async(input = {}) => {
        if (!str(input.eventId)) throw ApiError.badRequest('Open the scanner from the event you are checking in.');
        const { booking, index, method } = await resolve(input);
        const event = await loadEvent(booking.eventId);
        const expectedEventId = str(input.eventId);
        if (index === null) {
            const seats = [];
            for (let i = 0; i < seatCount(booking); i += 1) {
                seats.push(describeSeat({ booking, index: i, event, checkin: await loadCheckin(booking._id, i), expectedEventId }));
            }
            return { method, bookingRef: str(booking.bookingRef), seats };
        }
        const checkin = await loadCheckin(booking._id, index);
        return { method, bookingRef: str(booking.bookingRef), seats: [describeSeat({ booking, index, event, checkin, expectedEventId })] };
    };

    /**
     * Let one seat in. Idempotent: a seat already in answers
     * `outcome: 'already_checked_in'` with who let it in and when. A seat that
     * may not enter throws 409 with the reason.
     */
    const admit = async(input = {}, user = {}, meta = {}) => {
        if (!str(input.eventId)) throw ApiError.badRequest('Open the scanner from the event you are checking in.');
        const { booking, index, method } = await resolve(input);
        if (index === null) throw ApiError.badRequest('Choose which participant on the booking to admit.');
        const event = await loadEvent(booking.eventId);
        const expectedEventId = str(input.eventId);

        /*
         * Wrong door or an online event is refused BEFORE "already checked in":
         * a pass scanned at its own event must not read as a friendly "already
         * in" at another event's door.
         */
        const door = admissibility(booking, index, event, expectedEventId);
        if (['wrong_event', 'online_event'].includes(door.code)) {
            const error = ApiError.conflict(door.message);
            error.fields = { reason: door.code };
            error.reasonCode = door.code;
            throw error;
        }

        const existing = await loadCheckin(booking._id, index);
        if (existing) {
            return { outcome: 'already_checked_in', seat: describeSeat({ booking, index, event, checkin: existing, expectedEventId }) };
        }

        const verdict = admissibility(booking, index, event, expectedEventId);
        if (!verdict.ok) {
            const error = ApiError.conflict(verdict.message);
            // `fields` is what the error handler passes through to the client.
            error.fields = { reason: verdict.code };
            error.reasonCode = verdict.code;
            throw error;
        }

        const person = personAt(booking, index);
        const doc = {
            eventId: booking.eventId,
            bookingId: booking._id,
            bookingRef: str(booking.bookingRef),
            participantIndex: index,
            registrationNo: pass.registrationNo(booking.bookingRef, index),
            attendeeName: person.name,
            attendeeEmail: person.email,
            attendeePhone: person.phone,
            admittedAt: new Date(),
            admittedBy: await staffOf(user),
            method: meta.method === 'manual' || method === 'manual' ? 'manual' : 'qr',
            device: str(meta.device).slice(0, 120)
        };

        let created;
        try {
            created = await Checkin.create(doc);
        } catch (error) {
            if (error && (error.code === 11000 || /E11000/.test(String(error.message || '')))) {
                // Another gate won the race by milliseconds — theirs is the record.
                const winner = await loadCheckin(booking._id, index);
                return { outcome: 'already_checked_in', seat: describeSeat({ booking, index, event, checkin: winner, expectedEventId }) };
            }
            throw error;
        }
        const row = created && typeof created.toObject === 'function' ? created.toObject() : created;
        logger.info('Event check-in', {
            eventId: str(booking.eventId), bookingRef: booking.bookingRef, seat: index + 1, by: doc.admittedBy.email, method: doc.method
        });
        return { outcome: 'admitted', seat: describeSeat({ booking, index, event, checkin: row, expectedEventId }) };
    };

    /**
     * What a stranger learns from a pass: that it is an ACTIV pass, for which
     * event, and whether it is still valid. No name, no reference, no contact.
     */
    const publicPass = async(token) => {
        const seat = pass.verifyPass(pass.extractToken(token));
        if (!seat) throw ApiError.notFound('This is not a valid ACTIV event pass.');
        const booking = await lean(Booking.findById(oid(seat.bookingId)));
        if (!booking) throw ApiError.notFound('This is not a valid ACTIV event pass.');
        const event = await loadEvent(booking.eventId);
        const summary = eventSummary(event || {}, booking);
        return {
            valid: admissibility(booking, seat.index, event).ok,
            event: { title: summary.title, startAt: summary.startAt, endAt: summary.endAt, venue: summary.venue, mode: summary.mode }
        };
    };

    /**
     * Every seat on an event, checked in or not. Checked-in seats whose booking
     * was cancelled afterwards are kept — they did walk in.
     *
     * `includeContact` is the super admin's: the events admin writes the
     * programme but does not see attendees' contact details (event.routes
     * BOOKING_VIEWERS), so their rows carry a masked number only.
     */
    const attendance = async(eventId, { q = '', status = 'all', includeContact = false } = {}) => {
        const id = oid(eventId);
        if (!id) throw ApiError.badRequest('Invalid event');
        const event = await loadEvent(id);
        if (!event) throw ApiError.notFound('Event not found');

        const [bookings, checkins] = await Promise.all([
            // Every seat that could have walked in, and every seat that did.
            lean(Booking.find({ eventId: id, ...ADMISSIBLE_CLAUSE })),
            lean(Checkin.find({ eventId: id }))
        ]);
        const byKey = new Map((checkins || []).map((c) => [`${str(c.bookingId)}:${c.participantIndex}`, c]));
        const used = new Set();
        const rows = [];

        const rowOf = (booking, index, checkin, snapshot = null) => {
            const person = snapshot || personAt(booking, index);
            const c = checkinSummary(checkin);
            return {
                registrationNo: pass.registrationNo(booking.bookingRef, index),
                bookingRef: str(booking.bookingRef),
                participantNumber: index + 1,
                name: checkin ? (str(checkin.attendeeName) || person.name) : person.name,
                email: includeContact ? person.email : '',
                phone: includeContact ? person.phone : '',
                phoneMasked: maskPhone(person.phone),
                bookedBy: str(booking.bookedBy && booking.bookedBy.name),
                payment: PAYMENT_LABELS[str(booking.payment && booking.payment.status)] || '',
                bookingStatus: str(booking.status) || 'active',
                checkedIn: !!checkin,
                admittedAt: c ? c.admittedAt : null,
                admittedAtLabel: c ? c.admittedAtLabel : '',
                admittedBy: c ? c.admittedBy.name : '',
                admittedByEmail: c ? c.admittedBy.email : '',
                method: c ? c.method : ''
            };
        };

        (bookings || []).forEach((b) => {
            for (let i = 0; i < seatCount(b); i += 1) {
                const key = `${str(b._id)}:${i}`;
                const c = byKey.get(key) || null;
                if (c) used.add(key);
                rows.push(rowOf(b, i, c));
            }
        });

        // Walked in, and the booking has since been cancelled or changed.
        const orphans = (checkins || []).filter((c) => !used.has(`${str(c.bookingId)}:${c.participantIndex}`));
        orphans.forEach((c) => rows.push(rowOf(
            { bookingRef: c.bookingRef, status: 'changed', payment: {}, bookedBy: {} },
            c.participantIndex,
            c,
            { name: str(c.attendeeName) || 'Attendee', email: str(c.attendeeEmail), phone: str(c.attendeePhone) }
        )));

        const registered = rows.filter((r) => r.bookingStatus !== 'changed').length;
        const checkedIn = rows.filter((r) => r.checkedIn).length;

        const needle = str(q).toLowerCase();
        const filtered = rows.filter((r) => {
            if (status === 'in' && !r.checkedIn) return false;
            if (status === 'out' && r.checkedIn) return false;
            if (!needle) return true;
            return [r.name, r.registrationNo, r.bookingRef, r.bookedBy, r.email, r.phone, r.admittedBy]
                .some((v) => str(v).toLowerCase().includes(needle));
        });
        // Most recent entries first, then everybody still expected, by name.
        filtered.sort((a, b) => {
            if (a.checkedIn !== b.checkedIn) return a.checkedIn ? -1 : 1;
            if (a.checkedIn) return new Date(b.admittedAt || 0) - new Date(a.admittedAt || 0);
            return a.name.localeCompare(b.name);
        });

        return {
            event: eventSummary(event),
            totals: {
                registered,
                checkedIn,
                notYet: Math.max(0, registered - rows.filter((r) => r.checkedIn && r.bookingStatus !== 'changed').length),
                percent: registered ? Math.round((checkedIn / registered) * 100) : 0
            },
            includeContact: !!includeContact,
            rows: filtered
        };
    };

    const attendanceCsv = async(eventId, options = {}) => {
        const data = await attendance(eventId, { ...options, q: '', status: 'all' });
        const withContact = !!options.includeContact;
        const header = ['Registration no', 'Booking ID', 'Seat', 'Attendee',
            ...(withContact ? ['Email', 'Phone'] : ['Phone (last 4)']),
            'Booked by', 'Payment', 'Status', 'Checked in at (IST)', 'Admitted by', 'Method'];
        const lines = [header.map(csvCell).join(',')];
        data.rows.forEach((r) => {
            lines.push([
                r.registrationNo, r.bookingRef, r.participantNumber, r.name,
                ...(withContact ? [r.email, r.phone] : [r.phoneMasked]),
                r.bookedBy, r.payment,
                r.checkedIn ? (r.bookingStatus === 'changed' ? 'Checked in (booking since changed)' : 'Checked in') : 'Not yet',
                r.admittedAtLabel, r.admittedBy ? `${r.admittedBy}${r.admittedByEmail && withContact ? ` <${r.admittedByEmail}>` : ''}` : '',
                r.method === 'manual' ? 'Manual entry' : (r.method ? 'QR scan' : '')
            ].map(csvCell).join(','));
        });
        const slug = str(data.event.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event';
        return {
            filename: `attendance-${slug}-${new Date().toISOString().slice(0, 10)}.csv`,
            // BOM so Excel reads the names as UTF-8.
            csv: `﻿${lines.join('\r\n')}\r\n`
        };
    };

    /**
     * The events a door team would open: on today, coming up, or just past
     * (`scope: 'upcoming'`, the default — from two days ago onward), or older
     * ones (`scope: 'past'`). Published, IN-PERSON only. With registered /
     * checked-in counts.
     */
    const listCheckinEvents = async({ scope = 'upcoming', now = new Date() } = {}) => {
        const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const past = scope === 'past';
        // In-person events only: an online event has no door (no `mode` = in person).
        const filter = {
            status: 'published',
            mode: { $ne: 'online' },
            startAt: past ? { $lt: since, $ne: null } : { $gte: since }
        };
        const events = await lean(Event.find(filter, 'title startAt endAt venue mode category slug', {
            sort: { startAt: past ? -1 : 1 }, limit: 60
        })) || [];
        const ids = events.map((e) => e._id);

        const [seatAgg, checkinAgg] = ids.length ? await Promise.all([
            Booking.aggregate([
                { $match: { eventId: { $in: ids }, ...ADMISSIBLE_CLAUSE } },
                { $group: {
                    _id: '$eventId',
                    seats: { $sum: { $max: [
                        { $ifNull: ['$noOfPersons', 1] },
                        { $size: { $ifNull: ['$participants', []] } },
                        1
                    ] } }
                } }
            ]),
            Checkin.aggregate([
                { $match: { eventId: { $in: ids } } },
                { $group: { _id: '$eventId', n: { $sum: 1 } } }
            ])
        ]) : [[], []];
        const seats = new Map((seatAgg || []).map((r) => [str(r._id), Number(r.seats || 0)]));
        const ins = new Map((checkinAgg || []).map((r) => [str(r._id), Number(r.n || 0)]));

        return events.map((e) => ({
            ...eventSummary(e),
            slug: str(e.slug),
            isToday: isOnToday(e, now),
            registered: seats.get(str(e._id)) || 0,
            checkedIn: ins.get(str(e._id)) || 0
        }));
    };

    return { resolve, lookup, admit, publicPass, attendance, attendanceCsv, listCheckinEvents };
};

/** The live service, on the real models. Built on first use so requiring this file never opens a model. */
let live = null;
const liveService = () => {
    if (!live) {
        live = createCheckinService({
            Booking: require('./eventbooking.model'),
            Event: require('./event.model'),
            Checkin: require('./eventcheckin.model'),
            findStaff: async(id) => {
                const repo = require('../admin/admin.repository');
                return repo.findById(id);
            }
        });
    }
    return live;
};

/**
 * Roles that work the door and may read attendance. `attendance_admin` is the
 * mobile app's door account — the scanner and attendance, nothing else.
 */
const CHECKIN_STAFF = ['super_admin', 'events_admin', 'attendance_admin'];

module.exports = {
    createCheckinService,
    liveService,
    admissibility,
    describeSeat,
    seatCount,
    personAt,
    maskPhone,
    isOnToday,
    csvCell,
    ADMISSIBLE_CLAUSE,
    CHECKIN_STAFF
};
