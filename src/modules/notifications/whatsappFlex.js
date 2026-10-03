/**
 * THE FLEXIBLE EVENT TEMPLATES — one WhatsApp message per booking moment whose
 * fixed wording promises NOTHING about which facts an event has.
 *
 * =====================================================================
 * WHY THESE EXIST
 * =====================================================================
 *
 * The detailed booking templates (`activ_event_booking_v4` & co.) print every
 * fact on its own fixed line: "👤 Name:", "📱 Phone:", "• note 1", "• note 2".
 * Meta refuses an empty parameter and ACTIV refuses to invent one, so an event
 * whose editor left the organiser name or a second note blank could not use
 * them at all. The chain then fell to `cnfrm` (which fails "Translated text too
 * long", #132005, the moment the values are long) or to the generic MARKETING
 * notice, which Meta throttles on Indian numbers.
 *
 * Here the fixed text carries only the labels that are TRUE OF EVERY BOOKING —
 * when, where, booking ID, a link — and the parts that vary between events are
 * whole, composed lines. `{{5}}` above all: a "Details" segment assembled from
 * exactly the fields the event has (seats · fee · language · organiser · notes
 * · video …) and nothing else. An event with only a title and a date gets a
 * short, correct message; one with everything gets all of it.
 *
 * =====================================================================
 * EVERY VARIABLE IS ALWAYS GENUINELY FILLED
 * =====================================================================
 *
 *   name        the booker's / participant's name ("Member" only when none)
 *   title       the event's title
 *   when        date · time — "Date to be confirmed" is the event's own state
 *               when the organiser has not set one (the site says the same)
 *   where       venue + address (+ map), or how to attend online; "To be
 *               announced by the organiser" when there is no venue yet
 *   details     ALWAYS holds the seat count (a booking has ≥ 1 seat), and on a
 *               confirmation the fee (Free / Rs X paid) — so it is never empty
 *   booking ID  always exists on a booking
 *   link        the booking page, the pass, or the event page
 *
 * A step whose booking ID or link is genuinely missing is SKIPPED (and the skip
 * recorded), never padded.
 *
 * =====================================================================
 * META'S RULES, ENFORCED HERE
 * =====================================================================
 *
 *   - no newline, tab or run of >4 spaces inside a value (`one`)
 *   - no empty value (see above)
 *   - the RENDERED body ≤ 1024 characters — the #132005 failure. `fitDetails`
 *     drops the least important detail items first until it fits, measured in
 *     UTF-16 units (an emoji counts double, so the estimate is conservative).
 *   - no variable at the very start or end of a body; no two variables touching
 *   - UTILITY wording — transactional facts, no promotion
 *
 * PURE: no config, no database, no network. `notificationTemplates.js` wires
 * the steps into the send chains, flag-gated by the BOTBEE_TPL_*_FLEX names.
 */

/** Meta's ceiling on a rendered template body; kept a little under, to be safe. */
const BODY_LIMIT = 1024;
const BODY_BUDGET = 1000;

/** One line, collapsed whitespace, capped — the only shape a parameter may take. */
const one = (value, max = 300) => {
    const text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Free text that sits inside a sentence: no trailing punctuation. */
const clauseOf = (value, max = 200) => one(value, max).replace(/[.,;:\s]+$/, '');

/** "+918220112188" -> "+91 82201 12188"; anything else as typed. */
const prettyPhone = (value) => {
    const raw = one(value, 40);
    const m = raw.replace(/[\s-]/g, '').match(/^(?:\+?91)?(\d{5})(\d{5})$/);
    return m ? `+91 ${m[1]} ${m[2]}` : raw;
};

/**
 * What kind of online link the organiser pasted — the instructions differ:
 * `register` (a form; the joining link appears once it is submitted), `join`
 * (a direct meeting link), `none`.
 */
const onlineLinkKind = (url) => {
    const u = String(url || '').toLowerCase();
    if (!u) return 'none';
    if (/register|registration|forms\.|\/form|lu\.ma|eventbrite/.test(u)) return 'register';
    return 'join';
};

const SEP = ' · ';

/* =================================================================== segments */

/** "Member" only when the booking carries no name at all. */
const nameOf = (ctx = {}) => one(ctx.participantName || ctx.bookerName || ctx.name || ctx.firstName, 60) || 'Member';

const titleOf = (ctx = {}) => clauseOf(ctx.eventTitle, 120);

/**
 * "Saturday, 10 October 2026 · 9:00 AM – 5:00 PM IST". A reminder leads with
 * how soon: "Starts tomorrow · …". An undated event reads "Date to be
 * confirmed" — the event's actual state, which `describeSchedule` also prints.
 */
const whenOf = (ctx = {}, { reminder = false } = {}) => {
    const parts = [one(ctx.dateLabel, 80), one(ctx.timeLabel, 60)].filter(Boolean);
    const when = parts.join(SEP) || one(ctx.whenLabel, 120) || 'Date to be confirmed';
    const soon = reminder ? one(ctx.startsInLabel, 30) : '';
    return soon ? `Starts ${soon}${SEP}${when}` : when;
};

/**
 * WHERE, in person: the venue and its address, then the map when there is one.
 * ONLINE: the platform and what to do with the link the organiser published —
 * register, join, or (truthfully) that none is published yet. The start time is
 * named only when the event has one; no "join 5 minutes early" is invented.
 */
const whereOf = (ctx = {}, { withLink = true } = {}) => {
    if (ctx.isOnline) {
        const platform = one(ctx.onlinePlatform, 40);
        const head = platform ? `Online on ${platform}` : 'Online';
        if (!withLink) return head;
        const url = one(ctx.registerUrl, 400);
        const start = one(ctx.startClock, 30);
        const kind = onlineLinkKind(url);
        if (kind === 'register') {
            return `${head} — register at ${url} and your personal joining link appears as soon as you submit the form`
                + (start ? `; the event starts at ${start}` : '');
        }
        if (kind === 'join') return `${head} — join at ${url}${start ? ` for the ${start} start` : ''}`;
        return `${head} — the organiser has not published the joining link yet`;
    }
    const venue = one(ctx.venueLabel || ctx.venue, 220);
    const map = one(ctx.mapUrl, 300);
    if (venue && map) return `${venue}${SEP}Map: ${map}`;
    if (venue) return venue;
    if (map) return `Map: ${map}`;
    return 'To be announced by the organiser';
};

/** The organiser, only the parts the editor saved: "K. Ravi, +91 82201 12188, a@b.in". */
const contactOf = (ctx = {}) => [one(ctx.contactName, 80), prettyPhone(ctx.contactPhone), one(ctx.contactEmail, 120)]
    .filter(Boolean).join(', ');

/** The organiser's "Please note" lines, as typed, on one line. */
const notesOf = (ctx = {}) => String(ctx.attendeeNote || '')
    .split(/\r?\n/).map((l) => clauseOf(l, 180)).filter(Boolean).slice(0, 6).join('; ');

const seatCount = (ctx = {}) => {
    const n = Number(ctx.seats);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
};
const seatsOf = (ctx = {}) => one(ctx.seatsLabel, 40) || `${seatCount(ctx)} seat${seatCount(ctx) === 1 ? '' : 's'}`;

/**
 * THE MONEY, as it is: "Free entry"; "Rs 1,500 · Paid online"; "Rs 800 · Paid
 * to the organiser (UPI)". To a participant — who did not pay — who booked the
 * seat for them instead, because a fee line would read as a bill.
 */
const feeOf = (ctx = {}) => {
    if (ctx.forParticipant) {
        const booker = one(ctx.bookerName, 60);
        return booker ? `Booked for you by ${booker}` : 'Booked for you';
    }
    if (ctx.settledVia === 'free') return 'Free entry';
    return [one(ctx.amountLabel, 30), one(ctx.paymentLabel, 60)].filter(Boolean).join(SEP);
};

/**
 * The detail ITEMS for one kind of message, in display order. `rank` is how
 * much the item matters when the body is over Meta's length: the highest rank
 * is dropped first; rank 0 is never dropped. Only items with a value appear.
 *
 * Exported for tests: every combination of present and missing fields must
 * produce exactly the items that exist, and never an invented one.
 */
const detailItems = (kind, ctx = {}) => {
    const names = (Array.isArray(ctx.participantNames) ? ctx.participantNames : []).map((n) => one(n, 60)).filter(Boolean);
    const showNames = !ctx.forParticipant && (names.length > 1 || (names.length === 1 && names[0] !== nameOf(ctx)));
    const items = [];
    const add = (key, text, rank) => { if (text) items.push({ key, text, rank }); };

    if (kind === 'cancelled') {
        add('seats', `${seatsOf(ctx)} released`, 0);
        add('reason', ctx.reason ? `Reason: ${clauseOf(ctx.reason, 200)}` : '', 1);
        if (!ctx.forParticipant && ctx.settledVia !== 'free') {
            const paid = [one(ctx.amountLabel, 30), one(ctx.paymentLabel, 60)].filter(Boolean);
            add('fee', paid.length ? `Amount: ${paid.join(', ')}` : '', 3);
        }
        add('contact', contactOf(ctx) ? `Organiser: ${contactOf(ctx)}` : '', 2);
        return items;
    }

    if (kind === 'waitlist') {
        add('seats', `${seatsOf(ctx)} requested`, 0);
        add('language', ctx.language ? `Language: ${one(ctx.language, 40)}` : '', 3);
        add('contact', contactOf(ctx) ? `Organiser: ${contactOf(ctx)}` : '', 2);
        return items;
    }

    // confirmed (in person), online, reminder
    add('seats', seatsOf(ctx), 0);
    add('attendees', showNames ? `Attendees: ${names.join(', ')}` : '', 7);
    add('fee', feeOf(ctx), kind === 'reminder' ? 5 : 0);
    add('pass', !ctx.isOnline && ctx.registrationNo ? `Entry pass no.: ${one(ctx.registrationNo, 40)}` : '', 6);
    add('language', ctx.language ? `Language: ${one(ctx.language, 40)}` : '', 4);
    add('topic', ctx.topic ? `Topic: ${clauseOf(ctx.topic, 120)}` : '', 8);
    add('contact', contactOf(ctx) ? `Organiser: ${contactOf(ctx)}` : '', 2);
    add('notes', notesOf(ctx) ? `Note: ${notesOf(ctx)}` : '', 3);
    add('video', ctx.videoUrl ? `Event video: ${one(ctx.videoUrl, 300)}` : '', 9);
    add('whatsapp', ctx.whatsappChannelUrl ? `${require('../events/whatsappLink').whatsappLinkLabel(ctx.whatsappChannelUrl)}: ${ctx.whatsappChannelUrl}` : '', 0);
    return items;
};

/* ================================================================== templates */

const FOOTER = 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV';

/**
 * The bodies, one per moment. Each exists twice on Meta — with the event poster
 * as an IMAGE header and with no header — so a poster Meta cannot fetch does not
 * cost the booker their message.
 */
const BODIES = {
    /*
     * v1 and v2 were rejected by Meta's classifier as INCORRECT_CATEGORY. v3
     * mirrors the online body Meta APPROVED as utility, word for word except
     * "online event" -> "event" and "How to attend" -> "Where".
     */
    confirmed: 'Dear *{{1}}*,\n\n'
        + '✅ Your registration for the event *{{2}}* is confirmed.\n\n'
        + '🗓 *When:* {{3}}\n'
        + '📍 *Where:* {{4}}\n'
        + '📋 *Details:* {{5}}\n'
        + '🔖 *Booking ID:* {{6}}\n'
        + '🔗 *More details:* {{7}}\n\n'
        + 'Please keep your booking ID for any question about your registration.',
    online: 'Dear *{{1}}*,\n\n'
        + '✅ Your registration for the online event *{{2}}* is confirmed.\n\n'
        + '🗓 *When:* {{3}}\n'
        + '💻 *How to attend:* {{4}}\n'
        + '📋 *Details:* {{5}}\n'
        + '🔖 *Booking ID:* {{6}}\n'
        + '🔗 *More details:* {{7}}\n\n'
        + 'Please keep your booking ID for any question about your registration.',
    reminder: 'Dear *{{1}}*,\n\n'
        + '⏰ Reminder: your booked event *{{2}}* is coming up.\n\n'
        + '🗓 *When:* {{3}}\n'
        + '📍 *Where:* {{4}}\n'
        + '📋 *Details:* {{5}}\n'
        + '🔖 *Booking ID:* {{6}}\n'
        + '🔗 *More details:* {{7}}\n\n'
        + 'Please keep your booking ID ready for the event.',
    cancelled: 'Dear *{{1}}*,\n\n'
        + '❌ Your booking *{{2}}* for *{{3}}* has been cancelled by the organiser.\n\n'
        + '🗓 *Event date:* {{4}}\n'
        + '📋 *Details:* {{5}}\n'
        + '🔗 *More details:* {{6}}\n\n'
        + 'Please keep this message for your reference.',
    waitlist: 'Dear *{{1}}*,\n\n'
        + '🕒 *{{2}}* is fully booked, so your request is on the waitlist. No seat is held and nothing has been charged.\n\n'
        + '🗓 *When:* {{3}}\n'
        + '📍 *Where:* {{4}}\n'
        + '📋 *Details:* {{5}}\n'
        + '🔖 *Waitlist reference:* {{6}}\n'
        + '🔗 *More details:* {{7}}\n\n'
        + 'Please keep this reference for any question about your request.'
};

const PARAMS = {
    confirmed: ['name', 'event', 'when (date · time)', 'where (venue, address, map)', 'details (only what the event has)', 'booking ID', 'booking link'],
    online: ['name', 'event', 'when (date · time)', 'how to attend (platform + register/join link)', 'details (only what the event has)', 'booking ID', 'booking link'],
    reminder: ['name', 'event', 'when (starts in · date · time)', 'where, or how to attend online', 'details (only what the event has)', 'booking ID', 'booking link'],
    cancelled: ['name', 'booking ID', 'event', 'event date', 'details (seats released · reason · amount · organiser)', 'event link'],
    waitlist: ['name', 'event', 'when (date · time)', 'where', 'details (seats requested · language · organiser)', 'waitlist reference', 'event link']
};

/* Samples for Meta's review: ASCII separators, realistic, every slot filled. */
const SAMPLES = {
    confirmed: ['Tharun', 'Entrepreneurs Awareness Programme', 'Friday, 23 October 2026 | 9:00 AM - 5:00 PM IST',
        'Annamalai University, Chidambaram | Map: https://maps.app.goo.gl/abc123',
        '1 seat | Free entry | Language: Tamil | Organiser: K. Ravi, +91 98400 12345',
        'ACTIVB-MUHAF0VR-2EA6', 'https://activ.org.in/events/eap-2026/book?ref=ACTIVB-MUHAF0VR-2EA6'],
    online: ['Tharun', 'How to get business opportunities at NLC', 'Sunday, 27 September 2026 | 3:00 PM - 6:00 PM IST',
        'Online on Zoom - register at https://zoom.us/meeting/register/abc123 and your personal joining link appears as soon as you submit the form',
        '1 seat | Rs 500 | Paid online | Organiser: online@activ.org.in',
        'ACTIVB-MUHCP7NA-710D', 'https://activ.org.in/events/nlc-webinar/book?ref=ACTIVB-MUHCP7NA-710D'],
    reminder: ['Tharun', 'SCST Economic Liberty Conference', 'Starts tomorrow | Saturday, 10 October 2026 | 9:00 AM - 5:30 PM IST',
        'DNC Vijay Mahal, Dharmapuri | Map: https://maps.app.goo.gl/abc123',
        '2 seats | Attendees: Tharun, Priya | Note: Bring your visiting cards',
        'ACTIVB-MUEE9IBU-445B', 'https://activ.org.in/events/scst-conference/book?ref=ACTIVB-MUEE9IBU-445B'],
    cancelled: ['Tharun', 'ACTIVB-MUEE9IBU-445B', 'SCST Economic Liberty Conference', 'Saturday, 10 October 2026 | 9:00 AM IST',
        '1 seat released | Reason: Duplicate booking', 'https://activ.org.in/events/scst-conference'],
    waitlist: ['Tharun', 'SCST Economic Liberty Conference', 'Saturday, 10 October 2026 | 9:00 AM - 5:30 PM IST',
        'DNC Vijay Mahal, Dharmapuri', '2 seats requested', 'ACTIVB-MUEE9IBU-445B', 'https://activ.org.in/events/scst-conference']
};

/** Template names — the default each BOTBEE_TPL_*_FLEX flag resolves to when set to "true". */
const NAMES = {
    confirmed: { image: 'activ_evt_confirmed_v3', plain: 'activ_evt_confirmed_plain_v3' },
    online: { image: 'activ_evt_online_v1', plain: 'activ_evt_online_plain_v1' },
    reminder: { image: 'activ_evt_reminder_v1', plain: 'activ_evt_reminder_plain_v1' },
    cancelled: { image: 'activ_evt_cancelled_v1', plain: 'activ_evt_cancelled_plain_v1' },
    waitlist: { image: 'activ_evt_waitlist_v1', plain: 'activ_evt_waitlist_plain_v1' }
};

/** The env flag for each template: set to the APPROVED name (or `true`) to switch it on. */
const ENV_KEYS = {
    confirmed: { image: 'BOTBEE_TPL_BOOKING_FLEX', plain: 'BOTBEE_TPL_BOOKING_FLEX_PLAIN' },
    online: { image: 'BOTBEE_TPL_WEBINAR_FLEX', plain: 'BOTBEE_TPL_WEBINAR_FLEX_PLAIN' },
    reminder: { image: 'BOTBEE_TPL_REMINDER_FLEX', plain: 'BOTBEE_TPL_REMINDER_FLEX_PLAIN' },
    cancelled: { image: 'BOTBEE_TPL_CANCEL_FLEX', plain: 'BOTBEE_TPL_CANCEL_FLEX_PLAIN' },
    waitlist: { image: 'BOTBEE_TPL_WAITLIST_FLEX', plain: 'BOTBEE_TPL_WAITLIST_FLEX_PLAIN' }
};

/** `{{n}}` substituted — what the member's handset shows, for measuring. */
const renderBody = (body, params = []) => String(body).replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const v = params[Number(n) - 1];
    return v === undefined ? m : String(v);
});

/**
 * The details segment that fits: the items joined, with the highest-ranked
 * (least important) dropped one at a time while the whole rendered body is
 * over budget. `params` holds every other value with the details slot at
 * `slot` (0-based). Returns `{ text, dropped }`.
 */
const fitDetails = (body, params, slot, items, budget = BODY_BUDGET) => {
    let kept = items.slice();
    const dropped = [];
    const measure = () => {
        const p = params.slice();
        p[slot] = kept.map((i) => i.text).join(SEP);
        return renderBody(body, p).length;
    };
    while (measure() > budget) {
        const droppable = kept.filter((i) => i.rank > 0);
        if (!droppable.length) break;
        const worst = droppable.reduce((a, b) => (b.rank >= a.rank ? b : a));
        kept = kept.filter((i) => i !== worst);
        dropped.push(worst.key);
    }
    return { text: kept.map((i) => i.text).join(SEP), dropped };
};

/**
 * Last resort, after every optional detail is gone: shorten the longest
 * free-text value (never the booking ID or the link) until the body fits.
 */
const squeeze = (body, params, protectedSlots, budget = BODY_BUDGET) => {
    const p = params.slice();
    let guard = 0;
    while (renderBody(body, p).length > budget && guard < 50) {
        guard += 1;
        const over = renderBody(body, p).length - budget;
        let idx = -1;
        p.forEach((v, i) => { if (!protectedSlots.includes(i) && (idx < 0 || v.length > p[idx].length)) idx = i; });
        if (idx < 0 || p[idx].length < 20) break;
        p[idx] = `${p[idx].slice(0, Math.max(10, p[idx].length - over - 2))}…`;
    }
    return p;
};

/**
 * THE PARAMETERS for one flexible template, or `missing` naming what the
 * booking genuinely lacks (booking ID, link). `message` is one of
 * confirmed | online | reminder | cancelled | waitlist.
 *
 * Returns `{ params, missing, dropped, rendered }` — `rendered` being the body
 * the member would read, for tests and the dry run.
 */
const flexParams = (message, ctx = {}) => {
    const body = BODIES[message];
    if (!body) return { params: [], missing: [`unknown message "${message}"`], dropped: [], rendered: '' };
    const name = nameOf(ctx);
    const title = titleOf(ctx);
    const ref = one(ctx.bookingRef, 40);
    const items = detailItems(message === 'online' ? 'confirmed' : message, ctx);

    let link = '';
    if (message === 'cancelled' || message === 'waitlist') link = one(ctx.eventUrl || ctx.viewUrl, 400);
    else link = one(ctx.viewUrl || ctx.ticketUrl || ctx.eventUrl, 400);

    const missing = [];
    if (!title) missing.push('event title');
    if (!ref) missing.push('booking ID');
    if (!link) missing.push('booking link');
    if (!items.length) missing.push('details');
    if (missing.length) return { params: [], missing, dropped: [], rendered: '' };

    let params;
    let slot;
    let protectedSlots;
    if (message === 'cancelled') {
        params = [name, ref, title, whenOf(ctx), '', link];
        slot = 4;
        protectedSlots = [1, 4, 5];
    } else {
        const where = message === 'waitlist' ? whereOf(ctx, { withLink: false }) : whereOf(ctx);
        params = [name, title, whenOf(ctx, { reminder: message === 'reminder' }), where, '', ref, link];
        slot = 4;
        protectedSlots = [4, 5, 6];
    }
    const { text, dropped } = fitDetails(body, params, slot, items);
    params[slot] = text;
    params = squeeze(body, params.map((v) => one(v, 1024)), protectedSlots);
    return { params, missing: [], dropped, rendered: renderBody(body, params) };
};

/** The message a booking kind + format maps to. */
const messageFor = (kind, ctx = {}) => {
    if (kind === 'confirmed' || kind === 'participant') return ctx.isOnline ? 'online' : 'confirmed';
    if (kind === 'reminder') return 'reminder';
    if (kind === 'cancelled') return 'cancelled';
    if (kind === 'waitlist') return 'waitlist';
    return '';
};

/**
 * THE CHAIN STEPS, image variant first then the no-header one, for whichever
 * of them are switched on (`names` = `{ image, plain }` resolved from config).
 * Nothing is returned for a template that is not switched on, so until Meta has
 * approved one the chains behave exactly as before.
 */
const flexSteps = (kind, ctx = {}, names = {}, skipped = []) => {
    const message = messageFor(kind, ctx);
    const on = [names.image, names.plain].filter(Boolean);
    if (!message || !on.length) return [];
    const out = flexParams(message, ctx);
    if (out.missing.length) {
        on.forEach((t) => skipped.push(`${t} skipped: ${out.missing.join(', ')} not on the booking`));
        return [];
    }
    if (out.dropped.length) {
        skipped.push(`${on[0]}: left out ${out.dropped.join(', ')} to stay under Meta's ${BODY_LIMIT}-character limit`);
    }
    return ['image', 'plain'].flatMap((variant) => {
        const template = names[variant];
        if (!template) return [];
        const readable = READABLE_NAMES[message] && Object.values(READABLE_NAMES[message]).includes(template);
        const result = readable ? readableParams(message, ctx, '') : out;
        if (result.missing.length || result.rendered.length > BODY_LIMIT) {
            skipped.push(`${template} skipped: ${result.missing.join(', ') || 'message exceeds Meta body limit'}`);
            return [];
        }
        const steps = [{ template, params: result.params, ...(variant === 'plain' ? { noHeader: true } : {}) }];
        if (readable) {
            const layouts = [...new Set([readableLayout(ctx), readableLayout({ ...ctx, attachments: [] })])].filter(Boolean);
            for (const layout of layouts.reverse()) {
                const aligned = readableParams(message, ctx, layout);
                if (!aligned.missing.length && aligned.rendered.length <= BODY_LIMIT) {
                    steps.unshift({ template: readableTemplateName(message, ctx, variant, layout), params: aligned.params,
                        ...(variant === 'plain' ? { noHeader: true } : {}) });
                }
            }
        }
        return steps;
    });
};

// Separate variables and fixed line breaks are required: Meta's template
// parameters cannot contain newlines. Existing approved templates keep their
// seven-parameter contract until an approved readable name is configured.
const READABLE_NAMES = {
    confirmed: { image: 'activ_evt_confirmed_readable_v1', plain: 'activ_evt_confirmed_readable_plain_v1' },
    online: { image: 'activ_evt_online_readable_v1', plain: 'activ_evt_online_readable_plain_v1' },
};
const READABLE_BODIES = Object.fromEntries(Object.keys(READABLE_NAMES).map((message) => [message,
    'Dear *{{1}}*,\n\n'
    + '✅ Your event registration is confirmed.\n\n'
    + '*Event:* {{2}}\n\n'
    + '📅 *Date:* {{3}}\n'
    + '🕘 *Time:* {{4}}\n\n'
    + `${message === 'online' ? '💻 *Attendance:*' : '📍 *Venue:*'} {{5}}\n\n`
    + '🎟 *Seats:* {{6}}\n'
    + '💳 *Payment:* {{7}}\n\n'
    + '🔖 *Booking ID:* {{8}}\n'
    + '📋 *Entry reference:* {{9}}\n\n'
    + '🔗 *Booking details and event information:*\n{{10}}\n\n'
    + 'Please keep your booking ID for any question about your registration.'
]));

const firstDocument = (ctx = {}) => (ctx.attachments || []).find(a => a.url && (/\.pdf(?:\?|$)/i.test(a.url) || /application\/pdf/i.test(a.type || '')));
const readableLayout = (ctx = {}) => [ctx.whatsappChannelUrl ? 'whatsapp' : '', firstDocument(ctx) ? 'document' : '', ctx.videoUrl ? 'video' : ''].filter(Boolean).join('_');
const readableTemplateName = (message, ctx = {}, variant = 'image', layout = readableLayout(ctx)) => {
    return layout ? `activ_evt_${message}_${layout}_${variant}_${layout.includes('document') ? 'v3' : 'v2'}` : READABLE_NAMES[message][variant];
};
const readableBody = (message, layout = '') => {
    const original = READABLE_BODIES[message];
    if (!original || !layout) return original;
    let next = 11;
    const sections = [];
    if (layout.includes('whatsapp')) sections.push(`*{{${next++}}}:*\n{{${next++}}}`);
    if (layout.includes('document')) sections.push(`*Supporting PDF:* {{${next++}}}\n*Open document:* {{${next++}}}`);
    if (layout.includes('video')) sections.push(`*Event video:*\n{{${next++}}}`);
    return original.replace('Please keep your booking ID', sections.join('\n\n') + '\n\nPlease keep your booking ID');
};
const readableParams = (message, ctx = {}, layout = readableLayout(ctx)) => {
    const body = readableBody(message, layout);
    if (!body) return { params: [], missing: ['unsupported readable message'], rendered: '' };
    const ref = one(ctx.bookingRef, 40);
    const link = one(ctx.viewUrl || ctx.ticketUrl || ctx.eventUrl, 400);
    const title = titleOf(ctx);
    const missing = [];
    if (!ref) missing.push('booking ID');
    if (!link) missing.push('booking link');
    if (!title) missing.push('event title');
    if (missing.length) return { params: [], missing, rendered: '' };
    const document = firstDocument(ctx);
    const values = [
        nameOf(ctx), title,
        one(ctx.dateLabel, 80) || 'Date to be confirmed',
        one(ctx.timeLabel, 60) || 'Time to be confirmed',
        ctx.isOnline ? whereOf(ctx, { withLink: false }) : one(ctx.venueLabel || ctx.venue, 220) || 'To be announced by the organiser',
        seatsOf(ctx), feeOf(ctx) || 'See payment details in your booking',
        ref, one(ctx.registrationNo, 40) || ref, link,
        ...(layout.includes('whatsapp') ? [require('../events/whatsappLink').whatsappLinkLabel(ctx.whatsappChannelUrl), one(ctx.whatsappChannelUrl, 400)] : []),
        ...(layout.includes('document') ? [one(document.name, 90) || 'Event document.pdf', one(document.url, 400)] : []),
        ...(layout.includes('video') ? [one(ctx.videoUrl, 400)] : []),
    ];
    const params = squeeze(body, values, values.map((_, i) => i).filter(i => i >= 5));
    return { params, missing: [], rendered: renderBody(body, params) };
};

/** The entries for `WHATSAPP_TEMPLATES` — `meta: true`, so the booking script submits them. */
const TEMPLATE_DEFS = Object.keys(BODIES).flatMap((message) => ['image', 'plain'].map((variant) => ({
    name: NAMES[message][variant],
    envKey: ENV_KEYS[message][variant],
    flex: true,
    category: 'Utility',
    meta: true,
    ...(variant === 'image' ? { header: 'IMAGE' } : {}),
    footer: FOOTER,
    body: '(Meta template with variables - submit bodyWithVariables below)',
    bodyWithVariables: BODIES[message],
    params: PARAMS[message],
    samples: SAMPLES[message]
}))).concat(Object.keys(READABLE_NAMES).flatMap((message) => ['image', 'plain'].map((variant) => ({
    name: READABLE_NAMES[message][variant], envKey: ENV_KEYS[message][variant],
    flex: true, readable: true, category: 'Utility', meta: true,
    ...(variant === 'image' ? { header: 'IMAGE' } : {}), footer: FOOTER,
    body: '(Meta template with variables - submit bodyWithVariables below)',
    bodyWithVariables: READABLE_BODIES[message],
    params: ['name', 'event', 'date', 'time', 'venue or online platform', 'seats', 'payment', 'booking ID', 'entry reference', 'booking link'],
    samples: ['Tharun', 'Entrepreneurship Awareness Programme', 'Friday, 23 October 2026', '9:00 AM - 5:00 PM IST',
        message === 'online' ? 'Online on Zoom' : 'Chidambaram, Tamil Nadu, India', '1 seat', 'Rs 1,500 | Paid online',
        'ACTIVB-MURBHCAR-41FC', 'ACTIVB-MURBHCAR-41FC-P1', 'https://activ.org.in/events/awareness-programme-2026-10-23/book?ref=ACTIVB-MURBHCAR-41FC'],
}))));

// Fixed newlines belong to the approved body, never inside a URL parameter.
for (const message of Object.keys(READABLE_NAMES)) {
    for (const layout of ['whatsapp', 'video', 'whatsapp_video', 'document', 'whatsapp_document', 'document_video', 'whatsapp_document_video']) {
        for (const variant of ['image', 'plain']) {
            const original = TEMPLATE_DEFS.find(t => t.name === READABLE_NAMES[message][variant]);
            const ctx = { whatsappChannelUrl: layout.includes('whatsapp') ? 'https://chat.whatsapp.com/ExampleInvite' : '',
                attachments: layout.includes('document') ? [{name:'Agenda.pdf',url:'https://api.activ.org.in/uploads/agenda.pdf',type:'application/pdf'}] : [],
                videoUrl: layout.includes('video') ? 'https://youtu.be/example' : '' };
            TEMPLATE_DEFS.push({ ...original, name: readableTemplateName(message, ctx, variant),
                bodyWithVariables: readableBody(message, layout),
                params: [...original.params, ...(ctx.whatsappChannelUrl ? ['WhatsApp link label', 'WhatsApp group link'] : []), ...(ctx.attachments.length ? ['PDF name', 'PDF URL'] : []), ...(ctx.videoUrl ? ['video link'] : [])],
                samples: [...original.samples, ...(ctx.whatsappChannelUrl ? ['WhatsApp group', ctx.whatsappChannelUrl] : []), ...(ctx.attachments.length ? [ctx.attachments[0].name, ctx.attachments[0].url] : []), ...(ctx.videoUrl ? [ctx.videoUrl] : [])],
            });
        }
    }
}

/**
 * Meta's submission rules, checked before anything is sent for review. Returns
 * a list of problems (empty = fine). Used by the script's dry run and by tests.
 */
const lintTemplate = (t = {}) => {
    const problems = [];
    const body = String(t.bodyWithVariables || '');
    const vars = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    const distinct = [...new Set(vars)];
    if (distinct.some((n, i) => n !== i + 1)) problems.push('variables are not numbered 1..n in order');
    if (/^\s*\{\{\d+\}\}/.test(body)) problems.push('body starts with a variable');
    if (/\{\{\d+\}\}\s*$/.test(body)) problems.push('body ends with a variable');
    if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) problems.push('two variables touch');
    if (body.length > BODY_LIMIT) problems.push(`body is ${body.length} characters (limit ${BODY_LIMIT})`);
    const samples = Array.isArray(t.samples) ? t.samples : [];
    if (samples.length !== distinct.length) problems.push(`${distinct.length} variables but ${samples.length} samples`);
    samples.forEach((s, i) => {
        if (!String(s || '').trim()) problems.push(`sample {{${i + 1}}} is empty`);
        if (/[\n\t]| {5,}/.test(String(s))) problems.push(`sample {{${i + 1}}} has a newline, tab or 5+ spaces`);
    });
    if (renderBody(body, samples).length > BODY_LIMIT) problems.push('rendered sample is over the limit');
    if (t.footer && String(t.footer).length > 60) problems.push('footer over 60 characters');
    return problems;
};

module.exports = {
    BODY_LIMIT,
    BODY_BUDGET,
    BODIES,
    NAMES,
    ENV_KEYS,
    TEMPLATE_DEFS,
    READABLE_NAMES,
    READABLE_BODIES,
    readableParams,
    readableTemplateName,
    detailItems,
    whenOf,
    whereOf,
    feeOf,
    contactOf,
    notesOf,
    flexParams,
    flexSteps,
    messageFor,
    renderBody,
    lintTemplate,
    prettyPhone,
    onlineLinkKind
};
