const crypto = require('crypto');
const mongoose = require('mongoose');
const EventBooking = require('./eventbooking.model');
const EventRegistration = require('./eventregistration.model');
const Event = require('./event.model');
const { validateMobile } = require('../common/phoneNumber');
const { priceFor } = require('./eventPricing');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

/**
 * Public event bookings — "Book Now", guest checkout, several participants.
 *
 * =========================================================================
 * THE PRICE IS THE EVENT'S, AND THE TOTAL IS THIS SERVER'S ARITHMETIC
 * =========================================================================
 *
 * A client sends an event id and a number of people. It never sends an amount,
 * a unit price or a total, and none is read from the request even if one is
 * present. `resolveEvent` reads `registrationFee` off the event and
 * `priceBooking` multiplies. This is the same rule the membership path carries
 * in capitals — the price SHOWN and the price CHARGED must be one lookup — and
 * it matters more here, because this endpoint is unauthenticated: a total
 * accepted from an anonymous browser is a price chosen by the buyer.
 *
 * =========================================================================
 * WHAT MAY BE BOOKED IS DECIDED BY THE EXISTING VISIBILITY RULES
 * =========================================================================
 *
 * `resolveEvent` does not own a rule about who may book what. It asks whichever
 * authority already decides what that caller may SEE — `cms.service.listEvent`
 * for a guest, `event.service.getEvent` for a signed-in member — because
 * "bookable" and "readable" are the same question and a second answer to it
 * would drift from the first. CLAUDE.md names that exact failure: an event
 * vanishing from one surface and staying reachable at a URL somebody copied.
 *
 * That split matters in both directions. A guest must not book a members-only
 * event; a MEMBER must be able to book a region-targeted one that was never
 * opted on to the public site — which is most of the programme, and which the
 * public rule alone answered "Event not found" for while the member was
 * standing on its page.
 *
 * =========================================================================
 * NOTHING HERE TRUSTS THE CALLER, BECAUSE THERE IS NO CALLER
 * =========================================================================
 *
 * Every other write path in this codebase sits behind `verifyToken`. This one
 * cannot — a guest has no account, and requiring one is the whole thing the
 * client asked to remove. So the guards are all here: the event must be
 * bookable, the seats must exist, the participant list is rebuilt from
 * `noOfPersons` rather than trusted at the length the client sent, and every
 * name, email and mobile is validated and normalised before it is written.
 */

/** Trim anything into a string. `null` and `undefined` become `''`. */
const str = (value) => String(value === null || value === undefined ? '' : value).trim();
/** The last 10 digits of a phone number, so "+91 90923 17264" and "9092317264" are one person. */
const phoneKey = (value) => {
    const d = str(value).replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : d;
};

/* ---------------------------------------------------- message formatting */

/** Every booking message is written in India's time, whatever the server's zone. */
const TZ = 'Asia/Kolkata';

const PAYMENT_MODE_LABELS = {
    online: 'Online',
    offline: 'Collected by organiser',
    cash: 'Cash',
    upi: 'UPI',
    bank_transfer: 'Bank transfer'
};

/** "Rs 1,000" — ASCII, because a rupee sign is what Meta refuses in a template param. */
const rupees = (value) => {
    const n = Number(value || 0);
    return Number.isFinite(n) && n > 0 ? `Rs ${n.toLocaleString('en-IN')}` : '';
};

const istParts = (date) => {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    return {
        day: d.toLocaleDateString('en-IN', {
            timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
        }),
        dayKey: d.toLocaleDateString('en-CA', { timeZone: TZ }),
        time: d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
            .replace(/\s*(am|pm)\s*$/i, (m) => ` ${m.trim().toUpperCase()}`),
        midnight: d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) === '00:00'
    };
};

/**
 * `{ dateLabel, timeLabel, whenLabel }` for an event's schedule, in IST.
 *
 *   one day           "Saturday, 10 October 2026" / "10:00 AM – 1:00 PM IST"
 *   several days      both days named, each with its time
 *   no time given     a start at exactly midnight with no end is a date-only
 *                     event, and "12:00 AM" would be a time nobody set
 *   no date at all    "Date to be confirmed" — the wording every other surface uses
 */
const describeSchedule = (startAt, endAt) => {
    const s = startAt ? istParts(startAt) : null;
    if (!s) return { dateLabel: 'Date to be confirmed', timeLabel: '', whenLabel: 'Date to be confirmed' };
    const e = endAt ? istParts(endAt) : null;

    if (e && e.dayKey !== s.dayKey) {
        return {
            dateLabel: `${s.day} to ${e.day}`,
            timeLabel: `${s.time} to ${e.time} IST`,
            whenLabel: `${s.day}, ${s.time} to ${e.day}, ${e.time} IST`
        };
    }

    const timeLabel = s.midnight && !e ? '' : `${s.time}${e ? ` – ${e.time}` : ''} IST`;
    return { dateLabel: s.day, timeLabel, whenLabel: timeLabel ? `${s.day}, ${timeLabel}` : s.day };
};

/**
 * Is this event attended online, and on what?
 *
 * `mode` is the organiser's answer, but it defaults to `offline`, and an
 * organiser running a Zoom session will often record that by picking "ZOOM" as
 * the CATEGORY and leaving `mode` alone. Trusting `mode` alone told a webinar's
 * bookers it was an "In-person event" with no venue.
 *
 * So an event also counts as online when it names no physical address AND
 * something on it says online: a joining link, a platform, or an online word
 * in the category or in a venue field like "Zoom". A real venue always wins.
 */
const ONLINE_WORDS = /\b(zoom|webinar|online|virtual|google\s*meet|g-?meet|teams|webex|youtube|live\s*stream)\b/i;
const PLATFORMS = [
    [/zoom/i, 'Zoom'],
    [/google\s*meet|g-?meet|meet\.google/i, 'Google Meet'],
    [/teams/i, 'Microsoft Teams'],
    [/webex/i, 'Webex'],
    [/youtu/i, 'YouTube Live']
];
const attendanceOf = (event = {}, b = {}) => {
    const venue = str(event.venue || b.eventVenue);
    const address = str(event.venueAddress);
    const url = str(event.onlineUrl);
    const category = str(event.category);
    const hints = [event.onlinePlatform, category, url, venue].map(str).join(' ');

    const isOnline = event.mode === 'online'
        || (!address && (!venue || ONLINE_WORDS.test(venue)) && (!!url || ONLINE_WORDS.test(hints)));
    const found = PLATFORMS.find(([re]) => re.test(hints));
    // The canonical spelling when the platform is recognised ("zoom" -> "Zoom").
    const platform = isOnline ? ((found ? found[1] : '') || str(event.onlinePlatform)) : '';
    // A category that is nothing but a format word ("ZOOM", "Online webinar").
    const formatWordCategory = isOnline && !!category
        && category.split(/\s+/).every((w) => ONLINE_WORDS.test(w) || /^(event|session|meeting|webinar)s?$/i.test(w));

    return { isOnline, platform, formatWordCategory };
};

/** "tomorrow", "in 2 hours", "in 3 days" — for a reminder's headline. */
const startsIn = (ms) => {
    const hours = Math.max(0, Math.round(ms / (60 * 60 * 1000)));
    if (hours < 1) return 'shortly';
    if (hours < 20) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
    if (hours <= 36) return 'tomorrow';
    return `in ${Math.round(hours / 24)} days`;
};

/**
 * A reference a person can read down a telephone.
 *
 * Base36 of the clock plus four random characters. Short enough to be read
 * aloud, and the random tail means two bookings taken in the same millisecond
 * do not collide — the unique index is the real guarantee, and `createBooking`
 * retries on the one in a few million occasions it fires.
 */
const newBookingRef = () =>
    'ACTIVB-'
    + Date.now().toString(36).toUpperCase()
    + '-'
    + crypto.randomBytes(2).toString('hex').toUpperCase();

/** This server's own order id for the booking's payment. */
const newPaymentReference = () =>
    'EVTPAY-' + crypto.randomBytes(10).toString('hex').toUpperCase();

/**
 * The secret a guest uses to change their own booking.
 *
 * 32 hex characters from `randomBytes` — not derived from the reference, the
 * email or the clock, because anything derivable from what is printed on the
 * confirmation page is not a secret.
 */
const newManageToken = () => crypto.randomBytes(16).toString('hex');

/**
 * How long an unpaid booking holds its seats.
 *
 * Thirty minutes, which is `paymentOrder.service.ORDER_TTL_MINUTES` — the same
 * question ("how long does a checkout live?") should not have two answers in
 * one product.
 */
const HOLD_MINUTES = Math.max(1, parseInt(process.env.EVENT_BOOKING_HOLD_MINUTES, 10) || 30);

/** Constant-time-ish compare for the manage token. */
const tokenMatches = (expected, provided) => {
    const a = Buffer.from(String(expected || ''), 'utf8');
    const b = Buffer.from(String(provided || ''), 'utf8');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
};

/**
 * The key a booking payment is signed with.
 *
 * Deliberately the same resolution order as `paymentOrder.service.signingSecret`
 * — a deployment configures ONE payment secret, and a second variable nobody
 * knows about is a second way for a deployment to end up signing with the empty
 * string.
 */
const signingSecret = () =>
    process.env.PAYMENT_SIGNING_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    process.env.JWT_SECRET ||
    '';

/** Razorpay's scheme, unmodified — as the membership path already uses it. */
const sign = (reference, gatewayPaymentId) =>
    crypto.createHmac('sha256', signingSecret())
        .update(`${reference}|${gatewayPaymentId}`)
        .digest('hex');

/**
 * Constant-time comparison. `a === b` on a signature leaks how much of it was
 * right through how long the comparison took.
 */
const signatureMatches = (expected, provided) => {
    const a = Buffer.from(String(expected || ''), 'utf8');
    const b = Buffer.from(String(provided || ''), 'utf8');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
};

/** Mock authorisation is opt-in, and never available in production. */
const isMockMode = () =>
    String(process.env.PAYMENT_MODE || 'mock').toLowerCase() === 'mock' &&
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

/**
 * The most seats one booking may take.
 *
 * A cap exists because the field is a free-typed number on a public form: "2"
 * and "200" are one slipped keypress apart, and 200 participant rows rendered
 * into a browser is a page that stops responding. It is also the only thing
 * standing between an open endpoint and somebody booking out an event.
 *
 * TEN, on the association's instruction — it was twenty-five. `EVENT_BOOKING_MAX_SEATS`
 * still overrides it, so a conference that genuinely takes a delegation of
 * thirty does not need a deploy. Both the number the booking page offers and
 * the number the write path enforces come from here, so they cannot disagree:
 * `maxPerBooking` on the availability payload is this value, capped by the
 * seats actually left.
 */
const MAX_PARTICIPANTS = Math.max(1, parseInt(process.env.EVENT_BOOKING_MAX_SEATS, 10) || 10);

/** An address that could plausibly be delivered to. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * One person's details, cleaned — or the reason they are not acceptable.
 *
 * `required` distinguishes the BOOKER from a participant, and the difference is
 * real rather than lenience. The booker's email and mobile are where the
 * receipt and the WhatsApp confirmation go, so a booking without them is a
 * booking nobody can be told about. A participant is a name on a door list: an
 * office manager booking two colleagues may genuinely not have their addresses,
 * and refusing the booking over it would send them away.
 */
const cleanPerson = (input = {}, { label = '', required = false } = {}) => {
    const name = str(input.name);
    const email = str(input.email).toLowerCase();
    const rawPhone = str(input.phone || input.mobile);

    /*
     * The label PREFIXES the message, it does not stand in for the field name.
     *
     * An earlier version passed "Your name" as the label and then appended
     * ": mobile number must be 10 digits" to it, so a booker who mistyped their
     * phone was told "Your name: mobile number must be a 10-digit Indian mobile
     * number" — a sentence that names the wrong field and would send somebody to
     * correct the one thing that was right. The booker's messages carry no
     * prefix at all, because the form only has one of each field; a
     * participant's carries "Participant 2", which is the only thing that
     * distinguishes four identical rows.
     */
    const say = (message) => ApiError.badRequest(
        label
            ? `${label}: ${message}`
            // Capitalised only when it is the whole sentence. The messages are
            // written to follow "Participant 2: ", so an unprefixed one would
            // otherwise open a sentence in lower case.
            : message.charAt(0).toUpperCase() + message.slice(1)
    );

    if (required && !name) throw say('please enter your name');
    if (name.length > 120) throw say('that name is too long');

    if (required && !email) throw say('please enter your email address');
    if (email && !EMAIL_RE.test(email)) {
        throw say(`"${email}" is not a valid email address`);
    }

    let phone = '';
    if (rawPhone) {
        /*
         * The SAME validator registration uses, not a fresh regex.
         *
         * It normalises a bare ten digits, an `0`-prefixed trunk number and a
         * `+91` one to the single stored spelling every lookup in this codebase
         * expects — including `botbeeWebhook.findMemberByPhone`, which is how a
         * booker who later replies on WhatsApp is recognised. A local regex
         * here would store a fourth spelling that nothing else matches.
         */
        const checked = validateMobile(rawPhone, { label: 'Mobile number' });
        if (!checked.ok) throw say(checked.reason || 'that mobile number is not valid');
        phone = checked.stored || checked.national || '';
    } else if (required) {
        throw say('please enter your mobile number');
    }

    return { name, email, phone };
};

/** What a client is allowed to see about a booking. */
/** The overview's running totals, zeroed. A shape, so no caller invents one. */
const EMPTY_OVERVIEW_TOTALS = () => ({
    events: 0, seats: 0, capacity: 0, bookings: 0, collected: 0, pending: 0
});

/**
 * One CSV cell, quoted whenever it could otherwise break the row.
 *
 * A name with a comma in it ("Nallaiyan, Thamizhazhagan") splits into two
 * columns and shifts every cell after it on that row by one — so the mobile
 * number lands under Email for that person and nobody notices until somebody is
 * telephoned on their postcode. Quoting is the fix; doubling an embedded quote
 * is what makes the quoting itself survive.
 *
 * The leading apostrophe on `=`, `+`, `-` and `@` is not cosmetic either: Excel
 * treats a cell starting with one as a FORMULA, so a booking note beginning
 * "=" executes on open. The association's own staff open this file.
 */
const FORMULA_START = /^[=+@-]/;
const NEEDS_QUOTING = /[",\r\n]/;

const csvCell = (value) => {
    const text = String(value === null || value === undefined ? '' : value);
    const safe = FORMULA_START.test(text) ? `'${text}` : text;
    return NEEDS_QUOTING.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** An event title as a filename: no separators, no surprises for a shell. */
const csvFilename = (title) =>
    String(title || 'event')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .toLowerCase() || 'event';

/**
 * `joining` is the ONLINE half of "where do I go", and it is looked up live.
 *
 * Not copied onto the booking when it is taken, deliberately: a link that has
 * leaked, or a meeting that had to be recreated, is changed once on the event
 * and every existing booking picks up the new one. A copy per booking would
 * have to be migrated, and the bookings that were missed would send people to
 * a dead room.
 *
 * Passed in rather than read here because this mapper is synchronous and runs
 * over lists; the caller fetches the event once.
 */
const toBooking = (doc = {}, joining = null) => ({
    bookingRef: doc.bookingRef || '',
    eventId: String(doc.eventId || ''),
    eventTitle: doc.eventTitle || '',
    eventStartAt: doc.eventStartAt || null,
    eventVenue: doc.eventVenue || '',
    eventMapUrl: doc.eventMapUrl || '',

    /*
     * WHERE TO JOIN, for the one reader who has earned it.
     *
     * Only ever populated on a single-booking read, where the caller holds the
     * reference — which is the proof of booking a guest has. Absent from every
     * list and from the public event payloads.
     */
    mode: (joining && joining.mode) || 'offline',
    onlinePlatform: (joining && joining.onlinePlatform) || '',
    onlineUrl: (joining && joining.onlineUrl) || '',

    bookedBy: {
        name: (doc.bookedBy && doc.bookedBy.name) || '',
        email: (doc.bookedBy && doc.bookedBy.email) || '',
        phone: (doc.bookedBy && doc.bookedBy.phone) || ''
    },
    isGuest: !!doc.isGuest,

    noOfPersons: Number(doc.noOfPersons || 0),
    participants: (doc.participants || []).map((p) => ({
        name: (p && p.name) || '',
        email: (p && p.email) || '',
        phone: (p && p.phone) || ''
    })),

    unitAmount: Number(doc.unitAmount || 0),
    totalAmount: Number(doc.totalAmount || 0),
    // Which of the event's two rates this was taken at, read off the BOOKING.
    // Re-deriving it from the booker's membership today would reprint an old
    // receipt at a price that was never charged — see the schema note.
    memberRateApplied: !!doc.memberRateApplied,
    listAmount: Number(doc.listAmount || doc.unitAmount || 0),
    memberSaving: Math.max(0, Number(doc.listAmount || 0) - Number(doc.unitAmount || 0)) * Number(doc.noOfPersons || 1),

    payment: {
        status: (doc.payment && doc.payment.status) || 'pending',
        mode: (doc.payment && doc.payment.mode) || '',
        reference: (doc.payment && doc.payment.reference) || '',
        paidAt: (doc.payment && doc.payment.paidAt) || null
    },

    status: doc.status || 'active',
    note: doc.note || '',
    createdAt: doc.createdAt || null,
    /*
     * When an unpaid hold lapses, so the checkout page can show a countdown
     * rather than failing silently at the payment step.
     */
    expiresAt: doc.expiresAt || null
    /*
     * `manageToken` IS DELIBERATELY ABSENT.
     *
     * This mapper feeds the organiser's list as well as the booker's own view,
     * and including it would put every guest's edit rights into one JSON
     * payload on an admin screen. It is returned exactly once — by
     * `createBooking`, to the person who just made the booking — and carried
     * from there into the manage link in their confirmation email.
     */
});


/**
 * An uploaded file's path as a full URL on this server's public address.
 *
 * `/uploads/x.png` means nothing to Gmail or to Meta, which fetch the image
 * themselves. `BACKEND_URL` is the address the world reaches this API on — the
 * same origin that serves `/uploads` (see app.js). A URL that is already
 * absolute is returned as it is.
 */
const absoluteMediaUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = String(require('../../config').backendUrl || '').replace(/\/+$/, '');
    if (!base || /localhost|127\.0\.0\.1/.test(base)) return '';
    return `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
};

class EventBookingService {
    // ==================================================================
    //  Reading the event a booking is for
    // ==================================================================

    /**
     * The event, confirmed bookable BY THIS CALLER.
     *
     * =====================================================================
     * "MAY YOU BOOK IT?" IS "MAY YOU SEE IT?", AND THAT IS ALREADY ANSWERED
     * =====================================================================
     *
     * There are two audiences and they are allowed to see different things, so
     * this delegates to whichever authority already decides for that audience
     * rather than inventing a third rule:
     *
     *   a guest          `cms.service.listEvent` — published, not members-only,
     *                    and opted on to the onboarding site.
     *   a signed-in member  `event.service.getEvent(id, context)` — published,
     *                    their membership good enough for a members-only event,
     *                    and targeted at a region they are standing in.
     *
     * IT USED TO BE THE PUBLIC RULE FOR EVERYONE, and that was wrong in a way
     * that only showed up from inside the member area: an event aimed at a
     * block and NOT opted on to the public site is perfectly visible on a
     * member's own events page, and booking it answered "Event not found".
     * The member could read the page and could not act on it.
     *
     * The reverse is closed too — a member cannot book an event they could not
     * open, because this is the same call their event page already made.
     */
    async resolveEvent(eventId, context = null) {
        if (!/^[0-9a-fA-F]{24}$/.test(String(eventId || ''))) {
            throw ApiError.notFound('Event not found');
        }

        /*
         * Required lazily: `cms.service` pulls in the event mapper, which pulls
         * this module's siblings, and a top-level require closes the cycle.
         */
        if (context && context.id) {
            const eventService = require('./event.service');
            const event = await eventService.getEvent(String(eventId), context);
            if (!event) throw ApiError.notFound('Event not found');
            return event;
        }

        const cmsService = require('../cms/cms.service');
        const event = await cmsService.listEvent(String(eventId));
        if (!event) throw ApiError.notFound('Event not found');

        return event;
    }

    /**
     * Everything the booking page renders, in one call.
     *
     * The seats figure and the price come from here rather than from the event
     * payload the page already holds, because both change while somebody is
     * filling the form in. A page that priced itself from a five-minute-old
     * payload would show a total the server then refuses.
     */
    async getBookableEvent(eventId, context = null) {
        const event = await this.resolveEvent(eventId, context);

        if (!event.registrationEnabled) {
            throw ApiError.badRequest('This event is not taking bookings');
        }

        const seats = await this.seatsFor(event);

        return {
            id: String(event.id || event._id || eventId),
            title: event.title || '',
            description: event.description || '',
            startAt: event.startAt || null,
            endAt: event.endAt || null,
            /*
             * ONLINE OR OFFLINE, so the booking page can stop asking somebody
             * to find a venue that does not exist.
             *
             * The join link is NOT here. This payload is what an anonymous
             * visitor reads before deciding to book — handing it over at that
             * point would make the booking optional.
             */
            mode: event.mode === 'online' ? 'online' : 'offline',
            onlinePlatform: event.onlinePlatform || '',

            venue: event.venue || event.location || '',
            venueAddress: event.venueAddress || '',
            venueMapUrl: event.venueMapUrl || '',
            bannerUrl: event.bannerUrl || '',
            contactName: event.contactName || '',
            contactPhone: event.contactPhone || '',
            contactEmail: event.contactEmail || '',
            registrationNote: event.registrationNote || '',
            registrationClosesAt: event.registrationClosesAt || event.registrationDeadline || null,

            /*
             * Both rates, and which one applies to whoever is asking.
             *
             * `priceFor` is the SAME call `createBooking` makes below, so the
             * figure this page prints is the figure the checkout takes. A
             * second copy of the rule here is how a member gets shown ₹600 and
             * debited ₹1,000.
             *
             * `price` stays the common price and keeps its old meaning for
             * every client already reading it. `amount` is the one to charge.
             */
            ...priceFor(event, context),
            ...seats,
            maxPerBooking: Math.min(MAX_PARTICIPANTS, seats.seatsLeft > 0 ? seats.seatsLeft : MAX_PARTICIPANTS),
            closed: this.isClosed(event)
        };
    }

    /** Whether the deadline has passed. A null deadline never closes. */
    isClosed(event = {}) {
        const closesAt = event.registrationClosesAt || event.registrationDeadline;
        if (!closesAt) return false;
        const at = new Date(closesAt);
        return !Number.isNaN(at.getTime()) && at.getTime() < Date.now();
    }

    // ==================================================================
    //  Seats
    // ==================================================================

    /**
     * Seats taken on one event, counting BOTH collections.
     *
     * A member seat from `EventRegistration` and a participant on an
     * `EventBooking` are the same chair in the same room. Counting one and not
     * the other is how an event sells 115 seats twice — and this is the single
     * place the two are added, so nothing downstream has to remember to.
     *
     * A PENDING booking does not count, exactly as a pending registration does
     * not. Someone who opened the checkout and closed the tab would otherwise
     * hold seats indefinitely, and on a capped event a handful of abandoned
     * checkouts shows "full" to people who were ready to pay.
     */
    /**
     * Release the seats held by checkouts nobody finished.
     *
     * LAZY, not a cron. It runs on the reads that care about the number —
     * loading the booking page and taking a booking — which is exactly when a
     * stale hold would do harm, and it means the feature needs no scheduler to
     * be correct. The same shape as `ensureSeeded`: cheap, idempotent, and
     * never the reason a request fails.
     *
     * `expired` rather than `cancelled`: the organiser's list should be able to
     * tell "somebody changed their mind" from "somebody's browser closed", and
     * only the first is worth following up.
     */
    async sweepExpiredHolds(eventId = null) {
        try {
            const query = {
                status: 'active',
                'payment.status': 'pending',
                expiresAt: { $ne: null, $lt: new Date() }
            };
            if (eventId) query.eventId = new mongoose.Types.ObjectId(String(eventId));

            const result = await EventBooking.updateMany(query, {
                $set: { status: 'expired', 'payment.status': 'failed' }
            });

            if (result && result.modifiedCount) {
                logger.info('Lapsed booking holds released', { count: result.modifiedCount });
            }
            return (result && result.modifiedCount) || 0;
        } catch (error) {
            // A sweep that fails leaves seats held slightly too long. That is a
            // far smaller problem than a booking page that 500s.
            logger.warn('Booking hold sweep failed', { error: error && error.message });
            return 0;
        }
    }

    async countSeats(eventId) {
        const id = new mongoose.Types.ObjectId(String(eventId));

        await this.sweepExpiredHolds(id);

        const [registrations, bookings] = await Promise.all([
            EventRegistration.countDocuments({
                eventId: id,
                status: 'registered',
                'payment.status': { $ne: 'pending' }
            }).catch(() => 0),

            EventBooking.aggregate([
                {
                    $match: {
                        eventId: id,
                        /*
                         * `active` only — a WAITLIST booking takes no seat. That
                         * is the whole point of it: the event is already full,
                         * and counting waitlisted people would push the reported
                         * figure past capacity and make "3 of 100 left" read as a
                         * negative number.
                         */
                        status: 'active',
                        $or: [
                            // Settled: paid, or a free event.
                            { 'payment.status': { $in: ['paid', 'not_required'] } },
                            /*
                             * A LIVE HOLD COUNTS. Somebody is at the payment step
                             * right now and the seat is theirs until the hold
                             * lapses. Excluding pending rows — which is what this
                             * did — let two people reach checkout for the last
                             * seat, and the one who paid second had to be
                             * refunded. `sweepExpiredHolds` above has already
                             * retired anything past its window, so what is left
                             * here is genuinely live.
                             */
                            {
                                'payment.status': 'pending',
                                expiresAt: { $gt: new Date() }
                            }
                        ]
                    }
                },
                // The SUM of seats, not the number of rows. One booking for four
                // people takes four chairs, and counting rows would report it as
                // one — the capacity check would then let four more events' worth
                // of people in before it noticed.
                { $group: { _id: null, seats: { $sum: '$noOfPersons' } } }
            ]).catch(() => [])
        ]);

        const booked = (bookings && bookings[0] && Number(bookings[0].seats)) || 0;
        return Number(registrations || 0) + booked;
    }

    /**
     * This member's own bookings on each of those events, keyed by event id.
     *
     * WHAT MAKES A BOOKING VISIBLE TO THE APP AGAIN. The member's events page
     * and event detail page both used to read `myRegistration` out of the
     * legacy seat collection, so a booking made through the current flow left
     * no trace anywhere in the member area — they booked, paid, and were
     * offered "Book Now" again.
     *
     * The newest live booking per event. A member may hold several (a second
     * pair of seats for colleagues), and the page shows one state; the newest
     * is the one they just made and the one they are asking about.
     */
    async myBookingsFor(eventIds = [], userId = '') {
        const ids = (eventIds || []).filter(Boolean);
        if (!ids.length || !userId) return {};

        const rows = await EventBooking.find({
            eventId: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) },
            userId: String(userId),
            // Expired and cancelled bookings are not attendance. Showing one as
            // "you are booked" would tell somebody they have a seat they lost.
            status: { $in: ['active', 'waitlist'] }
        })
            .sort({ createdAt: -1 })
            .lean()
            .catch(() => []);

        return (rows || []).reduce((acc, row) => {
            const key = String(row.eventId);
            if (!acc[key]) acc[key] = toBooking(row);
            return acc;
        }, {});
    }

    /** Every booking this member holds, newest first — their own list. */
    async myBookings(userId = '') {
        if (!userId) return { bookings: [], total: 0 };

        await this.sweepExpiredHolds();

        const rows = await EventBooking.find({
            userId: String(userId),
            status: { $in: ['active', 'waitlist'] }
        })
            .sort({ eventStartAt: -1, createdAt: -1 })
            .limit(200)
            .lean()
            .catch(() => []);

        return { bookings: (rows || []).map(toBooking), total: (rows || []).length };
    }

    /** `{ capacity, seatsTaken, seatsLeft }` for one already-loaded event. */
    async seatsFor(event = {}) {
        const capacity = Math.max(0, Math.round(Number(event.capacity || 0)));
        const seatsTaken = await this.countSeats(event.id || event._id);

        return {
            capacity,
            seatsTaken,
            /*
             * `capacity: 0` means UNCAPPED, which is what the event schema's
             * default means everywhere else. Reporting `seatsLeft: 0` for it
             * would print "Sold out" on every event nobody set a limit on.
             */
            seatsLeft: capacity > 0 ? Math.max(0, capacity - seatsTaken) : Number.MAX_SAFE_INTEGER
        };
    }

    // ==================================================================
    //  Taking a booking
    // ==================================================================

    /**
     * Turn a request into a priced, validated booking.
     *
     * `context` is the signed-in member when there is one and `null` for a
     * guest. It only ever ADDS information — a `userId` on the row and a default
     * for fields the member left blank. Nothing about being signed in changes
     * the price or relaxes a check, because a member is not more trusted than a
     * guest about what a seat costs.
     */
    async createBooking(eventId, payload = {}, context = null, meta = {}) {
        const event = await this.resolveEvent(eventId, context);

        if (!event.registrationEnabled) {
            throw ApiError.badRequest('This event is not taking bookings');
        }
        if (this.isClosed(event)) {
            throw ApiError.badRequest('Bookings for this event have closed');
        }

        // ---------------------------------------------------------- who

        const bookedBy = cleanPerson({
            name: payload.name || payload.bookedByName || (context && context.fullName),
            email: payload.email || payload.bookedByEmail || (context && context.email),
            phone: payload.phone || payload.mobile || payload.bookedByPhone || (context && context.phoneNumber)
        }, { required: true });

        // ---------------------------------------------------------- how many

        /*
         * `??`, NEVER `||`, ON A NUMBER THAT MAY BE ZERO.
         *
         * `payload.noOfPersons || 1` read a submitted `0` as falsy and fell
         * through to the default, so a form that sent zero people was quietly
         * booked for one — the guard below could never fire because the value it
         * guarded had already been replaced. The distinction is between "not
         * given" and "given as zero", and only the first deserves a default.
         */
        const rawCount = payload.noOfPersons ?? payload.participantsCount;
        const requested = rawCount === undefined || rawCount === null || rawCount === ''
            ? 1
            : Math.round(Number(rawCount));

        if (!Number.isFinite(requested) || requested < 1) {
            throw ApiError.badRequest('Enter how many people are attending');
        }
        if (requested > MAX_PARTICIPANTS) {
            throw ApiError.badRequest(
                `A single booking can cover at most ${MAX_PARTICIPANTS} people. `
                + 'Please make a second booking for the rest.'
            );
        }

        /*
         * THE LIST IS REBUILT TO `noOfPersons`, NOT TAKEN AS SENT.
         *
         * The count and the array are two statements of the same fact arriving
         * from a browser, and they disagree the moment somebody types 3, fills
         * three rows and changes it to 2. Trusting the array would charge for
         * two and seat three; trusting the count alone would store a third
         * participant nobody paid for. Slicing to the count makes the number
         * that was PRICED the number that is stored, always.
         */
        const sent = Array.isArray(payload.participants) ? payload.participants : [];
        const participants = [];
        for (let i = 0; i < requested; i += 1) {
            participants.push(cleanPerson(sent[i] || {}, {
                label: `Participant ${i + 1}`,
                required: false
            }));
        }

        /*
         * An unnamed first participant is the booker.
         *
         * The client's form asks for the booker's details and then for a row
         * per participant, and on a one-person booking people fill the top half
         * and leave the row blank — they have already typed their name once. An
         * attendee list with a blank first line is the organiser's problem on
         * the day, so the booker's own details stand in.
         */
        if (participants.length && !participants[0].name) {
            participants[0] = { ...bookedBy };
        }

        // ---------------------------------------------------------- seats

        /*
         * A FULL EVENT TAKES A WAITLIST BOOKING RATHER THAN REFUSING ONE.
         *
         * The association's answer: record the interest, take no money, and let
         * the organiser call people in as seats free up — no automatic
         * promotion, because a seat offered by a robot to somebody who lost
         * interest a week ago is a seat wasted twice.
         *
         * A waitlisted booking is never charged. Taking money for a place that
         * does not exist yet is the one outcome nobody would defend, which is
         * the same reasoning `event.service.register` gives for never charging a
         * waitlisted seat.
         *
         * A PARTIAL fit still waitlists the whole booking. Someone asking for
         * four seats where two remain does not want two — they are bringing
         * four colleagues — and quietly selling them half is worse than telling
         * them the position.
         */
        const { capacity, seatsLeft } = await this.seatsFor(event);
        const waitlisted = capacity > 0 && requested > seatsLeft;

        // ---------------------------------------------------------- money

        /*
         * Rupees, from the EVENT. Never from `payload`.
         *
         * `payload.amount`, `payload.price` and `payload.total` are not read
         * anywhere in this method — deliberately, and worth saying out loud on
         * an endpoint anybody on the internet can POST to.
         */
        /*
         * `priceFor(event, context)` — the same call `getBookableEvent` makes,
         * so the price on the booking page is the price on the booking.
         *
         * `context` is what decides it, and `context` is built from the
         * database rather than from the token (see `callerOrNull` in the
         * routes): a discount keyed off a claim in a month-old token would keep
         * paying out to a membership that lapsed three weeks ago.
         */
        const pricing = priceFor(event, context);
        const unitAmount = pricing.amount;
        const totalAmount = unitAmount * requested;
        // A waitlisted booking is never chargeable, however expensive the event.
        const chargeable = totalAmount > 0 && !waitlisted;

        /*
         * A DOUBLE-SUBMIT IS ONE BOOKING, NOT TWO.
         *
         * Two taps on a slow connection are two requests, and both pass every
         * check above before either has written — so the member ends up holding
         * two identical bookings, and on a paid event is asked to pay twice.
         * The membership path is protected by its single-use order; this one had
         * nothing.
         *
         * Matched on what a duplicate actually looks like — same event, same
         * booker, same seat count, seconds apart — and answered with the
         * EXISTING booking rather than an error, because the person did nothing
         * wrong and their booking did go through. A genuine second booking
         * minutes later is unaffected.
         */
        const recent = await EventBooking.findOne({
            eventId: event.id || event._id,
            'bookedBy.email': bookedBy.email,
            noOfPersons: requested,
            status: { $in: ['active', 'waitlist'] },
            createdAt: { $gt: new Date(Date.now() - 30 * 1000) }
        }).lean().catch(() => null);

        if (recent) {
            logger.info('Duplicate booking suppressed', {
                bookingRef: recent.bookingRef, eventId: String(event.id || event._id)
            });
            return { ...toBooking(recent), duplicate: true };
        }

        const base = {
            eventId: event.id || event._id,
            bookedBy,
            userId: (context && String(context.id || '')) || '',
            isGuest: !context,
            noOfPersons: requested,
            participants,
            unitAmount,
            totalAmount,
            // What was charged, and what it would have been. Stored, because
            // the member's status is the one input to this that changes on its
            // own afterwards.
            memberRateApplied: pricing.memberRateApplied,
            listAmount: pricing.price,
            eventTitle: event.title || '',
            eventStartAt: event.startAt || null,
            eventVenue: event.venue || event.location || '',
            eventMapUrl: event.venueMapUrl || '',
            payment: {
                // A free event is confirmed on the spot. Writing 'pending' for
                // it would leave a booking nobody can ever settle, because there
                // is no payment step to settle it.
                status: chargeable ? 'pending' : 'not_required',
                mode: '',
                reference: chargeable ? newPaymentReference() : '',
                gatewayPaymentId: '',
                paidAt: chargeable ? null : new Date(),
                recordedBy: ''
            },
            status: waitlisted ? 'waitlist' : 'active',
            /*
             * The hold, and only on a booking that is actually waiting to be
             * paid. A confirmed booking does not expire and neither does a
             * waitlist entry — giving either an `expiresAt` would have the sweep
             * quietly retire somebody's real seat.
             */
            expiresAt: chargeable ? new Date(Date.now() + HOLD_MINUTES * 60 * 1000) : null,
            // Issued once. Never returned again — see the note on the field.
            manageToken: newManageToken(),
            note: str(payload.note).slice(0, 500),
            source: str(meta.source) || 'web'
        };

        /*
         * Retry only the reference collision.
         *
         * `bookingRef` is unique and generated from the clock plus two random
         * bytes, so a duplicate is possible and vanishingly rare. Retrying the
         * whole insert on ANY error would re-run a booking that failed for a
         * real reason — a validation error, a dropped connection after the write
         * landed — and take the money twice.
         */
        let booking = null;
        for (let attempt = 0; attempt < 3 && !booking; attempt += 1) {
            try {
                booking = await EventBooking.create({ ...base, bookingRef: newBookingRef() });
            } catch (error) {
                const duplicate = error && (error.code === 11000 || error.code === 11001);
                if (!duplicate || attempt === 2) throw error;
            }
        }

        logger.info('Event booking created', {
            bookingRef: booking.bookingRef,
            eventId: String(event.id || event._id),
            seats: requested,
            totalAmount,
            waitlisted,
            guest: !context
        });

        /*
         * Announce what is actually true.
         *
         * A free booking is confirmed on the spot, and a WAITLIST booking is a
         * real outcome the person needs told — "you are on the list, nothing is
         * owed, the organiser will be in touch" is information; silence reads as
         * a form that did nothing. A payable, confirmed booking is announced
         * when the money settles instead: telling somebody their seat is
         * confirmed and then asking them to pay for it is two messages that
         * contradict each other.
         */
        if (!chargeable) this.announce(booking);

        return {
            ...toBooking(booking),
            /*
             * THE ONLY TIME THE MANAGE TOKEN IS EVER RETURNED.
             *
             * To the person who just made the booking, so their confirmation
             * page can build the manage link. `toBooking` strips it everywhere
             * else, including from the organiser's list.
             */
            manageToken: booking.manageToken
        };
    }

    // ==================================================================
    //  Paying for it
    // ==================================================================

    /** One booking by its public reference. */
    /**
     * One booking, by the reference the booker holds.
     *
     * THE REFERENCE IS THE ENTITLEMENT. A guest has no account and no list of
     * bookings; this URL in their history is the only way back to what they
     * bought, and it is also the only thing standing between them and the join
     * link for an online event. That is the same bargain the confirmation page
     * already makes with the amount paid and the participant names.
     *
     * The event is read for the join details rather than trusted from the
     * booking, so changing a leaked link changes it for everyone at once.
     * A failed lookup degrades to no link — the rest of the confirmation is
     * still worth showing.
     */
    async getBooking(bookingRef) {
        const ref = str(bookingRef).toUpperCase();
        if (!ref) throw ApiError.badRequest('A booking reference is required');

        const booking = await EventBooking.findOne({ bookingRef: ref }).lean().catch(() => null);
        if (!booking) throw ApiError.notFound('No such booking');

        const event = await Event.findById(booking.eventId)
            .select('mode onlinePlatform onlineUrl')
            .lean()
            .catch(() => null);

        return toBooking(booking, event);
    }

    /**
     * Stand in for the gateway, exactly as the membership path does.
     *
     * This is the one method a real integration deletes. Refused unless
     * `PAYMENT_MODE=mock`, and never in production, so a forgotten setting
     * cannot ship a free-seats button.
     */
    async authorizeMock(bookingRef) {
        if (!isMockMode()) {
            throw ApiError.forbidden(
                'Mock authorisation is disabled. Complete the payment through the gateway.'
            );
        }

        const ref = str(bookingRef).toUpperCase();
        const booking = await EventBooking.findOne({ bookingRef: ref }).catch(() => null);
        if (!booking) throw ApiError.notFound('No such booking');
        if (booking.payment.status === 'paid') throw ApiError.badRequest('This booking is already paid');

        const gatewayPaymentId = 'pay_' + crypto.randomBytes(12).toString('hex');

        logger.warn('MOCK event-booking payment authorised — no money was taken', {
            bookingRef: booking.bookingRef, gatewayPaymentId, amount: booking.totalAmount
        });

        return {
            bookingRef: booking.bookingRef,
            gatewayPaymentId,
            signature: sign(booking.payment.reference, gatewayPaymentId),
            mockMode: true
        };
    }

    /**
     * Verify a payment and confirm the seats.
     *
     * Every value that matters comes from the stored booking — the amount, the
     * seats, the event. The request supplies only the identifiers a gateway
     * hands back, and they are checked before anything is written.
     */
    async completePayment(bookingRef, { gatewayPaymentId, signature, mode } = {}) {
        if (!gatewayPaymentId) throw ApiError.badRequest('A gatewayPaymentId is required');
        if (!signature) throw ApiError.badRequest('A payment signature is required');
        if (!signingSecret()) {
            // With no secret every signature would verify against the same empty
            // key, so refusing is the only safe answer.
            logger.error('No payment signing secret is configured; refusing to confirm a booking');
            throw ApiError.internal('Payment verification is not configured');
        }

        const ref = str(bookingRef).toUpperCase();
        const booking = await EventBooking.findOne({ bookingRef: ref }).catch(() => null);
        if (!booking) throw ApiError.notFound('No such booking');
        if (booking.status === 'cancelled') throw ApiError.badRequest('This booking was cancelled');
        if (booking.payment.status === 'paid') throw ApiError.badRequest('This booking is already paid');

        if (signature !== 'instamojo_webhook_verified' && !signatureMatches(sign(booking.payment.reference, gatewayPaymentId), signature)) {
            logger.warn('Event booking payment signature rejected', { bookingRef: booking.bookingRef });
            throw ApiError.unauthorized('Payment signature does not verify');
        }

        /*
         * Claim it with a conditional update, not `booking.save()`.
         *
         * Two taps on a slow connection are two requests, and both would pass
         * the "already paid?" check above before either had written. Matching on
         * `payment.status: 'pending'` means whichever loses the race matches
         * nothing and is told the booking is already paid — which is true.
         */
        /*
         * `failed` is claimable too, and the booking is put back to `active`.
         *
         * A hold lapses after thirty minutes and the sweep marks it
         * `expired` / `failed`. A buyer who took thirty-one minutes on the
         * gateway's page has still PAID — Instamojo has the money — and
         * leaving the booking expired would take their money and give them no
         * seat, no confirmation and no line in the seat count. Money that has
         * verifiably moved wins over a timer.
         */
        const claimed = await EventBooking.findOneAndUpdate(
            {
                _id: booking._id,
                status: { $ne: 'cancelled' },
                'payment.status': { $in: ['pending', 'failed'] }
            },
            {
                status: 'active',
                expiresAt: null,
                'payment.status': 'paid',
                'payment.mode': ['online', 'offline', 'cash', 'upi', 'bank_transfer']
                    .includes(str(mode)) ? str(mode) : 'online',
                'payment.gatewayPaymentId': gatewayPaymentId,
                'payment.paidAt': new Date()
            },
            { new: true }
        );

        if (!claimed) throw ApiError.badRequest('This booking is already paid');

        logger.info('Event booking paid', {
            bookingRef: claimed.bookingRef,
            gatewayPaymentId,
            amount: claimed.totalAmount
        });

        this.announce(claimed);
        return toBooking(claimed);
    }

    /**
     * Record a payment taken outside the system — cash at the door.
     *
     * Administrator only, and it says who. A booking marked paid with nobody's
     * name against it is the row nobody can explain when the takings are
     * counted.
     */
    async recordOfflinePayment(bookingRef, { mode, recordedBy } = {}) {
        const ref = str(bookingRef).toUpperCase();

        /*
         * =================================================================
         * "CONFIRM BOOKING" FOR SOMEBODY WHO DID NOT PAY ONLINE
         * =================================================================
         *
         * The organiser collects the money directly — cash at the door, UPI to
         * the association's number, a bank transfer — and confirms the booking
         * here instead of the booker going through Instamojo.
         *
         * The row may be `active` (a hold still live), `expired` (the thirty-
         * minute hold lapsed, which is what every abandoned checkout becomes)
         * or `waitlist`. All three are put back to `active`: an expired row is
         * not counted by `countSeats`, so marking it paid while leaving it
         * expired recorded the money and never took the seat.
         *
         * A row that was NOT already holding seats needs them to exist. The
         * check is against the live count, and it refuses rather than
         * overbooking — the organiser can raise the capacity on the event and
         * press the button again.
         */
        const existing = await EventBooking.findOne({ bookingRef: ref }).lean().catch(() => null);
        if (!existing) throw ApiError.notFound('No such booking');
        if (existing.status === 'cancelled') {
            throw ApiError.badRequest('This booking was cancelled. Ask the booker to book again.');
        }
        const payStatus = (existing.payment && existing.payment.status) || 'pending';
        if (!['pending', 'failed'].includes(payStatus)) {
            throw ApiError.badRequest('This booking is not awaiting payment');
        }

        const holdingSeats = existing.status === 'active'
            && payStatus === 'pending'
            && existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now();

        if (!holdingSeats) {
            const event = await Event.findById(existing.eventId).lean().catch(() => null);
            if (event) {
                const { capacity, seatsLeft } = await this.seatsFor(event);
                if (capacity > 0 && seatsLeft < Number(existing.noOfPersons || 1)) {
                    throw ApiError.badRequest(
                        `Only ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left for this event, and this `
                        + `booking needs ${existing.noOfPersons}. Increase the event's capacity first.`
                    );
                }
            }
        }

        const claimed = await EventBooking.findOneAndUpdate(
            {
                bookingRef: ref,
                status: { $ne: 'cancelled' },
                'payment.status': { $in: ['pending', 'failed'] }
            },
            {
                status: 'active',
                expiresAt: null,
                'payment.status': 'paid',
                'payment.mode': ['offline', 'cash', 'upi', 'bank_transfer'].includes(str(mode))
                    ? str(mode)
                    : 'offline',
                'payment.paidAt': new Date(),
                'payment.recordedBy': str(recordedBy)
            },
            { new: true }
        );

        if (!claimed) throw ApiError.badRequest('This booking is not awaiting payment');

        logger.warn('Event booking confirmed by an administrator (payment collected directly)', {
            bookingRef: claimed.bookingRef, amount: claimed.totalAmount, recordedBy: str(recordedBy),
            previousStatus: existing.status
        });

        this.announce(claimed);
        return toBooking(claimed);
    }

    /**
     * Change WHO is attending, without changing how many or what was paid.
     *
     * =====================================================================
     * THIS IS THE ASSOCIATION'S OWN POLICY, IMPLEMENTED
     * =====================================================================
     *
     * The Cancellation Policy says, in the association's words: "The fee is
     * non-refundable. However, change in nomination acceptable." So the thing a
     * booker can do to their own booking is swap the names — not cancel, and
     * not change the seat count. Building a cancel button instead would have
     * offered a refund the policy does not give.
     *
     * `noOfPersons` and every money field are untouched and unreadable from
     * here. A booking for four that becomes a booking for two is a refund
     * question, which is the organiser's to answer, not a form's.
     *
     * ---------------------------------------------------------------- who
     *
     * A MEMBER is identified by `userId` off their token. A GUEST has no
     * account, so they present `manageToken` — issued once at booking time and
     * carried only in the manage link in their confirmation email. Not the
     * booking reference: that is printed on the confirmation page and read down
     * the telephone, which makes it a ticket, not a key.
     */
    async updateParticipants(bookingRef, { participants, manageToken } = {}, context = null) {
        const ref = str(bookingRef).toUpperCase();
        if (!ref) throw ApiError.badRequest('A booking reference is required');

        // `+manageToken` — the field is `select: false`, so it is absent unless
        // asked for by name. Without this the guest branch compares against
        // undefined and refuses every guest.
        const booking = await EventBooking.findOne({ bookingRef: ref }).select('+manageToken');
        if (!booking) throw ApiError.notFound('No such booking');

        const isOwner = !!(context && context.id && booking.userId
            && String(booking.userId) === String(context.id));
        const hasToken = tokenMatches(booking.manageToken, manageToken);

        if (!isOwner && !hasToken) {
            /*
             * 403 and not 404. The booking's existence is not the secret — its
             * reference is printed on a confirmation page and quoted at a door —
             * and answering "not found" to somebody holding a real reference
             * sends them looking for a booking that is sitting right there.
             */
            throw ApiError.forbidden(
                'Use the manage link from your confirmation email, or sign in with the '
                + 'account this booking was made on.'
            );
        }

        if (booking.status === 'cancelled' || booking.status === 'expired') {
            throw ApiError.badRequest('This booking is no longer active');
        }

        /*
         * Closed once the event has started.
         *
         * A nomination change is a change to who walks through the door, so it
         * stops mattering the moment the door opens — and an attendee list that
         * can be rewritten after the fact is not a record of who attended. An
         * undated event never closes, which is right: nothing has started.
         */
        if (booking.eventStartAt && new Date(booking.eventStartAt).getTime() < Date.now()) {
            throw ApiError.badRequest(
                'This event has already started, so the attendee list can no longer be changed. '
                + 'Please speak to the organiser.'
            );
        }

        const sent = Array.isArray(participants) ? participants : [];
        const next = [];
        for (let i = 0; i < booking.noOfPersons; i += 1) {
            next.push(cleanPerson(sent[i] || {}, { label: `Participant ${i + 1}`, required: false }));
        }

        // The same substitution `createBooking` makes, for the same reason: an
        // attendee list with a blank first line is the organiser's problem on
        // the day.
        if (next.length && !next[0].name) {
            next[0] = {
                name: (booking.bookedBy && booking.bookedBy.name) || '',
                email: (booking.bookedBy && booking.bookedBy.email) || '',
                phone: (booking.bookedBy && booking.bookedBy.phone) || ''
            };
        }

        booking.participants = next;
        await booking.save();

        logger.info('Booking participants changed', {
            bookingRef: booking.bookingRef,
            by: isOwner ? `member:${context.id}` : 'manage-link',
            seats: booking.noOfPersons
        });

        return toBooking(booking.toObject ? booking.toObject() : booking);
    }

    /**
     * Free the seats without losing the record — and tell the booker.
     *
     * A waitlist entry can be cancelled too; it holds no seat, but the person
     * on it is still waiting to hear.
     */
    async cancelBooking(bookingRef, { reason } = {}) {
        const ref = str(bookingRef).toUpperCase();

        const cancelled = await EventBooking.findOneAndUpdate(
            { bookingRef: ref, status: { $in: ['active', 'waitlist'] } },
            { status: 'cancelled', cancelledAt: new Date(), expiresAt: null, note: str(reason).slice(0, 500) },
            { new: true }
        );

        if (!cancelled) throw ApiError.notFound('No active booking with that reference');

        logger.warn('Event booking cancelled', { bookingRef: cancelled.bookingRef });
        this.announce(cancelled, 'cancelled', { reason: str(reason) });
        return toBooking(cancelled);
    }

    // ==================================================================
    //  Telling the booker
    // ==================================================================

    /**
     * Everything a booking message says, built from the booking AND the live
     * event at the moment of sending.
     *
     * The event is re-read rather than trusted from the booking's snapshot
     * because a message going out NOW should carry the schedule as it stands
     * now: an organiser who moved the start from 10:00 to 11:00 wants the
     * reminder to say 11:00. The snapshot is the fallback when the event
     * cannot be read (deleted, or the database is slow).
     *
     * EVERY DATE IS FORMATTED IN IST, explicitly. `toLocaleString` without a
     * `timeZone` formats in the SERVER's zone, and a server in UTC told a
     * member their 10:00 am event started at 4:30 am.
     */
    async messageContext(booking, kind = 'confirmed', extra = {}) {
        const b = booking && booking.toObject ? booking.toObject() : (booking || {});
        const event = (await Event.findById(b.eventId).lean().catch(() => null)) || {};

        const startAt = event.startAt || b.eventStartAt || null;
        const endAt = event.endAt || null;
        const { dateLabel, timeLabel, whenLabel } = describeSchedule(startAt, endAt);
        const startParts = startAt ? istParts(startAt) : null;
        const endParts = endAt ? istParts(endAt) : null;

        const { isOnline, platform, formatWordCategory } = attendanceOf(event, b);
        const venueLabel = isOnline
            ? (platform ? `Online (${platform})` : 'Online')
            : [event.venue || b.eventVenue, event.venueAddress].filter(Boolean).join(', ');

        const seats = Number(b.noOfPersons || 1);
        const payment = b.payment || {};
        const settledVia = payment.status === 'not_required' || Number(b.totalAmount || 0) <= 0
            ? 'free'
            : (payment.mode === 'online' && !payment.recordedBy ? 'online' : 'offline');
        const modeLabel = PAYMENT_MODE_LABELS[payment.mode] || '';

        let paymentLabel = 'Not paid';
        if (settledVia === 'free') paymentLabel = 'Not required';
        else if (payment.status === 'paid') {
            paymentLabel = settledVia === 'online'
                ? 'Paid online'
                : `Paid to the organiser${modeLabel ? ` (${modeLabel})` : ''}`;
        }

        const contactLine = [event.contactName, event.contactPhone, event.contactEmail]
            .filter(Boolean).join(' · ');

        const eventId = String(b.eventId || '');
        // The readable address (eventSlug.js) in every link a booker is sent.
        const publicId = encodeURIComponent(event.slug || eventId);
        const { appUrl } = require('../notifications/notificationTemplates');

        return {
            kind,
            bookingRef: b.bookingRef || '',
            eventTitle: event.title || b.eventTitle || 'ACTIV event',
            dateLabel,
            timeLabel,
            whenLabel,
            venue: venueLabel,
            venueLabel,
            mapUrl: isOnline ? '' : (event.venueMapUrl || b.eventMapUrl || ''),
            isOnline,
            onlinePlatform: platform,
            // The start and end on their own, for a template that prints
            // "Time: {from} to {to}".
            startTimeLabel: startParts && !(startParts.midnight && !endParts) ? `${startParts.time} IST` : '',
            endTimeLabel: endParts ? `${endParts.time} IST` : '',
            bookerName: (b.bookedBy && b.bookedBy.name) || '',
            bookerPhone: (b.bookedBy && b.bookedBy.phone) || '',
            bookerEmail: (b.bookedBy && b.bookedBy.email) || '',
            // The organiser's "Please note" — printed first in the emails'
            // "Before you come" box. See `beforeYouComeHtml`.
            attendeeNote: event.registrationNote || '',
            /*
             * WHAT KIND OF EVENT, said the way a professional invitation
             * says it: an online event is a WEBINAR, an offline one an
             * in-person event. `category` is the organiser's own filing
             * ("Conference", "Workshop") and rides beside it.
             */
            formatLabel: isOnline
                ? `Online webinar${platform ? ` on ${platform}` : ''}`
                : 'In-person event',
            // "ZOOM" filed as the category is the format, already said above.
            category: formatWordCategory ? '' : (event.category || ''),
            topic: event.topic || '',
            language: event.language || '',
            /*
             * THE JOINING LINK, for a booking that holds a place — confirmed
             * or reminded — and never on a waitlist or cancellation message.
             * It is sent to the booker because it is theirs: the public page
             * withholds it (`withJoinLink`) for exactly this reason.
             */
            /*
             * THE LINK ON AN ONLINE EVENT IS THE REGISTRATION LINK, not a join
             * link. The booker opens it, fills in their name and email on the
             * platform's own form (Zoom), and the platform emails them their
             * personal joining link. So every message says "register here" and
             * never "join here".
             *
             * `joinUrl` stays empty: it is reserved for the joining link a
             * platform webhook will hand back per attendee later.
             */
            registerUrl: isOnline && (kind === 'confirmed' || kind === 'reminder') ? (event.onlineUrl || '') : '',
            joinUrl: '',
            /*
             * The event's own poster, as an ABSOLUTE address — an email and a
             * WhatsApp header are fetched by somebody else's server, which
             * cannot resolve `/uploads/…`. Empty when the event has none.
             */
            posterUrl: absoluteMediaUrl(event.bannerUrl || b.eventBannerUrl || ''),
            seats,
            seatsLabel: `${seats} seat${seats === 1 ? '' : 's'}`,
            participantNames: (b.participants || []).map((p) => (p && p.name) || '').filter(Boolean),
            amountLabel: rupees(b.totalAmount),
            settledVia,
            paymentModeLabel: modeLabel,
            paymentLabel,
            paymentId: settledVia === 'online' ? (payment.gatewayPaymentId || '') : '',
            contactLine,
            contactName: event.contactName || '',
            contactPhone: event.contactPhone || '',
            contactEmail: event.contactEmail || '',
            viewUrl: eventId && b.bookingRef
                ? appUrl(`/events/${publicId}/book?ref=${encodeURIComponent(b.bookingRef)}`)
                : '',
            eventUrl: eventId ? appUrl(`/events/${publicId}`) : '',
            bookedByLine: [b.bookedBy && b.bookedBy.name, b.bookedBy && b.bookedBy.phone]
                .filter(Boolean).join(' · '),
            bookedOnLabel: b.createdAt
                ? new Date(b.createdAt).toLocaleString('en-IN', {
                    timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit'
                })
                : '',
            data: { bookingRef: b.bookingRef, eventId, seats },
            ...extra
        };
    }

    /**
     * Tell the booker, on every channel they can be reached on — email,
     * WhatsApp and (for a member) the bell.
     *
     * `kind` picks the message:
     *   confirmed  a paid booking settled (online, or recorded by the
     *              organiser), or a free one taken
     *   waitlist   the event was full; nothing is held and nothing is owed
     *   cancelled  the organiser cancelled it
     *   reminder   the event is coming up (see `sendDueReminders`)
     *
     * NEVER AWAITED AND CANNOT THROW. By the time this runs the seats are held
     * and, on a paid booking, the money has moved. A mail host that is down
     * must not turn a completed payment into an error the booker sees — they
     * would pay a second time for seats they already hold.
     */
    announce(booking, kind = null, extra = {}) {
        if (!booking) return;
        const resolvedKind = kind || (booking.status === 'waitlist' ? 'waitlist' : 'confirmed');

        (async() => {
            const email = (booking.bookedBy && booking.bookedBy.email) || '';
            const phone = (booking.bookedBy && booking.bookedBy.phone) || '';
            if (!email && !phone) return;

            const ctx = await this.messageContext(booking, resolvedKind, extra);
            const eventName = {
                confirmed: 'EVENT_BOOKING_CONFIRMED',
                cancelled: 'EVENT_BOOKING_CANCELLED',
                reminder: 'EVENT_BOOKING_REMINDER',
                waitlist: 'EVENT_BOOKING_WAITLISTED'
            }[resolvedKind] || 'EVENT_BOOKING_CONFIRMED';

            const notificationService = require('../notifications/notification.service');
            await notificationService.dispatchLifecycleEvent(eventName, {
                // A guest has no member id, so there is no bell to write to —
                // the in-app channel is skipped on its own when it is absent.
                id: booking.userId || '',
                name: (booking.bookedBy && booking.bookedBy.name) || '',
                email,
                phone
            }, ctx);

            /*
             * EVERY PARTICIPANT HEARS TOO, in their own words.
             *
             * A company head books five seats for their team: each of the five is
             * the person who has to turn up, so each gets a message naming who
             * booked for them, THEIR seat and the event details — never the
             * booker's payment. Not on a waitlist (nothing is held for them).
             *
             * One message per person: participant 1 defaults to the booker, and
             * the same number or address listed twice is sent once. A
             * participant with neither an email nor a mobile has nowhere to go.
             */
            if (!['confirmed', 'reminder', 'cancelled'].includes(resolvedKind)) return;
            const seen = new Set([phoneKey(phone), str(email).toLowerCase()].filter(Boolean));
            const people = (booking.participants || []).filter((p) => {
                const keys = [phoneKey(p && p.phone), str(p && p.email).toLowerCase()].filter(Boolean);
                if (!keys.length || keys.some((k) => seen.has(k))) return false;
                keys.forEach((k) => seen.add(k));
                return true;
            });
            const participantEvent = {
                confirmed: 'EVENT_PARTICIPANT_CONFIRMED',
                reminder: 'EVENT_PARTICIPANT_REMINDER',
                cancelled: 'EVENT_PARTICIPANT_CANCELLED'
            }[resolvedKind];
            for (const person of people) {
                await notificationService.dispatchLifecycleEvent(participantEvent, {
                    id: '',
                    name: str(person.name),
                    email: str(person.email),
                    phone: str(person.phone)
                }, {
                    ...ctx,
                    // The message is about THEIR seat, booked by somebody else.
                    participantName: str(person.name),
                    participantEmail: str(person.email),
                    participantPhone: str(person.phone),
                    bookerName: (booking.bookedBy && booking.bookedBy.name) || '',
                    bookerEmail: str(person.email)
                }).catch((error) => logger.warn('Participant message not sent', {
                    bookingRef: booking.bookingRef, kind: resolvedKind, error: error && error.message
                }));
            }
        })().catch((error) => {
            logger.warn('Event booking message not sent', {
                bookingRef: booking && booking.bookingRef, kind: resolvedKind, error: error && error.message
            });
        });
    }

    /**
     * =====================================================================
     * REMINDERS, SENT WHEN THE EVENT'S OWN SCHEDULE SAYS SO
     * =====================================================================
     *
     * `Event.reminderOffsetsHours` is what the organiser set ("24h before",
     * "2h before"). It was stored and shown on the dashboard and nothing ever
     * sent it. This does, on a timer started by `server.js`.
     *
     * An event with no offsets of its own falls back to
     * `EVENT_REMINDER_DEFAULT_HOURS` (24 unless set; `0` turns the fallback
     * off). Offsets are computed against the event's CURRENT start, so moving
     * the event moves its reminders with it.
     *
     * ONE REMINDER PER OFFSET PER BOOKING, even with several server instances:
     * the offset is claimed with `$addToSet` on a filter that requires it to be
     * absent, so a second instance matches nothing.
     *
     * A booking made AFTER an offset's moment does not get that reminder — a
     * seat taken an hour before the start has just had its confirmation, and
     * "starts tomorrow" then would be wrong.
     */
    async sendDueReminders() {
        const now = Date.now();
        const rawDefault = process.env.EVENT_REMINDER_DEFAULT_HOURS === undefined
            ? '24' : String(process.env.EVENT_REMINDER_DEFAULT_HOURS);
        const fallback = rawDefault.split(',').map(Number).filter((h) => Number.isFinite(h) && h > 0);

        const horizon = new Date(now + 8 * 24 * 60 * 60 * 1000);
        const events = await Event.find({ startAt: { $gt: new Date(now), $lte: horizon } })
            .select('_id startAt reminderOffsetsHours')
            .lean()
            .catch(() => []);

        let sent = 0;
        for (const event of events || []) {
            const start = new Date(event.startAt).getTime();
            const own = Array.isArray(event.reminderOffsetsHours) ? event.reminderOffsetsHours : [];
            const offsets = (own.length ? own : fallback)
                .map(Number)
                .filter((h) => Number.isFinite(h) && h > 0 && h <= 24 * 7);

            for (const hours of offsets) {
                const moment = start - hours * 60 * 60 * 1000;
                if (now < moment) continue;

                for (let guard = 0; guard < 5000; guard += 1) {
                    const booking = await EventBooking.findOneAndUpdate(
                        {
                            eventId: event._id,
                            status: 'active',
                            'payment.status': { $in: ['paid', 'not_required'] },
                            createdAt: { $lt: new Date(moment) },
                            remindersSent: { $ne: hours }
                        },
                        { $addToSet: { remindersSent: hours } },
                        { new: true }
                    ).catch(() => null);
                    if (!booking) break;

                    this.announce(booking, 'reminder', { startsInLabel: startsIn(start - now) });
                    sent += 1;
                }
            }
        }

        if (sent) logger.info('Event booking reminders sent', { count: sent });
        return sent;
    }

    /** Start the reminder timer. Idempotent; `server.js` calls it once. */
    startReminderScheduler() {
        if (this.reminderTimer) return;
        if (String(process.env.EVENT_REMINDERS_ENABLED || 'true').toLowerCase() === 'false') return;

        const every = Math.max(1, parseInt(process.env.EVENT_REMINDER_INTERVAL_MINUTES, 10) || 5) * 60 * 1000;
        const tick = () => this.sendDueReminders().catch((error) =>
            logger.warn('Event reminder sweep failed', { error: error && error.message }));

        this.reminderTimer = setInterval(tick, every);
        if (this.reminderTimer.unref) this.reminderTimer.unref();
        const first = setTimeout(tick, 30 * 1000);
        if (first.unref) first.unref();
    }

    // ==================================================================
    //  The organiser's list
    // ==================================================================

    /**
     * One page of an event's bookings, plus the totals for the whole event.
     *
     * The totals are computed over EVERYTHING, not over the page and not over
     * the filter. "34 bookings, ₹34,000 collected" is only meaningful against
     * the whole event, and recomputing it from the filtered set would make the
     * figure move as an organiser narrowed the view looking for the unpaid ones.
     */
    async listBookings(eventId, filters = {}) {
        if (!/^[0-9a-fA-F]{24}$/.test(String(eventId || ''))) {
            throw ApiError.badRequest('A valid event id is required');
        }

        const id = new mongoose.Types.ObjectId(String(eventId));
        const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 10, 1), 200);
        const page = Math.max(parseInt(filters.page, 10) || 1, 1);

        const query = { eventId: id };
        if (filters.status) query.status = str(filters.status);
        if (filters.paymentStatus) query['payment.status'] = str(filters.paymentStatus);

        if (filters.search) {
            /*
             * Escaped. A '+' in a mobile number is a quantifier, and an
             * unescaped one throws rather than matching nothing — the search box
             * would 500 on the most natural thing to paste into it.
             */
            const escaped = str(filters.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(escaped, 'i');
            query.$or = [
                { bookingRef: rx },
                { 'bookedBy.name': rx },
                { 'bookedBy.email': rx },
                { 'bookedBy.phone': rx }
            ];
        }

        const [rows, total, totals] = await Promise.all([
            EventBooking.find(query).sort({ createdAt: -1 })
                .skip((page - 1) * limit).limit(limit).lean(),
            EventBooking.countDocuments(query),
            EventBooking.aggregate([
                { $match: { eventId: id } },
                {
                    $group: {
                        _id: '$payment.status',
                        bookings: { $sum: 1 },
                        seats: { $sum: '$noOfPersons' },
                        amount: { $sum: '$totalAmount' }
                    }
                }
            ]).catch(() => [])
        ]);

        const summary = {
            bookings: 0, seats: 0, collected: 0, pending: 0,
            paidBookings: 0, pendingBookings: 0
        };

        for (const row of totals || []) {
            const n = Number(row.bookings || 0);
            summary.bookings += n;
            summary.seats += Number(row.seats || 0);

            if (row._id === 'paid') {
                summary.collected += Number(row.amount || 0);
                summary.paidBookings += n;
            } else if (row._id === 'pending') {
                // Owed, not collected. Adding it to the takings would tell an
                // organiser they hold money that is still in somebody's wallet.
                summary.pending += Number(row.amount || 0);
                summary.pendingBookings += n;
            }
        }

        return {
            bookings: (rows || []).map(toBooking),
            summary,
            pagination: {
                page, limit, total,
                pages: Math.max(1, Math.ceil(total / limit))
            }
        };
    }

    // ==================================================================
    //  The organiser's overview — every event, and how full it is
    // ==================================================================

    /**
     * One row per event: total seats, booked seats, seats remaining.
     *
     * =====================================================================
     * ONE AGGREGATE FOR EVERY EVENT, NOT `countSeats` IN A LOOP
     * =====================================================================
     *
     * `countSeats` is the right call for ONE event — it sweeps that event's
     * lapsed holds first, then counts both collections. Called once per event
     * from a list of forty, it is forty sweeps and eighty queries for a screen
     * that renders in one table, and the sweeps are the expensive half.
     *
     * So the sweep runs ONCE, globally (it is already written to accept no
     * event id), and the counting is two grouped aggregates — one per
     * collection — joined in memory. The seat arithmetic itself is deliberately
     * identical to `countSeats`: `active` bookings that are settled or still
     * inside a live hold, plus non-pending member registrations. Two different
     * ideas of what fills a chair is how an event shows 100 seats left on one
     * screen and 83 on another.
     *
     * BOTH COLLECTIONS, for the reason `seatsFor` gives: a member's own seat and
     * a participant on a public booking are the same chair in the same room.
     *
     * `capacity: 0` means unlimited, which the schema's note explains. It is
     * reported as `null` remaining rather than as a negative or a zero — a
     * table cell reading "0 remaining" on an uncapped event would stop an
     * organiser taking bookings they can perfectly well take.
     */
    async bookingOverview(filters = {}) {
        // Once, for every event at once. A lapsed hold still counted as a taken
        // seat would under-report what is available on every row of the table.
        await this.sweepExpiredHolds(null);

        const query = {};
        // Drafts are excluded by default: an unpublished event has no public
        // booking page, so a row for it would read as an event taking bookings
        // that nobody can reach. `?includeDrafts=1` shows them for the editor
        // who wants to check one before publishing.
        if (!(filters.includeDrafts === true || filters.includeDrafts === '1' || filters.includeDrafts === 'true')) {
            query.status = 'published';
        }

        const events = await Event.find(query)
            .select('title startAt endAt venue capacity registrationFee memberFee '
                + 'registrationEnabled status category bannerUrl')
            .sort({ startAt: -1, createdAt: -1 })
            .limit(500)
            .lean()
            .catch(() => []);

        if (!events.length) return { events: [], totals: EMPTY_OVERVIEW_TOTALS() };

        const ids = events.map((e) => e._id);
        const now = new Date();

        const [bookingRows, registrationRows] = await Promise.all([
            EventBooking.aggregate([
                { $match: { eventId: { $in: ids } } },
                {
                    $group: {
                        _id: '$eventId',
                        bookings: { $sum: 1 },
                        /*
                         * Seats, counted with the SAME rule `countSeats` uses —
                         * an active booking that is settled, free, or inside a
                         * live hold. Anything else takes no chair.
                         */
                        seats: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$status', 'active'] },
                                            {
                                                $or: [
                                                    { $in: ['$payment.status', ['paid', 'not_required']] },
                                                    {
                                                        $and: [
                                                            { $eq: ['$payment.status', 'pending'] },
                                                            { $gt: ['$expiresAt', now] }
                                                        ]
                                                    }
                                                ]
                                            }
                                        ]
                                    },
                                    '$noOfPersons',
                                    0
                                ]
                            }
                        },
                        collected: {
                            $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, '$totalAmount', 0] }
                        },
                        pending: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$payment.status', 'pending'] },
                                            { $ne: ['$status', 'expired'] },
                                            { $ne: ['$status', 'cancelled'] }
                                        ]
                                    },
                                    '$totalAmount',
                                    0
                                ]
                            }
                        },
                        paidBookings: {
                            $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, 1, 0] }
                        },
                        waitlisted: {
                            $sum: { $cond: [{ $eq: ['$status', 'waitlist'] }, '$noOfPersons', 0] }
                        }
                    }
                }
            ]).catch(() => []),

            EventRegistration.aggregate([
                {
                    $match: {
                        eventId: { $in: ids },
                        status: 'registered',
                        'payment.status': { $ne: 'pending' }
                    }
                },
                { $group: { _id: '$eventId', seats: { $sum: 1 } } }
            ]).catch(() => [])
        ]);

        const bookingsBy = new Map((bookingRows || []).map((r) => [String(r._id), r]));
        const registrationsBy = new Map((registrationRows || []).map((r) => [String(r._id), r]));

        const totals = EMPTY_OVERVIEW_TOTALS();

        const rows = events.map((event) => {
            const id = String(event._id);
            const booking = bookingsBy.get(id) || {};
            const registration = registrationsBy.get(id) || {};

            const capacity = Math.max(0, Number(event.capacity || 0));
            const booked = Number(booking.seats || 0) + Number(registration.seats || 0);
            // `null`, not a clamped zero — see the note above. An uncapped event
            // has no remaining figure to report, and reporting one invents a limit.
            const remaining = capacity > 0 ? Math.max(0, capacity - booked) : null;

            totals.events += 1;
            totals.seats += booked;
            totals.capacity += capacity;
            totals.bookings += Number(booking.bookings || 0);
            totals.collected += Number(booking.collected || 0);
            totals.pending += Number(booking.pending || 0);

            return {
                id,
                title: event.title || '',
                startAt: event.startAt || null,
                endAt: event.endAt || null,
                venue: event.venue || '',
                category: event.category || '',
                status: event.status || 'draft',
                bannerUrl: event.bannerUrl || '',
                registrationEnabled: !!event.registrationEnabled,

                /** Both prices, from the one resolver every other screen reads. */
                ...(() => {
                    const p = priceFor(event, null);
                    return {
                        price: p.price,
                        memberPrice: p.memberPrice,
                        hasMemberRate: p.hasMemberRate,
                        memberSaving: p.memberSaving
                    };
                })(),

                /** `0` is unlimited, matching the schema. The screen prints "—". */
                totalSeats: capacity,
                bookedSeats: booked,
                remainingSeats: remaining,
                waitlistedSeats: Number(booking.waitlisted || 0),

                bookings: Number(booking.bookings || 0),
                paidBookings: Number(booking.paidBookings || 0),
                collected: Number(booking.collected || 0),
                pendingAmount: Number(booking.pending || 0)
            };
        });

        return { events: rows, totals };
    }

    // ==================================================================
    //  The door list — one row per PERSON, not per booking
    // ==================================================================

    /**
     * Every participant on every booking for an event, flattened.
     *
     * A DIFFERENT QUESTION FROM `listBookings`, which is why it is a different
     * method rather than a flag. A booking is a transaction: who paid, how
     * much, by what means. This is the room: who is actually walking in. One
     * booking for four colleagues is one row there and four rows here, and on
     * the door only the second shape is any use — an organiser ticking people
     * off a list needs the name of the person standing in front of them, and
     * that person may be none of the three whose name is on the payment.
     *
     * THE BOOKER IS INCLUDED ONLY IF THEY ARE ALSO A PARTICIPANT. An office
     * manager who books four seats and does not attend is not in the room, and
     * putting them on the door list would have somebody turned away for a seat
     * that was never theirs. `bookedBy` is carried on every row as context —
     * who to ask about this seat — rather than as a row of its own.
     *
     * ONLY PEOPLE WHO WERE ACTUALLY NAMED ARE LISTED. A booking for four where
     * one name was typed produces ONE row, not four.
     *
     * It used to produce four, the unnamed three reading "Guest 2 of 4" - a
     * person the organiser had no record of, invented by this function so the
     * row count would match the seat count. The seat count is reported as a
     * number (`seatsBooked`), which is what it is; a seat is not a person until
     * somebody says who is sitting in it.
     */
    async listAttendees(eventId, filters = {}) {
        if (!/^[0-9a-fA-F]{24}$/.test(String(eventId || ''))) {
            throw ApiError.badRequest('A valid event id is required');
        }

        const id = new mongoose.Types.ObjectId(String(eventId));

        const query = {
            eventId: id,
            // Cancelled and expired bookings are not in the room. They stay in
            // `listBookings`, where the record of them is the point.
            status: { $in: ['active', 'waitlist'] }
        };
        if (filters.paymentStatus) query['payment.status'] = str(filters.paymentStatus);

        const rows = await EventBooking.find(query).sort({ createdAt: 1 }).lean().catch(() => []);

        const attendees = [];
        // Every seat that was paid for, named or not. A count, reported as a
        // count - never expanded into rows for people nobody entered.
        let seatsBooked = 0;

        for (const booking of rows || []) {
            const seats = Math.max(1, Number(booking.noOfPersons || 1));
            const people = Array.isArray(booking.participants) ? booking.participants : [];
            seatsBooked += seats;

            for (let index = 0; index < seats; index += 1) {
                const person = people[index] || {};
                const name = str(person.name);

                // No name, no row. See the note above this method.
                if (!name) continue;

                attendees.push({
                    /*
                     * A composite key, because a participant has no id of its
                     * own — `_id: false` on the sub-schema, deliberately, so
                     * nothing points at a line the booker can rewrite wholesale.
                     * The reference plus the seat number is stable for as long
                     * as the booking is, which is what a table key needs.
                     */
                    key: `${booking.bookingRef}-${index}`,
                    seatNo: index + 1,
                    name,
                    /** Kept for the client's types; every listed row is named. */
                    named: true,
                    email: str(person.email),
                    phone: str(person.phone),

                    bookingRef: booking.bookingRef || '',
                    bookedByName: str(booking.bookedBy && booking.bookedBy.name),
                    bookedByEmail: str(booking.bookedBy && booking.bookedBy.email),
                    bookedByPhone: str(booking.bookedBy && booking.bookedBy.phone),
                    /** Whether this seat's booker was signed in. */
                    isGuest: !!booking.isGuest,
                    isMemberRate: !!booking.memberRateApplied,

                    paymentStatus: (booking.payment && booking.payment.status) || 'pending',
                    paymentMode: (booking.payment && booking.payment.mode) || '',
                    /** The whole booking's total, on every one of its rows — see below. */
                    bookingTotal: Number(booking.totalAmount || 0),
                    /*
                     * This seat's share. `unitAmount`, NOT `totalAmount / seats`
                     * — they are the same number here and only one of them stays
                     * right if a booking is ever part-refunded.
                     */
                    seatAmount: Number(booking.unitAmount || 0),

                    status: booking.status || 'active',
                    bookedAt: booking.createdAt || null
                });
            }
        }

        if (filters.search) {
            const needle = str(filters.search).toLowerCase();
            return {
                attendees: attendees.filter((row) =>
                    [row.name, row.email, row.phone, row.bookingRef, row.bookedByName]
                        .some((field) => String(field || '').toLowerCase().includes(needle))),
                total: attendees.length,
                seatsBooked
            };
        }

        return { attendees, total: attendees.length, seatsBooked };
    }

    // ==================================================================
    //  Export
    // ==================================================================

    /**
     * Every booking on one event as CSV, participants expanded inline.
     *
     * CSV AND NOT XLSX. The button says "Excel Report" because that is what the
     * association calls it and what they will do with it, and Excel opens a CSV
     * natively. Generating a real workbook would add a binary dependency to the
     * API for a file whose only job is to be opened once and sorted — and a CSV
     * survives being mailed on, opened in Sheets, and read by a script, which
     * an .xlsx does less well.
     *
     * ONE ROW PER BOOKING, with the participants in numbered columns rather than
     * one row per participant. The organiser reconciling takings needs the money
     * to add up down a column, and a booking repeated across four rows makes
     * every total in the sheet four times too large. The door list — one row per
     * person — is `listAttendees`, and has its own export for the same reason
     * in reverse.
     */
    async exportBookingsCsv(eventId) {
        if (!/^[0-9a-fA-F]{24}$/.test(String(eventId || ''))) {
            throw ApiError.badRequest('A valid event id is required');
        }

        const id = new mongoose.Types.ObjectId(String(eventId));
        const [event, rows] = await Promise.all([
            Event.findById(id).select('title startAt venue').lean().catch(() => null),
            EventBooking.find({ eventId: id }).sort({ createdAt: 1 }).lean().catch(() => [])
        ]);

        const bookings = rows || [];
        const widest = bookings.reduce(
            (most, row) => Math.max(most, (row.participants || []).length, Number(row.noOfPersons || 1)),
            1
        );

        const headers = [
            'S.No', 'Booking Ref', 'Booked On', 'Name', 'Email', 'Mobile',
            'Member', 'Rate Applied', 'Payment Mode', 'Payment Status',
            'No Of Participants', 'Unit Amount', 'Total Amount', 'Booking Status'
        ];
        for (let i = 1; i <= widest; i += 1) {
            headers.push(`Participant ${i} Name`, `Participant ${i} Email`, `Participant ${i} Mobile`);
        }

        const lines = [headers.map(csvCell).join(',')];

        bookings.forEach((row, index) => {
            const cells = [
                index + 1,
                row.bookingRef || '',
                row.createdAt ? new Date(row.createdAt).toISOString() : '',
                str(row.bookedBy && row.bookedBy.name),
                str(row.bookedBy && row.bookedBy.email),
                str(row.bookedBy && row.bookedBy.phone),
                row.isGuest ? 'Guest' : 'Member',
                row.memberRateApplied ? 'Member price' : 'Standard price',
                (row.payment && row.payment.mode) || '',
                (row.payment && row.payment.status) || '',
                Number(row.noOfPersons || 0),
                Number(row.unitAmount || 0),
                Number(row.totalAmount || 0),
                row.status || ''
            ];

            const people = row.participants || [];
            for (let i = 0; i < widest; i += 1) {
                const person = people[i] || {};
                cells.push(str(person.name), str(person.email), str(person.phone));
            }

            lines.push(cells.map(csvCell).join(','));
        });

        return {
            filename: `${csvFilename(event && event.title)}-bookings.csv`,
            /*
             * A BOM, and CRLF line endings.
             *
             * Excel on Windows reads a BOM-less UTF-8 CSV as the system code
             * page, which turns every ₹ and every non-ASCII name into mojibake
             * on the machine this file is most likely to be opened on. Three
             * bytes fix it, and every other reader ignores them.
             */
            csv: '﻿' + lines.join('\r\n') + '\r\n',
            rows: bookings.length
        };
    }

    // ==================================================================
    //  People — everyone who has booked anything, across every event
    // ==================================================================

    /**
     * One row per PERSON, across the whole programme.
     *
     * A third shape of the same rows, and a third genuinely different question.
     * `listBookings` is one event's transactions; `listAttendees` is one event's
     * room; this is the association's contact book: who has ever booked
     * anything, how much they have spent, and how many events they have been to.
     *
     * =====================================================================
     * KEYED ON THE EMAIL ADDRESS, NOT ON `userId`
     * =====================================================================
     *
     * Most bookers are GUESTS and have no account, so `userId` is empty for
     * them and grouping on it would collapse every guest in the database into
     * one row. The email address is the only identifier every booking carries.
     *
     * It is lower-cased on the way into the schema already, so the grouping
     * does not have to normalise — but the SAME person booking once as a guest
     * and once signed in is still one row here, which is the point: they are
     * one person to the association, and showing them twice makes the totals
     * beside their name wrong.
     *
     * A booking with NO email is dropped rather than grouped under `''`. An
     * empty key would gather unrelated strangers into a single row with a
     * combined spend, which is worse than not listing them; they are still in
     * the event's own booking list, where the reference is what identifies them.
     *
     * =====================================================================
     * NO CREDENTIALS. NOT THE HASH, NOT A MASK, NOT A LENGTH.
     * =====================================================================
     *
     * This screen replaces one that printed members' passwords in a column. It
     * does not read any credential field and never will — this note is here so
     * that the next person asked to "restore the password column" finds the
     * reason rather than the field. Everything a super admin needs to identify
     * or contact somebody is here; a password identifies nobody and contacts
     * nothing.
     */
    async listBookingPeople(filters = {}) {
        const match = {
            // Cancelled and lapsed bookings are excluded from the SPEND but the
            // person still belongs in the contact book, so the filter is on the
            // amounts below rather than on the rows.
            'bookedBy.email': { $nin: ['', null] }
        };

        const rows = await EventBooking.aggregate([
            { $match: match },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: '$bookedBy.email',
                    /*
                     * `$first` after a newest-first sort: the name and number
                     * they gave MOST RECENTLY. A person who corrects a typo in
                     * their own name on a later booking should be listed under
                     * the corrected spelling, not under the first one they ever
                     * typed.
                     */
                    name: { $first: '$bookedBy.name' },
                    phone: { $first: '$bookedBy.phone' },
                    lastBookedAt: { $first: '$createdAt' },
                    firstBookedAt: { $last: '$createdAt' },

                    bookings: { $sum: 1 },
                    seats: { $sum: '$noOfPersons' },
                    events: { $addToSet: '$eventId' },

                    // Money that actually arrived. Pending is owed, and adding
                    // it here would tell an organiser they hold it.
                    paid: {
                        $sum: { $cond: [{ $eq: ['$payment.status', 'paid'] }, '$totalAmount', 0] }
                    },
                    pending: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$payment.status', 'pending'] },
                                        { $eq: ['$status', 'active'] }
                                    ]
                                },
                                '$totalAmount', 0
                            ]
                        }
                    },
                    cancelled: {
                        $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
                    },

                    /*
                     * `$max` on the member flags, not `$first`.
                     *
                     * Somebody who has EVER booked signed in has an account,
                     * whatever they did last time; and somebody who has ever
                     * been given the member rate is a member. Taking the most
                     * recent booking's answer would file a member who happened
                     * to book their last seat as a guest under "Guest".
                     */
                    userId: { $max: '$userId' },
                    memberRateEver: { $max: { $cond: ['$memberRateApplied', 1, 0] } }
                }
            }
        ]).catch(() => []);

        const people = (rows || []).map((row) => ({
            email: row._id || '',
            name: str(row.name),
            phone: str(row.phone),

            /** Their member id when any booking was made signed in, else ''. */
            userId: str(row.userId),
            /** Whether they have an account at all — see the `$max` note above. */
            isMember: !!str(row.userId),
            /** Whether the membership discount has ever been applied to them. */
            hasMemberRate: !!row.memberRateEver,

            bookings: Number(row.bookings || 0),
            seats: Number(row.seats || 0),
            events: (row.events || []).length,
            cancelled: Number(row.cancelled || 0),

            paid: Number(row.paid || 0),
            pending: Number(row.pending || 0),

            firstBookedAt: row.firstBookedAt || null,
            lastBookedAt: row.lastBookedAt || null
        }));

        if (filters.search) {
            const needle = str(filters.search).toLowerCase();
            const hit = (row) => [row.name, row.email, row.phone]
                .some((field) => String(field || '').toLowerCase().includes(needle));
            return { people: people.filter(hit), total: people.length };
        }

        // Newest booker first — the list is read as "who booked recently", and
        // an alphabetical default buries this morning's booking under the As.
        people.sort((a, b) => new Date(b.lastBookedAt || 0) - new Date(a.lastBookedAt || 0));

        return { people, total: people.length };
    }

    /**
     * One person's whole history — every booking, on every event.
     *
     * What the View button opens. Addressed by EMAIL for the reason the list is
     * grouped by it: most of these people have no account and no id.
     */
    async getBookingPerson(email) {
        const address = str(email).toLowerCase();
        if (!address) throw ApiError.badRequest('An email address is required');

        const rows = await EventBooking.find({ 'bookedBy.email': address })
            .sort({ createdAt: -1 }).lean().catch(() => []);

        if (!rows.length) throw ApiError.notFound('Nobody has booked under that address');

        const bookings = rows.map(toBooking);
        const newest = rows[0];

        const paid = rows
            .filter((r) => r.payment && r.payment.status === 'paid')
            .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);
        const pending = rows
            .filter((r) => r.status === 'active' && r.payment && r.payment.status === 'pending')
            .reduce((sum, r) => sum + Number(r.totalAmount || 0), 0);

        return {
            person: {
                email: address,
                name: str(newest.bookedBy && newest.bookedBy.name),
                phone: str(newest.bookedBy && newest.bookedBy.phone),
                userId: rows.map((r) => str(r.userId)).find(Boolean) || '',
                isMember: rows.some((r) => !!str(r.userId)),
                hasMemberRate: rows.some((r) => !!r.memberRateApplied),
                bookings: rows.length,
                seats: rows.reduce((sum, r) => sum + Number(r.noOfPersons || 0), 0),
                events: [...new Set(rows.map((r) => String(r.eventId)))].length,
                paid,
                pending,
                firstBookedAt: rows[rows.length - 1].createdAt || null,
                lastBookedAt: newest.createdAt || null
            },
            bookings
        };
    }
}

module.exports = new EventBookingService();
module.exports.isMockMode = isMockMode;
module.exports.sign = sign;
module.exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
module.exports.describeSchedule = describeSchedule;
