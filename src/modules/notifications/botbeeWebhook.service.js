const config = require('../../config');
const logger = require('../../config/logger');
const botbeeService = require('./botbee.service');
const regionalContacts = require('./regionalContacts.service');
const notificationService = require('./notification.service');
const { normalizeStatus } = require('../common/applicationStatus');

/**
 * The inbound half of the WhatsApp bot.
 *
 * A member messages the ACTIV number, BotBee posts that message here, and this
 * decides what to say back. Three commands, and each answers a question a
 * member currently has to open a browser and sign in to answer:
 *
 *   STATUS  — where is my application right now?
 *   HELP    — who do I talk to about it?
 *   EVENTS  — what is coming up?
 *
 * ------------------------------------------------------- why this is separate
 *
 * The webhook is UNAUTHENTICATED — BotBee has no ACTIV token and never will —
 * so it cannot live behind `notification.routes.js`, which applies `verifyToken`
 * to everything in it. It is also mounted above `businessRoutes` in `routes.js`,
 * which is itself a catch-all auth gate for everything registered after it. Both
 * facts are load-bearing: mounted anywhere else, every BotBee delivery gets a
 * 401 and the bot is silently mute. See the route-ordering note in CLAUDE.md.
 *
 * -------------------------------------------------------------- identifying
 *
 * The ONLY thing an inbound message carries is a phone number, and the only
 * thing the platform will say back to it is information about the account that
 * number is registered on. That is the whole security model here and it is why
 * `findMemberByPhone` matches on the NORMALISED number: a member registered as
 * "+91 98765 43210" must be recognised when WhatsApp reports "919876543210",
 * and an unrecognised number is told how to register rather than being handed a
 * hint about whether some other account exists.
 *
 * NOTHING HERE THROWS. A webhook that 500s is one a provider retries, and a
 * retried inbound message is a duplicate reply to a member. Every path answers
 * 200 with the best reply it can produce.
 */

/** Every command the bot understands, and the words that reach it. */
const COMMANDS = {
    STATUS: [
        'status', 'application', 'my status', 'application status', 'track',
        'membership status', 'my membership status', 'check status', 'membership'
    ],
    HELP: [
        'help', 'contact', 'support', 'admin', 'officer', 'hi', 'hello', 'hey', 'menu', 'start',
        'help & support', 'support & help', 'become member', 'become a member', 'register'
    ],
    EVENTS: [
        'events', 'event', 'programme', 'program', 'meetings',
        'upcoming events', 'regional events'
    ]
};

/**
 * Which command a message is, or `null`.
 *
 * Exact match first, then a whole-word containment test. The order matters and
 * the word boundary matters: a member typing "what is my application status"
 * should reach STATUS, but a member typing "I need help with the event" should
 * not silently reach EVENTS because the word appears somewhere in the sentence
 * — the earlier command in the list wins, and HELP is listed before EVENTS for
 * exactly that case.
 */
const parseCommand = (text) => {
    const clean = String(text || '').trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return null;

    for (const [command, words] of Object.entries(COMMANDS)) {
        if (words.includes(clean)) return command;
    }
    for (const [command, words] of Object.entries(COMMANDS)) {
        if (words.some((word) => new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`).test(clean))) {
            return command;
        }
    }
    return null;
};

/**
 * How a status reads to the member whose application it is.
 *
 * Keyed on the CANONICAL status, which `normalizeStatus` folds every legacy
 * spelling into - so a row still stored as `Pending-State` answers with the one
 * pending line rather than telling its owner they have cleared two reviews that
 * no longer exist.
 *
 * There used to be three pending lines, one per tier, each naming the review a
 * file had just cleared. An application is with its Block, District and State
 * Admin together now and any of them can decide it, so there is one line and it
 * says so.
 */
const STAGE_COPY = {
    Pending: 'With your Block, District and State Admin for review',
    Approved: 'Approved — complete your membership payment to activate',
    Rejected: 'Not approved'
};

/**
 * Find the member behind an inbound number.
 *
 * Required lazily rather than at the top of the file. This module is loaded from
 * `routes.js` while the route table is being assembled, and pulling the member
 * and application models in at that moment creates a require cycle through the
 * modules that register those schemas. Requiring inside the call happens after
 * everything is registered.
 *
 * Matches on the normalised digits, and on the two shapes a form actually
 * stores — with and without the country code — because neither client has ever
 * normalised what it saved.
 */
const findMemberByPhone = async(rawPhone) => {
    const digits = botbeeService.normalizePhoneNumber(rawPhone);
    if (!digits) return null;

    const cc = String(config.botbee.defaultCountryCode || '91');
    const national = digits.startsWith(cc) ? digits.slice(cc.length) : digits;

    // Every spelling of the same number that could be sitting in the database.
    const candidates = Array.from(new Set([digits, national, `+${digits}`, `0${national}`]));
    const loose = new RegExp(`${national}$`);

    try {
        const MemberDetails = require('../members/memberdetails.model');
        const Application = require('../applications/application.model');

        /*
         * `find`, not `findOne` — A PHONE NUMBER DOES NOT IDENTIFY ONE PERSON.
         *
         * `phoneNumber` carries no unique index on this collection and the live
         * data proves why that matters: one number is shared by four member
         * rows. `auth.service.resolveLoginEmail` already refuses to accept a
         * phone number for exactly this reason — resolving it would sign the
         * caller into whichever row Mongo happened to return first.
         *
         * This bot has the same exposure and a worse consequence: it does not
         * merely pick a row, it reads that row's application status out loud to
         * whoever sent the message. `findOne` here would have answered "STATUS"
         * from a number shared by four people with one arbitrary person's
         * application stage, region and rejection reason.
         *
         * So every match is loaded, and an ambiguous number is reported as such
         * rather than resolved. Two matches for the same underlying person (a
         * profile row plus its own application) are not ambiguous — the
         * `_id` set is what decides.
         */
        /*
         * `whatsappNumber` as well as `phoneNumber`.
         *
         * The bot is answering a message that arrived FROM WhatsApp, so the
         * number it is holding is by definition the member's WhatsApp number —
         * matching only on `phoneNumber` would fail to recognise every member
         * whose two numbers differ, and answer them "we could not find an ACTIV
         * account registered to this WhatsApp number" while their account sits
         * right there.
         */
        const members = await MemberDetails.find({
            $or: [
                { phoneNumber: { $in: candidates } }, { phoneNumber: loose },
                { whatsappNumber: { $in: candidates } }, { whatsappNumber: loose }
            ]
        }).lean();

        const distinct = new Set(members.map((m) => String(m._id)));
        if (distinct.size > 1) {
            return { ambiguous: true, count: distinct.size };
        }

        let member = members[0] || null;

        // No profile row: an applicant may still exist with only an application.
        let application = null;
        if (member) {
            application = await Application.findOne({ userId: member._id })
                .sort({ createdAt: -1 })
                .lean();
        } else {
            const applications = await Application.find({
                $or: [{ phone: { $in: candidates } }, { phone: loose }]
            }).sort({ createdAt: -1 }).lean();

            // Same rule one level down: several applicants sharing a number is
            // still several people, and none of them may be told about another.
            const owners = new Set(applications.map((a) => String(a.userId || a._id)));
            if (owners.size > 1) {
                return { ambiguous: true, count: owners.size };
            }

            application = applications[0] || null;
            if (application) {
                member = {
                    _id: application.userId,
                    fullName: application.fullName,
                    email: application.email,
                    phoneNumber: application.phone,
                    state: application.state,
                    district: application.district,
                    block: application.block
                };
            }
        }

        if (!member) return null;
        return { member, application };
    } catch (error) {
        logger.warn('WhatsApp bot could not look up an inbound number', {
            error: error && error.message
        });
        return null;
    }
};

/** "Rajeshwari" from "Rajeshwari Muthukrishnan". */
const firstNameOf = (value) => String(value || '').trim().split(/\s+/).filter(Boolean)[0] || 'there';

/* ------------------------------------------------------------------ replies */

/**
 * Several accounts share this number, so nothing specific may be said.
 *
 * Deliberately vague about how many and about whose. The person holding the
 * handset is entitled to their own information and to none of the others', and
 * this cannot tell which of them is typing — so it names no one and routes them
 * to a channel that can establish who they are.
 */
const ambiguousReply = () => (
    'This WhatsApp number is registered against more than one ACTIV account, so we '
    + 'cannot tell which one is yours from a message alone.\n\n'
    + `Please sign in at ${config.frontendUrl} to see your application, or email `
    + `${config.email.supportAddress} from your registered address.`
);

const notRegisteredReply = () => (
    'We could not find an ACTIV account registered to this WhatsApp number.\n\n'
    + `If you have an account under a different number, please sign in at ${config.frontendUrl} `
    + 'and update your phone number.\n\n'
    + `To join ACTIV, register at ${config.frontendUrl}`
);

const statusReply = async({ member, application }) => {
    const who = firstNameOf(member.fullName);

    if (!application) {
        return `Hello ${who}, your ACTIV account exists but no membership application has been `
            + `submitted yet.\n\nComplete your application at ${config.frontendUrl}`;
    }

    const status = normalizeStatus(application.status);
    const stage = STAGE_COPY[status] || status || 'In review';
    const region = [application.block, application.district, application.state]
        .filter(Boolean).join(', ');

    // The reference is the tail of the id, which is what every other surface in
    // the product shows a member. Printing the whole ObjectId reads as an error.
    const reference = String(application._id || '').slice(-6).toUpperCase();

    let reply = `Hello ${who}, here is your ACTIV application:\n\n`
        + `Status: ${stage}\n`
        + `Reference: ${reference}`;

    if (region) reply += `\nRegion: ${region}`;

    if (status === 'Rejected' && application.rejectionReason) {
        reply += `\n\nReason: ${application.rejectionReason}`;
    }

    // The one status that has something for the member to DO carries the link.
    if (status === 'Approved') {
        /*
         * AN APPLICATION STAYS `Approved` AFTER THE MEMBER PAYS.
         *
         * Payment is recorded on the MEMBER (`membershipStatus: 'active'`), not
         * on the application — `paymentOrder.completePayment` and
         * `payment.service` both write it there, and the workflow's terminal
         * `Approved` never moves again. So reading the application alone told
         * every paid member, for the rest of time, to "complete your payment to
         * activate your membership" and handed them the checkout link. The
         * website already knows better: `useMembershipGate` reads
         * `membershipStatus`, which is why the dashboard says active while this
         * said unpaid.
         *
         * `isPaidStatus` is the shared list, so this cannot drift from the
         * website's answer the way a second inline check would.
         */
        const { isPaidStatus } = require('../common/memberContext');

        if (isPaidStatus(member.membershipStatus)) {
            reply = `Hello ${who}, your ACTIV membership is ACTIVE.\n\n`
                + `Reference: ${reference}`
                + (region ? `\nRegion: ${region}` : '')
                + `\n\nYour certificates, the member directory and members-only events are all `
                + `open to you at ${config.frontendUrl}/payment/member-dashboard\n\n`
                + `Reply EVENTS for what is coming up, or HELP for your regional admin.`;
            return reply;
        }

        reply += `\n\nComplete your payment to activate your membership:\n${config.frontendUrl}/payment/membership-plans`;
    }

    reply += '\n\nReply HELP for your regional admin\'s contact details.';
    return reply;
};

const helpReply = async({ member, application }) => {
    const who = firstNameOf(member.fullName);

    const contact = application
        ? await regionalContacts.resolveForApplication(application)
        : await regionalContacts.resolveForRegion({
            state: member.state,
            district: member.district,
            block: member.block
        });

    if (!contact || !contact.nearest) {
        return `Hello ${who}, for help with your ACTIV membership please email `
            + `${config.email.supportAddress}`;
    }

    let reply = `Hello ${who}, here is who handles your ACTIV membership:\n\n`
        + `${regionalContacts.formatContact(contact.nearest)}`;

    /*
     * The rungs ABOVE the nearest one, when they are staffed.
     *
     * Not decoration: this platform does not require a parent admin to exist, so
     * a member's nearest contact can legitimately be their State Admin with
     * nothing beneath. Showing the chain tells them who to escalate to when the
     * first contact does not answer, which is the actual reason somebody types
     * HELP a second time.
     */
    const others = regionalContacts.TIER_ORDER
        .map((tier) => contact.contacts[tier])
        .filter((entry) => entry && entry.staffed && entry.tier !== contact.nearest.tier);

    if (others.length) {
        reply += '\n\n— Also available —\n'
            + others.map((entry) => regionalContacts.formatContact(entry)).join('\n\n');
    }

    reply += '\n\nReply STATUS for your application status, or EVENTS for the programme.';
    return reply;
};

/* ------------------------------------------------------------ EVENTS reply */

/**
 * The caller's own live bookings, found by the WhatsApp number they wrote from.
 *
 * By PHONE, not by account, because most bookings are made by guests who have
 * no account at all — they gave this number on the booking form, and it is the
 * number the confirmation was sent to. WhatsApp has already verified the
 * sender owns it, so answering with those bookings discloses them only to the
 * person who made them.
 */
const bookingsForPhone = async(rawPhone) => {
    try {
        const digits = String(botbeeService.normalizePhoneNumber(rawPhone) || '').replace(/\D/g, '');
        const last10 = digits.slice(-10);
        if (last10.length !== 10) return [];

        const EventBooking = require('../events/eventbooking.model');
        const tail = new RegExp(`${last10}$`);
        return await EventBooking.find({
            $or: [{ 'bookedBy.phone': tail }, { 'participants.phone': tail }],
            status: { $in: ['active', 'waitlist'] },
            $and: [{ $or: [{ eventStartAt: null }, { eventStartAt: { $gte: new Date(Date.now() - 12 * 3600 * 1000) } }] }]
        }).sort({ eventStartAt: 1 }).limit(5).lean();
    } catch (error) {
        logger.warn('WhatsApp bot could not look up bookings for a number', { error: error && error.message });
        return [];
    }
};

/** Upcoming events anybody may read — the same rule the public site applies. */
const publicUpcomingEvents = async() => {
    const Event = require('../events/event.model');
    const { onboardingClause } = require('../events/onboardingVisibility');
    return Event.find({
        status: 'published',
        audience: { $ne: 'paid' },
        $and: [
            onboardingClause(),
            { $or: [{ startAt: null }, { startAt: { $gte: new Date() } }] }
        ]
    }).sort({ startAt: 1 }).limit(5).lean().catch(() => []);
};

/** One event, written out the way a person would want to read it. */
const describeEventForChat = async(event, index) => {
    const bookingService = require('../events/eventbooking.service');
    const { dateLabel, timeLabel } = bookingService.describeSchedule(event.startAt, event.endAt);

    const venue = event.mode === 'online'
        ? `Online${event.onlinePlatform ? ` (${event.onlinePlatform})` : ''}`
        : [event.venue, event.venueAddress].filter(Boolean).join(', ');

    const fee = Number(event.registrationFee || 0);
    const member = event.memberFee !== null && event.memberFee !== undefined ? Number(event.memberFee) : null;
    const price = fee > 0
        ? `Rs ${fee.toLocaleString('en-IN')} per person${member !== null && member < fee
            ? ` (members Rs ${member.toLocaleString('en-IN')})` : ''}`
        : 'Free';

    let seats = '';
    try {
        const { capacity, seatsLeft } = await bookingService.seatsFor(event);
        if (capacity > 0) seats = seatsLeft > 0 ? `${seatsLeft} of ${capacity} seats left` : 'Fully booked';
    } catch { /* the count is a nicety */ }

    const id = String(event._id || event.id || '');
    const lines = [
        `*${index + 1}. ${event.title || 'Untitled event'}*`,
        `📅 ${dateLabel}${timeLabel ? `\n⏰ ${timeLabel}` : ''}`,
        venue ? `📍 ${venue}` : '',
        `💰 ${price}${seats ? `  ·  🎟️ ${seats}` : ''}`,
        event.registrationEnabled === false ? '' : `👉 Book now: ${config.frontendUrl}/events/${id}/book`
    ];
    return lines.filter(Boolean).join('\n');
};

/** "Your bookings", or nothing when there are none. */
const describeBookingsForChat = (bookings = []) => {
    if (!bookings.length) return '';
    const bookingService = require('../events/eventbooking.service');
    const rows = bookings.map((b) => {
        const { whenLabel } = bookingService.describeSchedule(b.eventStartAt, null);
        const paid = b.payment && b.payment.status;
        const state = b.status === 'waitlist' ? '⏳ Waitlist'
            : paid === 'paid' || paid === 'not_required' ? '✅ Confirmed'
                : '⚠️ Payment pending';
        const seats = Number(b.noOfPersons || 1);
        return `${state} — *${b.eventTitle || 'Event'}*\n`
            + `   📅 ${whenLabel}\n`
            + `   🔖 ${b.bookingRef} · ${seats} seat${seats === 1 ? '' : 's'}\n`
            + `   ${config.frontendUrl}/events/${String(b.eventId || '')}/book?ref=${encodeURIComponent(b.bookingRef)}`;
    });
    return `🎫 *Your bookings*\n\n${rows.join('\n\n')}`;
};

/**
 * EVENTS — the caller's bookings, then what is coming up.
 *
 * `member` is present for a number that matches an ACTIV account, and the
 * events are then the ones THAT member may see (their region, members-only
 * ones when their membership is active). For any other number the list is the
 * public programme — the same events the website shows to a visitor — so a
 * guest who booked a seat is answered rather than told they are "not
 * registered".
 */
const eventsReply = async({ member = null, phone = '' } = {}) => {
    const who = member ? firstNameOf(member.fullName) : '';

    try {
        let list = [];
        if (member) {
            const eventService = require('../events/event.service');
            const result = await eventService.listEvents(
                {
                    id: String(member._id || ''),
                    role: 'member',
                    state: member.state,
                    district: member.district,
                    block: member.block
                },
                { upcoming: true, limit: 5 }
            );
            const events = (result && (result.events || result.items || result)) || [];
            const ids = (Array.isArray(events) ? events : []).slice(0, 5)
                .map((e) => String((e && (e.id || e._id)) || '')).filter(Boolean);
            const Event = require('../events/event.model');
            const docs = ids.length ? await Event.find({ _id: { $in: ids } }).lean().catch(() => []) : [];
            // Keep the service's order (undated first, then soonest).
            list = ids.map((id) => docs.find((d) => String(d._id) === id)).filter(Boolean);
        } else {
            list = await publicUpcomingEvents();
        }

        const bookings = await bookingsForPhone(phone);
        const greeting = `👋 Hello${who ? ` ${who}` : ''}! Thank you for reaching out to *ACTIV*.`;

        const parts = [greeting];
        const mine = describeBookingsForChat(bookings);
        if (mine) parts.push(mine);

        if (list.length) {
            const described = [];
            for (let i = 0; i < list.length; i += 1) described.push(await describeEventForChat(list[i], i));
            parts.push(`🗓️ *Upcoming ACTIV events${member ? ' for you' : ''}*\n\n${described.join('\n\n')}`);
        } else {
            parts.push('🗓️ There are no upcoming ACTIV events open right now. '
                + 'We will message you as soon as the next one is announced.');
        }

        parts.push(`🌐 Full programme: ${config.frontendUrl}/events\n`
            + (member ? 'Reply *STATUS* for your membership · *HELP* for your regional admin'
                : `Not a member yet? Join ACTIV at ${config.frontendUrl}`));

        return parts.join('\n\n');
    } catch (error) {
        logger.warn('WhatsApp bot could not list events', { error: error && error.message });
        return `Hello${who ? ` ${who}` : ''}, the events list is unavailable right now. `
            + `You can see the full programme at ${config.frontendUrl}/events`;
    }
};

const menuReply = (identified) => {
    const intro = identified
        ? 'I did not recognise that.'
        : 'Welcome to ACTIV.';

    return `${intro} Reply with one of:\n\n`
        + 'STATUS — your membership application status\n'
        + 'HELP — your regional admin\'s contact details\n'
        + 'EVENTS — upcoming events in your region';
};

/* ---------------------------------------------------------------- the router */

/**
 * Pull `{ from, text }` out of whatever shape the provider posts.
 *
 * Written defensively on purpose. This is the one part of the integration whose
 * format is decided entirely by BotBee, and a body shaped differently from the
 * expectation must degrade to "no message found" — logged, answered 200 — rather
 * than throwing and being retried forever. The candidate paths cover the Meta
 * Cloud API envelope BotBee proxies as well as the flatter shapes providers
 * commonly send.
 */
const extractMessage = (body = {}) => {
    // Meta Cloud API shape, which BotBee forwards for WhatsApp Business.
    const change = body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0];
    const value = (change && change.value) || {};
    const metaMessage = value.messages && value.messages[0];

    if (metaMessage) {
        return {
            from: metaMessage.from,
            text: (metaMessage.text && metaMessage.text.body)
                || (metaMessage.button && metaMessage.button.text)
                || (metaMessage.interactive && metaMessage.interactive.list_reply
                    && metaMessage.interactive.list_reply.title)
                || (metaMessage.interactive && metaMessage.interactive.button_reply
                    && metaMessage.interactive.button_reply.title)
                || '',
            messageId: metaMessage.id
        };
    }

    // Flat shapes.
    const from = body.from || body.phone || body.phone_number || body.sender
        || body.mobile || body.waId || body.wa_id
        || (body.data && (body.data.from || body.data.phone_number));

    const text = body.text || body.message || body.body || body.content
        || (body.data && (body.data.text || body.data.message))
        || (typeof body.message === 'object' && body.message && body.message.text);

    if (!from) return null;

    return {
        from,
        text: typeof text === 'string' ? text : (text && text.body) || '',
        messageId: body.message_id || body.messageId || body.id
    };
};

/**
 * Handle one inbound message. Always resolves.
 *
 * Returns what was decided so the route can report it and the tests can assert
 * on it without a network call.
 */
const handleInbound = async(body = {}) => {
    const incoming = extractMessage(body);

    if (!incoming || !incoming.from) {
        logger.debug('BotBee webhook received a payload with no message', {
            keys: Object.keys(body || {})
        });
        return { handled: false, reason: 'no-message' };
    }

    // A status callback (delivered/read) is not a message and must not be
    // answered — replying to one would message the member every time a message
    // they were sent is marked delivered.
    if (!String(incoming.text || '').trim()) {
        return { handled: false, reason: 'no-text', from: incoming.from };
    }

    const command = parseCommand(incoming.text);
    const identity = await findMemberByPhone(incoming.from);

    let reply;
    if (identity && identity.ambiguous && command === 'EVENTS') {
        // The public programme and this number's own bookings belong to no one
        // account, so a number shared by several accounts can still have them.
        reply = await eventsReply({ phone: incoming.from });
    } else if (identity && identity.ambiguous) {
        // Checked BEFORE the command: every command discloses something about a
        // specific account, so there is no branch here that is safe to answer.
        reply = ambiguousReply();
    } else if (!identity) {
        // An unknown number gets the same answer whatever it asks. Varying the
        // reply by command would let a stranger probe which numbers are
        // registered, and the answer they need is the same either way.
        // EVENTS is the exception: the public programme and the bookings made
        // under this number are not account information, and most people who
        // booked a seat are guests with no account to find.
        reply = command === 'EVENTS'
            ? await eventsReply({ phone: incoming.from })
            : (command ? notRegisteredReply() : menuReply(false));
    } else if (command === 'STATUS') {
        reply = await statusReply(identity);
    } else if (command === 'HELP') {
        reply = await helpReply(identity);
    } else if (command === 'EVENTS') {
        reply = await eventsReply({ ...identity, phone: incoming.from });
    } else {
        reply = menuReply(true);
    }

    // A reply to an inbound message is inside the 24-hour session window by
    // construction, so free-form text is permitted here where an unprompted
    // message would have to be an approved template.
    const sent = await botbeeService.sendTextMessage(incoming.from, reply);

    await notificationService.log({
        user: identity && !identity.ambiguous && identity.member && identity.member._id,
        event: 'BOT_REPLY',
        channel: 'whatsapp',
        recipient: sent.to || String(incoming.from),
        subject: command || 'MENU',
        status: sent.success ? 'sent' : 'failed',
        mock: !!sent.mock,
        providerMessageId: sent.messageId,
        lastError: sent.error,
        data: { inbound: String(incoming.text).slice(0, 500), command, text: reply }
    });

    return {
        handled: true,
        command: command || 'MENU',
        identified: !!(identity && !identity.ambiguous),
        ambiguous: !!(identity && identity.ambiguous),
        from: incoming.from,
        reply,
        sent
    };
};

/**
 * The GET handshake BotBee performs when the webhook URL is saved.
 *
 * Meta's convention, which BotBee follows: echo `hub.challenge` back as plain
 * text when `hub.verify_token` matches the shared secret. A mismatch answers
 * 403 — accepting any token would let anyone point their own bot at this URL.
 *
 * With no `BOTBEE_WEBHOOK_VERIFY_TOKEN` configured the handshake is refused
 * rather than waved through. An open handshake is not a safe default just
 * because the deployment has not finished being set up.
 */
const verifyChallenge = (query = {}) => {
    const mode = query['hub.mode'] || query.mode;
    const token = query['hub.verify_token'] || query.verify_token;
    const challenge = query['hub.challenge'] || query.challenge;

    const expected = config.botbee.webhookVerifyToken;
    if (!expected) {
        return { ok: false, status: 503, body: 'BOTBEE_WEBHOOK_VERIFY_TOKEN is not configured' };
    }
    if (mode && mode !== 'subscribe') {
        return { ok: false, status: 400, body: 'Unsupported hub.mode' };
    }
    if (token !== expected) {
        return { ok: false, status: 403, body: 'Verification token mismatch' };
    }

    return { ok: true, status: 200, body: String(challenge || '') };
};

module.exports = {
    COMMANDS,
    ambiguousReply,
    parseCommand,
    extractMessage,
    findMemberByPhone,
    handleInbound,
    verifyChallenge,
    statusReply,
    helpReply,
    eventsReply,
    menuReply,
    notRegisteredReply
};
