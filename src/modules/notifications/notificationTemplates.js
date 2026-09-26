const config = require('../../config');

/**
 * What each lifecycle event SAYS, on all three channels, in one place.
 *
 * The bell, the email and the WhatsApp message are three renderings of one
 * fact — "your application cleared the block review" — and when each is written
 * at its own call site they drift: the notification says the district has it,
 * the email says the block does, and the member has no way to tell which is
 * current. Everything a channel needs for an event is declared here once, and
 * `notification.service.dispatchLifecycleEvent` renders all three from it.
 *
 * WHATSAPP TEMPLATES ARE NOT WRITTEN HERE — they are written on the BotBee
 * dashboard and approved by Meta, and what this file holds is the NAME of the
 * approved template plus the ordered list of variables it takes. The body text
 * below it is the fallback used inside an open 24-hour session window (a reply
 * to the bot) and by mock mode. Sending a template that has not been approved
 * under that exact name is rejected by the provider, so the names here have to
 * match the dashboard exactly; they are listed in the setup notes.
 *
 * `WHATSAPP_TEMPLATES` at the bottom is the checklist to create on BotBee.
 */

/** The approved template names, overridable per deployment. */
const TPL = config.botbee.templates;

const appUrl = (path = '') => {
    const base = String(config.frontendUrl || '').replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
};

/** Free text from a person, on one line — a rejection reason in a WhatsApp param. */
const oneLine = (value, max = 220) => {
    const text = String(value === null || value === undefined ? '' : value)
        .replace(/\s+/g, ' ')
        .trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Free text that has to sit INSIDE somebody else's sentence.
 *
 * The approved status template reads `… is now {2}, {3}. Reply STATUS …`, so
 * the third value lands mid-sentence with a full stop already waiting for it.
 * A rejection reason typed by an admin almost always ends in one of its own,
 * and the two together render as "…upload a clear copy.. Reply STATUS", which
 * a member reads as a broken message rather than as a reason.
 *
 * So: one line (Meta refuses a parameter containing a newline outright), and no
 * trailing sentence punctuation. The stop belongs to the template.
 */
const clause = (value, max = 200) => oneLine(value, max).replace(/[.,;:\s]+$/, '');

/** HTML-escape a value typed by a person (a participant name, a reason). */
const esc = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Where an event button goes.
 *
 * The PUBLIC event page (or the booking itself when there is a reference),
 * never `/member/events`: a guest who booked has no account, and a
 * members-only link sent every one of them to the login screen.
 */
const eventLink = (ctx = {}) => {
    const data = ctx.data || {};
    const id = data.eventId || ctx.eventId || '';
    if (!id) return appUrl('/events');
    const ref = data.bookingRef || ctx.bookingRef || '';
    return appUrl(`/events/${encodeURIComponent(id)}${ref ? `/book?ref=${encodeURIComponent(ref)}` : ''}`);
};

/** The organiser's note, one point per line — typed on the event form. */
const noteLinesOf = (ctx = {}) => String(ctx.attendeeNote || '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12);

/**
 * THE LAST THING IN A BOOKING EMAIL: what to do before the event.
 *
 * The organiser's own note ("Please note" on the event page) leads, because it
 * is the part written for THIS event. A short standing list follows, worded
 * for a webinar or for a hall — a webinar has no registration desk. Placed at
 * the END of the email (`afterHtml`), after the details and the buttons: it is
 * read once the reader knows what they booked, not before.
 */
const beforeYouComeHtml = (ctx = {}) => {
    const notes = noteLinesOf(ctx);
    const standing = ctx.isOnline
        ? [
            'Join 5–10 minutes early to check your audio and video.',
            'A laptop or phone with a stable connection works best.'
        ]
        : [
            'Arrive 15–30 minutes early for registration.',
            'Carry a photo ID for each participant.'
        ];
    if (ctx.settledVia && ctx.settledVia !== 'free') {
        standing.push('Fees are non-refundable; participant names can be changed.');
    }
    /*
     * NEVER SAY IT TWICE. A standing tip the organiser's own note already
     * covers ("Carry a government photo ID" and "Carry a photo ID for each
     * participant") is dropped — the organiser's wording wins.
     */
    const TOPICS = [/\b(photo\s*)?id\b/i, /\b(early|arrive|join\s+\d)/i, /\b(refund|fee)/i, /\b(audio|video|connection)/i];
    const covered = (tip) => TOPICS.some((re) => re.test(tip) && notes.some((n) => re.test(n)));
    const items = [...notes, ...standing.filter((tip) => !covered(tip))];
    const heading = notes.length ? 'Please note' : (ctx.isOnline ? 'Before the webinar' : 'Before you come');

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background-color:#f5f8ff; border:1px solid #dbe4fb; border-radius:14px; border-collapse:separate;">
        <tr><td style="padding:18px 20px 12px 20px;">
          <div style="font-size:12px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase; color:#1d4ed8;
                      padding-bottom:10px;">${heading}</div>
          ${items.map((i, n) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
            <td width="28" valign="top" style="width:28px; padding:0 0 8px 0;">
              <div style="width:20px; height:20px; border-radius:10px; background-color:${n < notes.length ? '#1d4ed8' : '#dbeafe'};
                          color:${n < notes.length ? '#ffffff' : '#1d4ed8'};
                          font-size:11px; line-height:20px; font-weight:800; text-align:center;">&#10003;</div></td>
            <td valign="top" style="font-size:14px; line-height:1.55; color:#1e293b; padding:0 0 8px 0;
                                    ${n < notes.length ? 'font-weight:600;' : ''}">${esc(i)}</td>
          </tr></table>`).join('')}
        </td></tr>
      </table>`;
};

/**
 * A booking message's WhatsApp template: the DETAILED one when it has been
 * approved and named in the environment, the generic event template otherwise.
 *
 * The detailed templates carry the event POSTER as an image header, so
 * `headerImage` rides with them — and ONLY with them: the generic template has
 * no header, and Meta refuses a header parameter on a template without one.
 * `fallback` is retried once by `notification.service` if the detailed send
 * fails (still in review, renamed), so the booker hears something either way.
 */
const bookingWhatsApp = (dedicatedName, dedicatedParams, eventParams, poster = '') => (dedicatedName
    ? {
        template: dedicatedName,
        params: dedicatedParams,
        headerImage: poster || DEFAULT_WHATSAPP_POSTER(),
        fallback: { template: TPL.event, params: eventParams }
    }
    : { template: TPL.event, params: eventParams });

/** The association, as it signs a message — never "ACTIV Platform". */
const ORG_SIGNATURE = 'Adidravidar Confederation of Trade & Industrial Vision (ACTIV)';

/** A template name from config, with `none` meaning "switched off". */
const tplOn = (name) => (name && String(name).toLowerCase() !== 'none' ? name : '');

/** "₹1,500" -> "1,500"; the in-person template prints its own ₹. */
const amountDigits = (ctx = {}) => String(ctx.amountLabel || '').replace(/[^\d.,]/g, '');

/**
 * The link an online booker needs: the event's REGISTRATION link (Zoom's own
 * form — the booker enters their name and email there and Zoom emails the
 * joining link). Until the organiser has added one, the booking page.
 */
const registerLink = (ctx = {}) => ctx.registerUrl
    || `${ctx.viewUrl || ctx.eventUrl || appUrl('/events')} (the registration link will be added here soon)`;

/** "Dear Tharun" — the full name the booker gave, first name as a fallback. */
// A participant's own name first: their message is about THEIR seat, not the booker's.
const greetName = (ctx = {}) => oneLine(ctx.participantName || ctx.bookerName || ctx.name || ctx.firstName, 60) || 'Member';

/** "+918220112188" -> "+91 82201 12188"; anything else as typed. */
const prettyPhone = (value) => {
    const raw = oneLine(value, 40);
    const m = raw.replace(/[\s-]/g, '').match(/^(?:\+?91)?(\d{5})(\d{5})$/);
    return m ? `+91 ${m[1]} ${m[2]}` : raw;
};

/** The organiser, as three separate values — name, phone, email — each on its own line. */
const contactParts = (ctx = {}) => [
    oneLine(ctx.contactName, 80) || 'ACTIV Office',
    prettyPhone(ctx.contactPhone) || '+91 82201 12188',
    oneLine(ctx.contactEmail, 120) || 'enquiry@activ.org.in'
];

/** Exactly two "Please note" points: the organiser's own first, the standing advice after. */
const tipPair = (ctx = {}) => {
    const notes = noteLinesOf(ctx).map((n) => clause(n, 180));
    const standing = standingTips(ctx);
    const list = [...notes, ...standing].filter(Boolean);
    return [list[0] || standing[0], notes.length > 1 ? notes.slice(1).join('; ') : (list[1] || standing[1])];
};

/**
 * WHAT KIND OF ONLINE LINK THE ORGANISER PASTED, because the instructions differ:
 *
 *   register  a registration form (zoom.us/meeting/register/…, /webinar/register/…,
 *             forms, Meet with a "register" path). The booker submits it and the
 *             platform shows their personal joining link on the spot.
 *   join      a direct meeting link (zoom.us/j/…, meet.google.com/…, teams …/l/meetup-join).
 *   none      nothing yet.
 */
const onlineLinkKind = (url) => {
    const u = String(url || '').toLowerCase();
    if (!u) return 'none';
    if (/register|registration|forms\.|\/form|lu\.ma|eventbrite/.test(u)) return 'register';
    return 'join';
};

/** The three pieces of the webinar message that depend on the link kind. */
const webinarLinkLines = (ctx = {}) => {
    const platform = ctx.onlinePlatform || 'webinar';
    const kind = onlineLinkKind(ctx.registerUrl);
    if (kind === 'register') {
        return [
            `Final step: complete your ${platform} registration`,
            ctx.registerUrl,
            'As soon as you submit that form, your personal joining link appears on the screen. '
                + 'Save it, and join 5-10 minutes before the start'
        ];
    }
    if (kind === 'join') {
        return [
            `Your ${platform} joining link`,
            ctx.registerUrl,
            'Tap the link 5-10 minutes before the start to check your audio and video. Please keep it to yourself'
        ];
    }
    return [
        'Your joining link',
        'The organiser will share it here before the webinar starts',
        `Your seat is saved. Keep your booking ID handy: ${ctx.bookingRef || ''}`.trim()
    ];
};

/** The fee, or — to a participant, who did not pay — who booked the seat for them. */
const feeOrBooker = (ctx = {}, rupee = 'Rs ') => (ctx.forParticipant
    ? `Booked for you by ${oneLine(ctx.bookerName, 60) || 'your organisation'}`
    : orDash(feeLine(ctx, rupee)));

/**
 * A booking's context, as ONE PARTICIPANT sees it: their own seat and name,
 * no payment (the booker paid, and a fee line would read as a bill), and their
 * own email where the webinar template names one.
 */
const asParticipant = (ctx = {}) => ({
    ...ctx,
    seats: 1,
    seatsLabel: '1 seat',
    participantNames: [ctx.participantName].filter(Boolean),
    firstName: String(ctx.participantName || '').split(/\s+/).filter(Boolean)[0] || ctx.firstName,
    bookerEmail: ctx.participantEmail || '',
    viewUrl: '',
    forParticipant: true
});

/**
 * The one link in a participant's message, with a short label for "🔗 *label:* link":
 * the map in person; online, "Register here" / "Join link" by what was pasted.
 */
const participantLink = (ctx = {}) => {
    if (!ctx.isOnline) return ['Directions', ctx.mapUrl || ctx.eventUrl || ctx.viewUrl || ''];
    const kind = onlineLinkKind(ctx.registerUrl);
    if (kind === 'register') return ['Register here', ctx.registerUrl];
    if (kind === 'join') return ['Join link', ctx.registerUrl];
    return ['Event page', ctx.eventUrl || ctx.viewUrl || ''];
};

/**
 * THE CUSTOM TEMPLATES, newest first. Each kind returns the `_v3` step (every
 * tip and every contact detail on its own line) and the approved `_v2` step
 * behind it, so a `_v3` still in Meta review falls back to `_v2`, not to the
 * old poster templates.
 */
const V2 = {
    webinar: 'activ_webinar_registration_v2',
    inPerson: 'activ_event_booking_v2',
    reminder: 'activ_booking_reminder_v2'
};

const customTemplates = (kind, ctx = {}) => {
    const title = clause(ctx.eventTitle, 120) || 'the event';
    const date = orDash(ctx.dateLabel, 'Date to be confirmed');
    const time = orDash(ctx.timeLabel, 'Time to be confirmed');
    const ref = ctx.bookingRef || 'See your email';
    const [tip1, tip2] = tipPair(ctx);
    const [cName, cPhone, cEmail] = contactParts(ctx);
    const orgLine = orDash(ctx.contactLine, 'the ACTIV office, +91 82201 12188');
    const steps = [];

    /*
     * A PARTICIPANT's seat, booked by somebody else. Their own template first
     * (it names the booker), then the ordinary confirmation for the event's format.
     */
    if (kind === 'participant') {
        const [label, plink] = participantLink(ctx);
        if (tplOn(TPL.bookingParticipant)) {
            steps.push({
                template: TPL.bookingParticipant,
                params: [greetName(ctx), oneLine(ctx.bookerName, 60) || 'Your organisation', title, date, time,
                    orDash(whereLine(ctx)), label, orDash(plink, 'See your email'), ref, tip1, tip2, cName, cPhone, cEmail]
            });
        }
        return [...steps, ...customTemplates('confirmed', ctx)];
    }

    if (kind === 'confirmed' && ctx.isOnline) {
        const [head, link, how] = webinarLinkLines(ctx);
        if (tplOn(TPL.bookingWebinar)) {
            steps.push({
                template: TPL.bookingWebinar,
                params: [greetName(ctx), title, date, time, orDash(ctx.onlinePlatform, 'Online'), ref,
                    head, orDash(link), orDash(how), cName, cPhone, cEmail]
            });
        }
        steps.push({
            template: V2.webinar,
            params: [greetName(ctx), title, date, time, orDash(ctx.onlinePlatform, 'Online'), ref,
                registerLink(ctx), oneLine(ctx.bookerEmail, 120) || 'the email address you register with', orgLine]
        });
    } else if (kind === 'confirmed') {
        if (tplOn(TPL.booking)) {
            steps.push({
                template: TPL.booking,
                params: [greetName(ctx), title, date, time,
                    orDash(ctx.venueLabel, 'Venue to be announced'),
                    orDash(ctx.mapUrl || ctx.viewUrl, 'Shared before the event'),
                    orDash(seatsLine(ctx)), feeOrBooker(ctx), ref,
                    tip1, tip2, cName, cPhone, cEmail]
            });
        }
        steps.push({
            template: V2.inPerson,
            params: [greetName(ctx), title, date, time,
                orDash(ctx.venueLabel, 'Venue to be announced'),
                orDash(ctx.mapUrl || ctx.viewUrl, 'Shared before the event'),
                orDash(`${seatsLine(ctx)} | ${feeOrBooker(ctx)}`), ref, `${tip1}; ${tip2}`, orgLine]
        });
    } else if (kind === 'reminder') {
        const [head, link] = ctx.isOnline ? webinarLinkLines(ctx) : ['Directions', ctx.mapUrl || ctx.viewUrl];
        if (tplOn(TPL.bookingReminder)) {
            steps.push({
                template: TPL.bookingReminder,
                params: [greetName(ctx), title, ctx.startsInLabel || 'soon', date, time, orDash(whereLine(ctx)),
                    head, orDash(link, 'See your booking email'), ref, tip1, tip2, cName, cPhone, cEmail]
            });
        }
        steps.push({
            template: V2.reminder,
            params: [greetName(ctx), title, ctx.startsInLabel || 'soon', date, time, orDash(whereLine(ctx)),
                orDash(link, 'See your booking email'), ref, `${tip1}; ${tip2}`, orgLine]
        });
    }
    return steps.filter((s) => s.template);
};

/**
 * THE POSTER TEMPLATES ALREADY APPROVED ON THE ACCOUNT — the stop-gap while
 * the custom ones are in Meta review. Their wording is fixed; only the values
 * are ours:
 *
 *   in person (`cnfrm`, 13 slots) registrant name, mobile, email; event
 *     (category), venue (+ map), date, time from/to, tickets, amount paid.
 *   online (`ccmsg`, 4 slots) name, event + date + platform, link, email. Its
 *     fixed text calls the link a "Join Link", so the value itself says it is
 *     the registration form.
 */
const posterTemplate = (ctx = {}) => {
    const title = clause(ctx.eventTitle, 110) || 'the event';
    const name = greetName(ctx);
    const email = oneLine(ctx.bookerEmail, 120);
    const names = (Array.isArray(ctx.participantNames) ? ctx.participantNames : []).filter(Boolean);

    if (ctx.isOnline) {
        const template = tplOn(TPL.bookingOnline);
        return template && {
            template,
            params: [
                name,
                `${title} | ${ctx.whenLabel || 'Date to be confirmed'}${ctx.onlinePlatform ? ` | on ${ctx.onlinePlatform}` : ''}`,
                `${registerLink(ctx)} - open this to REGISTER; your personal joining link then arrives by email`,
                email || 'on your booking'
            ]
        };
    }

    const template = tplOn(TPL.bookingInPerson);
    return template && {
        template,
        params: [
            name,
            title,
            names.length ? names.join(', ') : name,
            oneLine(ctx.bookerPhone, 30) || 'Not given',
            email || 'Not given',
            ctx.category ? `${title} (${clause(ctx.category, 40)})` : title,
            orDash([ctx.venueLabel, ctx.mapUrl ? `Map: ${ctx.mapUrl}` : ''].filter(Boolean).join(' | '), 'Venue to be announced'),
            orDash(ctx.dateLabel, 'Date to be confirmed'),
            ctx.startTimeLabel || 'To be confirmed',
            ctx.endTimeLabel || 'the close of the programme',
            `${ctx.seats || 1}${names.length ? ` (${names.join(', ')})` : ''}`,
            ctx.settledVia === 'free' ? '0 (Free entry)' : `${amountDigits(ctx) || '0'} (${ctx.paymentLabel || 'Paid'})`,
            email || 'on your booking'
        ]
    };
};

/**
 * Which template a confirmation / reminder goes out on, as a CHAIN walked by
 * `notification.service`: the custom `_v2` template first, the approved poster
 * template if Meta refuses it (still in review), the generic notice last. Once
 * the custom one is approved it is the only one ever sent — no redeploy.
 */
const richBookingWhatsApp = (kind, eventParams, ctx = {}) => {
    const image = ctx.posterUrl || DEFAULT_WHATSAPP_POSTER();
    const steps = [...customTemplates(kind, ctx), posterTemplate(ctx)]
        .filter(Boolean)
        .map((s) => ({ ...s, headerImage: image }));
    steps.push({ template: TPL.event, params: eventParams });
    return steps.reduceRight((next, step) => (next ? { ...step, fallback: next } : step), null);
};

/**
 * An image-header template cannot be sent WITHOUT an image, so an event with no
 * poster of its own gets the ACTIV logo from the website instead.
 */
const DEFAULT_WHATSAPP_POSTER = () => process.env.WHATSAPP_DEFAULT_POSTER_URL
    || appUrl('/logo_ACTIVian-removebg-preview.png');

/** A parameter value that is never empty — Meta refuses an empty one. */
const orDash = (value, dash = 'Not specified') => oneLine(value, 300) || dash;

/** "1 seat · Tharun, Ravi" — the seats, with the names when there are any. */
const seatsLine = (ctx = {}) => {
    const names = (Array.isArray(ctx.participantNames) ? ctx.participantNames : []).filter(Boolean);
    return [ctx.seatsLabel, names.join(', ')].filter(Boolean).join(' · ');
};

/** "Free", or "₹500 · Paid online". Free events carry no payment line at all. */
const feeLine = (ctx = {}, rupee = '₹') => {
    if (ctx.settledVia === 'free') return 'Free';
    const amount = String(ctx.amountLabel || '').replace('₹', rupee);
    return [amount, ctx.paymentLabel].filter(Boolean).join(' · ');
};

/**
 * The Details card of a booking email — ONE place for every fact, so the
 * sentences above it do not have to repeat them. Empty rows are dropped by the
 * email shell, so an event without a topic or a language simply has no row.
 */
const bookingFacts = (ctx = {}, { payment = true, seatsLabel = 'Seats' } = {}) => [
    { label: 'Date', value: ctx.dateLabel },
    { label: 'Time', value: ctx.timeLabel },
    { label: 'Format', value: ctx.formatLabel },
    ctx.isOnline
        ? { label: 'Registration link', value: ctx.registerUrl || (ctx.kind === 'confirmed' || ctx.kind === 'reminder'
            ? 'Shared with you soon' : '') }
        : { label: 'Venue', value: ctx.venueLabel || 'To be announced' },
    { label: 'Topic', value: ctx.topic },
    { label: 'Language', value: ctx.language },
    { label: seatsLabel, value: seatsLine(ctx) },
    // ONE row for the money: "Free", or "₹500 · Paid online".
    ...(payment ? [{ label: ctx.settledVia === 'free' ? 'Entry' : 'Fee', value: feeLine(ctx) }] : []),
    { label: 'Organiser', value: ctx.contactLine }
];

/** The one sentence about money in a confirmation — none for a free event. */
const settledSentence = (ctx = {}) => {
    if (ctx.settledVia === 'online') return ` Payment of <strong>${esc(ctx.amountLabel)}</strong> received.`;
    if (ctx.settledVia === 'offline') {
        return ` The organiser has received your payment of <strong>${esc(ctx.amountLabel)}</strong>`
            + `${ctx.paymentModeLabel ? ` (${esc(ctx.paymentModeLabel)})` : ''}.`;
    }
    return '';
};

/** A WhatsApp free-text block, one fact per line, blank facts skipped. */
const waLines = (rows) => rows.filter(([, v]) => v).map(([icon, v]) => `${icon} ${v}`).join('\n');

/** Where to be: "Online webinar on Zoom", or the venue and its address. */
const whereLine = (ctx = {}) => (ctx.isOnline
    ? (ctx.formatLabel || 'Online webinar')
    : (ctx.venueLabel || 'Venue to be announced'));


/** The standing advice, worded for a webinar or for a hall. */
const standingTips = (ctx = {}) => (ctx.isOnline
    ? ['Join 5 to 10 minutes before the start to check your audio and video', 'Use a laptop or phone with a stable internet connection']
    : ['Please arrive 15 to 30 minutes before the start time for registration', 'Carry a valid photo ID for each participant']);

/**
 * The written-out WhatsApp message (session window / text fallback) for a
 * confirmation or reminder: heading, one line of lead, then one fact per line
 * with an icon, the organiser's notes, and a contact. Crisp on a phone screen.
 */
const bookingText = (ctx = {}, { heading, lead, closing }) => {
    const online = !!ctx.isOnline;
    const notes = noteLinesOf(ctx);
    const tips = tipPair(ctx);
    const [linkHead, link, linkHow] = online ? webinarLinkLines(ctx) : ['', '', ''];
    const [cName, cPhone, cEmail] = contactParts(ctx);
    return `${heading}\n\n`
        + `Dear ${greetName(ctx)}, Jaibhim! 🙏\n${lead}\n\n`
        + waLines([
            ['🗓', ctx.dateLabel],
            ['⏰', ctx.timeLabel],
            [online ? '💻' : '📍', whereLine(ctx)],
            ['👉', online ? `*${linkHead}*\n${link}` : ''],
            ['💡', online ? linkHow : ''],
            ['🗺', !online && ctx.mapUrl ? `Directions: ${ctx.mapUrl}` : ''],
            ['🏷', [ctx.topic, ctx.language].filter(Boolean).join(' · ')],
            ['🎟', seatsLine(ctx)],
            ['💳', ctx.kind === 'reminder' ? '' : feeOrBooker(ctx, '₹')],
            ['🔖', ctx.bookingRef ? `Booking ID: ${ctx.bookingRef}` : '']
        ])
        + `\n\n📌 *${notes.length ? 'Please note' : (online ? 'Before the webinar' : 'Before you come')}*\n`
        + tips.map((n) => `• ${n}`).join('\n')
        + `\n\n📞 *Need help? Contact the organiser*\n👤 *Name:* ${cName}\n📱 *Phone:* ${cPhone}\n📧 *Email:* ${cEmail}`
        + (ctx.viewUrl ? `\n🔎 Your booking: ${ctx.viewUrl}` : '')
        + `\n\n${closing}\n— ${ORG_SIGNATURE}`;
};

/**
 * Every event, and what it renders to.
 *
 * Each builder receives `{ name, firstName, ...payload }` and returns:
 *
 *   inApp     { title, message, type }        the bell — always attempted
 *   email     { subject, title, bodyHtml, ... } omitted for events with no email
 *   whatsapp  { template, params, text }      omitted for events with no message
 *
 * An event that omits a channel is not a failure and is not logged as one: a
 * payment reminder belongs in email and WhatsApp, and putting it in the bell as
 * well would be the third copy of a thing the member has already been told.
 */
const TEMPLATES = {
    /* ------------------------------------------------------ account created */
    ACCOUNT_REGISTERED: (ctx) => ({
        inApp: {
            title: 'Welcome to ACTIV',
            message: 'Your account is created. Complete your application forms to begin the review process.',
            type: 'success'
        },
        email: {
            subject: 'Welcome to ACTIV — your account is ready',
            title: 'Your ACTIV account is ready',
            preheader: 'Complete your membership application to begin the review.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Your ACTIV account has been created successfully.</p>
                <p style="margin:0 0 12px 0;">The next step is to complete your membership application.
                It moves through three reviews — your Block, then District, then State administrator —
                and you will be told at each stage.</p>`,
            facts: [
                { label: 'Registered email', value: ctx.email },
                { label: 'Region', value: [ctx.block, ctx.district, ctx.state].filter(Boolean).join(', ') }
            ],
            actionButton: { label: 'Complete your application', url: appUrl('/member/personal-form') }
        },
        whatsapp: {
            template: TPL.welcome,
            params: [ctx.firstName || ctx.name || 'Member'],
            text: `Welcome to ACTIV, ${ctx.firstName || 'Member'}! Your account is ready. `
                + `Complete your membership application at ${appUrl('/member/personal-form')}\n\n`
                + `Reply HELP at any time for your regional admin's contact details.`
        }
    }),

    /* -------------------------------------------------- application lodged */
    APPLICATION_SUBMITTED: (ctx) => ({
        inApp: {
            title: 'Application submitted',
            message: `Your ACTIV membership application has been submitted and is now with the `
                + `${ctx.block || 'Block'} Block Admin for review.`,
            type: 'info'
        },
        email: {
            subject: 'Your ACTIV application has been received',
            title: 'Application received',
            preheader: 'It is now with your Block Admin for review.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">We have received your ACTIV membership application.
                It is now with your Block Administrator for the first of three reviews.</p>
                <p style="margin:0 0 12px 0;">You will be emailed each time it moves forward.
                No action is needed from you in the meantime.</p>`,
            facts: [
                { label: 'Reference', value: ctx.reference },
                { label: 'Region', value: [ctx.block, ctx.district, ctx.state].filter(Boolean).join(', ') },
                { label: 'Current stage', value: 'Block review' }
            ],
            actionButton: { label: 'Track your application', url: appUrl('/member/application-status') }
        },
        whatsapp: {
            /*
             * EVERY `TPL.status` PARAMETER IS A SENTENCE FRAGMENT, NOT A LABEL.
             *
             * The approved body is fixed and reads:
             *
             *   Hello {1}! 👋 Your ACTIV membership application is now {2}, {3}.
             *   Reply STATUS for details.
             *
             * so slot 2 has to complete "is now …" and slot 3 has to follow a
             * comma and be closed by the template's own full stop. A title-case
             * noun phrase in slot 2 — "Cleared Block review", "Not approved" —
             * produces "is now Cleared Block review", which is the sentence the
             * member actually receives and is not English. Read the rendered
             * body aloud before changing any of these; the template cannot be
             * edited for 24 hours after a change and needs Meta's approval
             * again, so the words here are the only half that moves.
             */
            template: TPL.status,
            params: [
                ctx.firstName || 'Member',
                'submitted',
                `with your ${ctx.block || 'Block'} Block Admin for review`
            ],
            text: `ACTIV: your membership application has been submitted and is with the `
                + `${ctx.block || 'Block'} Block Admin.\n\nReply STATUS any time for an update.`
        }
    }),

    /* ------------------------------------------ cleared a tier, moved onward */
    STAGE_CHANGED: (ctx) => ({
        inApp: {
            title: 'Application progressed',
            message: `Your application cleared the ${ctx.clearedTier} review and is now with the `
                + `${ctx.nextTier} Admin.`,
            type: 'info'
        },
        email: {
            subject: `Your ACTIV application is now with the ${ctx.nextTier} Admin`,
            title: 'Your application moved forward',
            preheader: `Cleared the ${ctx.clearedTier} review.`,
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Good news — your application has cleared the
                <strong>${ctx.clearedTier}</strong> review and has been passed to the
                <strong>${ctx.nextTier} Administrator</strong>.</p>
                <p style="margin:0 0 12px 0;">There is nothing you need to do. We will write again
                when the next review is complete.</p>`,
            facts: [
                { label: 'Reference', value: ctx.reference },
                { label: 'Current stage', value: `${ctx.nextTier} review` }
            ],
            actionButton: { label: 'Track your application', url: appUrl('/member/application-status') }
        },
        whatsapp: {
            template: TPL.status,
            /*
             * The TIER the file has reached goes in slot 2 and the step it has
             * completed goes in slot 3 — not the other way round. Reversed, the
             * member reads "is now Cleared Block review, now with the District
             * Admin": a fragment that does not follow "is now", and the word
             * "now" twice in one sentence.
             */
            params: [
                ctx.firstName || 'Member',
                `with your ${ctx.nextTier} Admin`,
                `it cleared the ${ctx.clearedTier} review and needs nothing from you`
            ],
            text: `ACTIV: your application cleared the ${ctx.clearedTier} review and is now with the `
                + `${ctx.nextTier} Admin.`
        }
    }),

    /* ------------------------------------------------ sent back / rejected */
    CORRECTION_REQUESTED: (ctx) => ({
        inApp: {
            title: 'Application not approved',
            message: ctx.reason
                ? `Your ACTIV membership application was not approved. Reason: ${ctx.reason}`
                : 'Your ACTIV membership application was not approved. '
                  + 'Please contact your local admin for details.',
            type: 'error'
        },
        email: {
            subject: 'Your ACTIV application needs attention',
            title: 'Your application was not approved',
            preheader: ctx.reason ? oneLine(ctx.reason, 90) : 'Contact your regional admin for details.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Your ACTIV membership application was reviewed at the
                <strong>${ctx.tierLabel || 'Block'}</strong> stage and was not approved.</p>
                ${ctx.reason ? `
                <p style="margin:0 0 6px 0;"><strong>Reason given:</strong></p>
                <p style="margin:0 0 12px 0; padding:12px 14px; background-color:#fef2f2;
                          border-left:3px solid #dc2626; color:#7f1d1d;">${ctx.reasonHtml || ''}</p>` : ''}
                <p style="margin:0 0 12px 0;">Replying to this email reaches the office that reviewed it,
                and they can tell you what to correct.</p>`,
            facts: [{ label: 'Reference', value: ctx.reference }],
            actionButton: { label: 'View your application', url: appUrl('/member/application-status') }
        },
        whatsapp: {
            template: TPL.status,
            /*
             * `clause`, not `oneLine`: an admin's reason almost always ends in
             * a full stop, and the template supplies one immediately after this
             * slot. "…upload a clear copy.. Reply STATUS for details" reads as
             * a rendering fault, which is the last thing to put in front of
             * somebody who has just been turned down.
             */
            params: [
                ctx.firstName || 'Member',
                'not approved',
                ctx.reason
                    ? `the reason given is: ${clause(ctx.reason, 170)}`
                    : 'please contact your regional admin for the details'
            ],
            text: `ACTIV: your membership application was not approved at the `
                + `${ctx.tierLabel || 'Block'} stage.`
                + (ctx.reason ? `\n\nReason: ${oneLine(ctx.reason, 300)}` : '')
                + `\n\nReply HELP for your regional admin's contact details.`
        }
    }),

    /* ------------------------------------------------------ fully approved */
    APPLICATION_APPROVED: (ctx) => ({
        inApp: {
            title: 'Application approved',
            message: 'Your ACTIV membership application has been fully approved. '
                + 'Complete your membership payment to activate your account.',
            type: 'success'
        },
        email: {
            subject: 'Your ACTIV application is approved — one step left',
            title: 'Your application is approved',
            preheader: 'Complete your membership payment to activate your account.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Congratulations — your ACTIV membership application has
                been approved at all three levels.</p>
                <p style="margin:0 0 12px 0;">One step remains: completing your membership payment.
                Your membership becomes active, and your certificates are issued, as soon as it is received.</p>`,
            facts: [{ label: 'Reference', value: ctx.reference }],
            actionButton: { label: 'Complete your payment', url: appUrl('/payment/membership-plans') }
        },
        whatsapp: {
            template: TPL.status,
            /*
             * The tier that signed it off is deliberately absent. It produced
             * "is now Cleared Tamil Nadu State review, fully approved, complete
             * your payment to activate" — three clauses, two of which say the
             * same thing. What the member needs from this message is that it is
             * approved and that there is one thing left to do.
             */
            params: [
                ctx.firstName || 'Member',
                'fully approved',
                'complete your membership payment to activate it'
            ],
            text: `ACTIV: your membership application has been APPROVED.\n\n`
                + `Complete your payment to activate: ${appUrl('/payment/membership-plans')}`
        }
    }),

    /* ------------------------------------------------------ payment needed */
    PAYMENT_REQUIRED: (ctx) => ({
        email: {
            subject: 'Complete your ACTIV membership payment',
            title: 'One step left — your membership payment',
            preheader: 'Your application is approved and awaiting payment.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Your ACTIV membership application is approved and waiting
                on the membership fee.</p>
                <p style="margin:0 0 12px 0;">Your membership activates immediately once payment is received.</p>`,
            facts: [
                { label: 'Reference', value: ctx.reference },
                { label: 'Amount', value: ctx.amountLabel }
            ],
            actionButton: { label: 'Pay now', url: appUrl('/payment/membership-plans') }
        },
        whatsapp: {
            template: TPL.payment,
            params: [ctx.firstName || 'Member', ctx.amountLabel || 'the required amount'],
            text: `ACTIV: your membership payment of ${ctx.amountLabel || 'the required amount'} is pending.\n\n`
                + `Pay here: ${appUrl('/payment/membership-plans')}`
        }
    }),

    /* --------------------------------------------------- payment succeeded */
    PAYMENT_SUCCESS: (ctx) => ({
        email: {
            subject: 'Payment received — thank you',
            title: 'We have received your payment',
            preheader: 'Your ACTIV membership is being activated.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Thank you — your membership payment has been received.</p>`,
            facts: [
                { label: 'Amount', value: ctx.amountLabel },
                { label: 'Reference', value: ctx.orderId }
            ],
            actionButton: { label: 'View your receipt', url: appUrl('/payment/member-dashboard') }
        },
        whatsapp: {
            template: TPL.status,
            params: [
                ctx.firstName || 'Member',
                'fully paid',
                `we have received your payment of ${ctx.amountLabel || 'the required amount'} and your membership is being activated`
            ],
            text: `ACTIV: payment received (${ctx.amountLabel || 'full amount'}). Thank you.`
        }
    }),

    /* ------------------------------------------------- membership is live */
    MEMBERSHIP_ACTIVATED: (ctx) => ({
        inApp: {
            title: 'Membership activated',
            message: 'Your payment was received and your ACTIV membership is now active.',
            type: 'success'
        },
        email: {
            subject: 'Your ACTIV membership is active',
            title: 'Welcome — your membership is active',
            preheader: 'Your certificates and the member directory are now available.',
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Your payment has been received and your ACTIV membership
                is now <strong>active</strong>.</p>
                <p style="margin:0 0 8px 0;">You now have access to:</p>
                <ul style="margin:0 0 12px 0; padding-left:20px;">
                  <li style="margin-bottom:5px;">The full member directory</li>
                  <li style="margin-bottom:5px;">Members-only events and conclaves</li>
                  <li style="margin-bottom:5px;">Your membership and tax exemption certificates</li>
                  <li style="margin-bottom:5px;">Your business catalogue and reach analytics</li>
                </ul>`,
            facts: [
                { label: 'Member ID', value: ctx.membershipNumber },
                { label: 'Membership', value: ctx.membershipType },
                { label: 'Amount paid', value: ctx.amountLabel }
            ],
            actionButton: { label: 'Open your dashboard', url: appUrl('/payment/member-dashboard') }
        },
        whatsapp: {
            template: TPL.status,
            params: [
                ctx.firstName || 'Member', 
                'fully completed', 
                'your membership and benefits are now completely active'
            ],
            text: `ACTIV: your membership is now ACTIVE`
                + (ctx.membershipNumber ? `\nMember ID: ${ctx.membershipNumber}` : '')
                + `\n\nReply EVENTS to see what is coming up.`
        }
    }),

    /* ---------------------------------------------------- event registered */
    EVENT_REGISTERED: (ctx) => ({
        inApp: {
            title: 'Event registration confirmed',
            message: `You are registered for ${ctx.eventTitle || 'the event'}.`,
            type: 'success'
        },
        email: {
            subject: `You are registered — ${ctx.eventTitle || 'ACTIV event'}`,
            title: 'Your seat is confirmed',
            preheader: `${ctx.eventTitle || 'ACTIV event'}${ctx.whenLabel ? ` · ${ctx.whenLabel}` : ''}`,
            bodyHtml: `
                <p style="margin:0 0 12px 0;">Your registration for
                <strong>${ctx.eventTitleHtml || 'this event'}</strong> is confirmed.</p>`,
            facts: [
                { label: 'When', value: ctx.whenLabel },
                { label: 'Where', value: ctx.venue }
            ],
            actionButton: { label: 'View event details', url: eventLink(ctx) }
        },
        whatsapp: {
            /*
             * ONE APPROVED EVENT TEMPLATE SERVES BOTH EVENT MESSAGES, and its
             * body is worded as a reminder: "Just a quick reminder about {2}
             * happening on {3}." A bare title in slot 2 therefore tells somebody
             * who has just booked a seat that they are being *reminded* of an
             * event they have not been told about yet.
             *
             * Naming the seat in slot 2 makes the same sentence true for a
             * confirmation — "a quick reminder about your confirmed seat at the
             * Conclave happening on 25 Aug 2026" — without a second template
             * going through Meta review.
             */
            template: TPL.event,
            params: [
                ctx.firstName || 'Member',
                `your confirmed seat at ${clause(ctx.eventTitle, 120) || 'the event'}`,
                ctx.whenLabel || 'the scheduled date'
            ],
            text: `ACTIV: you are registered for ${ctx.eventTitle || 'the event'}`
                + (ctx.whenLabel ? ` on ${ctx.whenLabel}` : '')
                + (ctx.venue ? ` at ${ctx.venue}` : '') + '.'
        }
    }),

    /* ------------------------------------------------------ event reminder */
    EVENT_REMINDER: (ctx) => ({
        inApp: {
            title: 'Event reminder',
            message: `${ctx.eventTitle || 'An event'} is coming up${ctx.whenLabel ? ` on ${ctx.whenLabel}` : ''}.`,
            type: 'info'
        },
        email: {
            subject: `Reminder — ${ctx.eventTitle || 'ACTIV event'}`,
            title: 'A reminder about your upcoming event',
            preheader: `${ctx.eventTitle || 'ACTIV event'}${ctx.whenLabel ? ` · ${ctx.whenLabel}` : ''}`,
            bodyHtml: `<p style="margin:0 0 12px 0;">This is a reminder about an event you are registered for.</p>`,
            facts: [
                { label: 'When', value: ctx.whenLabel },
                { label: 'Where', value: ctx.venue }
            ],
            actionButton: { label: 'View event details', url: eventLink(ctx) }
        },
        whatsapp: {
            template: TPL.event,
            params: [
                ctx.firstName || 'Member',
                clause(ctx.eventTitle, 120) || 'the event',
                ctx.whenLabel || 'the scheduled date'
            ],
            text: `ACTIV reminder: ${ctx.eventTitle || 'your event'}`
                + (ctx.whenLabel ? ` on ${ctx.whenLabel}` : '')
                + (ctx.venue ? ` at ${ctx.venue}` : '') + '.'
        }
    }),

    /*
     * ======================================================================
     * EVENT BOOKINGS — confirmed, cancelled, reminded
     * ======================================================================
     *
     * Every value below is built by `eventbooking.service.messageContext` from
     * the booking AND the live event at the moment of sending: the date and
     * time in IST as the event is scheduled, the venue, the seats, the
     * participants, what was paid and how. Nothing here is a fixed sentence
     * about a fixed event — the wording branches on how the booking was
     * settled (online through the gateway, recorded by the organiser, or free)
     * and on why the message is going out.
     *
     * WhatsApp reuses the approved event template (`TPL.event`, "a reminder
     * about {2} on {3}"), so slot 2 carries the booking in words and slot 3
     * the scheduled date and time. `text` is the fully written-out message
     * sent inside the session window and by `alsoSendText`.
     */
    EVENT_BOOKING_CONFIRMED: (ctx) => {
        const title = ctx.eventTitle || 'the event';
        const online = !!ctx.isOnline;

        return {
            inApp: {
                title: online ? 'Registered for the webinar' : 'Booking confirmed',
                message: `${ctx.seatsLabel} booked for ${title}${ctx.whenLabel ? ` on ${ctx.whenLabel}` : ''}. `
                    + `Booking ID ${ctx.bookingRef}.`,
                type: 'success'
            },
            /*
             * SAID ONCE. The subject says "confirmed", the hero names the event
             * and the format, the one sentence says what to do next, and every
             * fact lives in the Details card. No badge repeating the subject,
             * no poster (the email is a ticket, not a flyer).
             */
            email: {
                subject: online ? `Webinar registration confirmed: ${title}` : `Booking confirmed: ${title}`,
                title,
                preheader: [online ? "You're registered" : 'Your seat is confirmed', ctx.formatLabel]
                    .filter(Boolean).join(' · '),
                tone: 'success',
                highlight: {
                    label: 'Booking ID',
                    value: ctx.bookingRef,
                    note: online ? 'Keep this for any question about your registration.' : 'Show this at the registration desk.'
                },
                bodyHtml: online
                    ? `<p style="margin:0;">Thank you for registering for our webinar.${settledSentence(ctx)}</p>`
                        + (ctx.registerUrl
                            ? '<p style="margin:12px 0 0 0;"><strong>One last step:</strong> complete your registration'
                                + `${ctx.onlinePlatform ? ` on ${esc(ctx.onlinePlatform)}` : ''} with the button below.`
                                + ' Your personal joining link will then be emailed to you.</p>'
                            : '<p style="margin:12px 0 0 0;">The registration link will reach you soon.</p>')
                    : `<p style="margin:0;">Thank you for booking.${settledSentence(ctx)} We look forward to welcoming you.</p>`,
                facts: bookingFacts(ctx),
                actionButton: online && ctx.registerUrl
                    ? { label: `Register${ctx.onlinePlatform ? ` on ${ctx.onlinePlatform}` : ' now'}`, url: ctx.registerUrl }
                    : (ctx.viewUrl ? { label: 'View your booking', url: ctx.viewUrl } : undefined),
                secondaryButton: online
                    ? (ctx.registerUrl && ctx.viewUrl ? { label: 'View your booking', url: ctx.viewUrl } : undefined)
                    : (ctx.mapUrl ? { label: 'Get directions', url: ctx.mapUrl } : undefined),
                afterHtml: beforeYouComeHtml(ctx)
            },
            whatsapp: {
                ...richBookingWhatsApp('confirmed', [
                    ctx.firstName || 'Member',
                    `your confirmed booking for ${clause(title, 110)} (${whereLine(ctx)}, ID ${ctx.bookingRef})`,
                    ctx.whenLabel || 'the scheduled date'
                ], ctx),
                text: bookingText(ctx, {
                    heading: online ? '✅ *Webinar registration confirmed*' : '✅ *Booking confirmed*',
                    lead: online
                        ? `Thank you for registering for our webinar *${title}*${/[.?!]$/.test(title) ? '' : '.'}`
                        : `Your seat for *${title}* is confirmed.`,
                    closing: online ? 'See you online!' : 'We look forward to welcoming you!'
                })
            }
        };
    },

    EVENT_BOOKING_CANCELLED: (ctx) => {
        const title = ctx.eventTitle || 'the event';
        return {
            inApp: {
                title: 'Booking cancelled',
                message: `Your booking ${ctx.bookingRef} for ${title} has been cancelled.`,
                type: 'warning'
            },
            email: {
                subject: `Booking cancelled: ${title}`,
                title: 'Your booking has been cancelled',
                preheader: [title, ctx.whenLabel].filter(Boolean).join(' · '),
                tone: 'danger',
                highlight: { label: 'Cancelled booking', value: ctx.bookingRef },
                actionButton: ctx.eventUrl ? { label: 'View the event', url: ctx.eventUrl } : undefined,
                bodyHtml: `<p style="margin:0 0 12px 0;">The organiser has cancelled this booking and released
                    the ${esc(ctx.seatsLabel)} it held.</p>
                    ${ctx.reason ? `<p style="margin:0 0 12px 0;"><strong>Reason:</strong> ${esc(ctx.reason)}</p>` : ''}
                    <p style="margin:0;">Think this is a mistake, or have a question about a payment? Reply to this
                    email${ctx.contactLine ? ' or contact the organiser below' : ''}.</p>`,
                facts: [
                    { label: 'Date', value: ctx.dateLabel },
                    { label: 'Time', value: ctx.timeLabel },
                    { label: 'Format', value: ctx.formatLabel },
                    { label: 'Seats released', value: seatsLine(ctx) },
                    ...(ctx.settledVia === 'free' ? [] : [
                        { label: 'Amount', value: ctx.amountLabel },
                        { label: 'Payment', value: ctx.paymentLabel }
                    ]),
                    { label: 'Organiser', value: ctx.contactLine }
                ]
            },
            whatsapp: {
                ...bookingWhatsApp(TPL.bookingCancel, [
                    greetName(ctx),
                    ctx.bookingRef || 'your booking',
                    clause(title, 120) || 'the event',
                    orDash(ctx.whenLabel, 'Date to be confirmed'),
                    orDash(ctx.reason, 'No reason was given'),
                    orDash(ctx.contactLine, 'the ACTIV office')
                ], [
                    ctx.firstName || 'Member',
                    `the CANCELLATION of your booking ${ctx.bookingRef} for ${clause(title, 110)}`,
                    ctx.whenLabel || 'the scheduled date'
                ], ctx.posterUrl),
                text: '*Booking cancelled*\n\n'
                    + `Hello ${ctx.firstName || 'Member'},\n`
                    + `Your booking for *${title}* has been cancelled by the organiser.\n\n`
                    + waLines([
                        ['🗓', ctx.whenLabel],
                        ['🔖', `Booking ID: ${ctx.bookingRef}`],
                        ['🎟', ctx.seatsLabel ? `${ctx.seatsLabel} released` : ''],
                        ['📝', ctx.reason ? `Reason: ${oneLine(ctx.reason)}` : '']
                    ])
                    + (ctx.contactLine ? `\n\nQuestions? ${ctx.contactLine}` : '')
                    + `\n\n— ${ORG_SIGNATURE}`
            }
        };
    },

    EVENT_BOOKING_WAITLISTED: (ctx) => {
        const title = ctx.eventTitle || 'the event';
        return {
            inApp: {
                title: 'You are on the waitlist',
                message: `${title} is full. You are on the waitlist (${ctx.bookingRef}); nothing has been charged.`,
                type: 'info'
            },
            email: {
                subject: `Waitlisted: ${title}`,
                title: "You're on the waitlist",
                preheader: [title, ctx.whenLabel].filter(Boolean).join(' · '),
                tone: 'warning',
                highlight: { label: 'Waitlist reference', value: ctx.bookingRef },
                actionButton: ctx.eventUrl ? { label: 'View the event', url: ctx.eventUrl } : undefined,
                bodyHtml: `<p style="margin:0;">This event is fully booked, so your request is on the waitlist.
                    <strong>No seat is held and nothing has been charged</strong> — the organiser will contact
                    you if a place opens up.</p>`,
                facts: bookingFacts(ctx, { payment: false, seatsLabel: 'Seats requested' })
            },
            whatsapp: {
                template: TPL.event,
                params: [
                    ctx.firstName || 'Member',
                    `your WAITLIST request ${ctx.bookingRef} for ${clause(title, 110)} (event full, nothing charged)`,
                    ctx.whenLabel || 'the scheduled date'
                ],
                text: "*You're on the waitlist*\n\n"
                    + `Hello ${ctx.firstName || 'Member'},\n`
                    + `*${title}* is fully booked, so your request is on the waitlist. `
                    + 'No seat is held and nothing has been charged.\n\n'
                    + waLines([
                        ['🗓', ctx.whenLabel],
                        ['🎟', ctx.seatsLabel ? `${ctx.seatsLabel} requested` : ''],
                        ['🔖', `Reference: ${ctx.bookingRef}`]
                    ])
                    + (ctx.contactLine ? `\n\nQuestions? ${ctx.contactLine}` : '')
                    + `\n\n— ${ORG_SIGNATURE}`
            }
        };
    },

    EVENT_BOOKING_REMINDER: (ctx) => {
        const title = ctx.eventTitle || 'your event';
        const online = !!ctx.isOnline;
        const when = ctx.startsInLabel || 'soon';
        return {
            inApp: {
                title: online ? 'Webinar reminder' : 'Event reminder',
                message: `${title} starts ${when}${ctx.whenLabel ? ` — ${ctx.whenLabel}` : ''}.`,
                type: 'info'
            },
            email: {
                subject: `Reminder: ${title} starts ${when}`,
                title,
                preheader: `${online ? 'Your webinar' : 'Your event'} starts ${when}`,
                tone: 'info',
                highlight: {
                    label: 'Booking ID',
                    value: ctx.bookingRef,
                    note: online ? 'Keep this for any question about your registration.' : 'Show this at the registration desk.'
                },
                bodyHtml: online
                    ? `<p style="margin:0;">${ctx.registerUrl
                        ? 'Your place is reserved. Not registered on the platform yet? Do it now with the button below —'
                            + ' your personal joining link is then emailed to you.'
                        : 'Your place is reserved. The registration link will reach you shortly.'}</p>`
                    : '<p style="margin:0;">Your seat is reserved — we look forward to seeing you.</p>',
                facts: bookingFacts(ctx, { payment: false }),
                actionButton: online && ctx.registerUrl
                    ? { label: `Register${ctx.onlinePlatform ? ` on ${ctx.onlinePlatform}` : ' now'}`, url: ctx.registerUrl }
                    : (ctx.viewUrl ? { label: 'View your booking', url: ctx.viewUrl } : undefined),
                secondaryButton: online
                    ? undefined
                    : (ctx.mapUrl ? { label: 'Get directions', url: ctx.mapUrl } : undefined),
                afterHtml: beforeYouComeHtml(ctx)
            },
            whatsapp: {
                ...richBookingWhatsApp('reminder', [
                    ctx.firstName || 'Member',
                    `${clause(title, 110)} (${whereLine(ctx)}, booking ${ctx.bookingRef})`,
                    `${ctx.whenLabel || 'the scheduled date'} - it starts ${when}`
                ], ctx),
                text: bookingText(ctx, {
                    heading: `⏰ *${online ? 'Webinar' : 'Event'} reminder*`,
                    lead: `*${title}* starts *${when}*!`,
                    closing: online ? 'See you online!' : 'See you there!'
                })
            }
        };
    },

    /*
     * ======================================================================
     * PARTICIPANTS — a seat booked FOR somebody (a company head booking for
     * the team). Sent to each participant with an email or mobile of their
     * own, besides the booker. It names who booked, shows THEIR seat and the
     * event, and never the booker's payment.
     * ======================================================================
     */
    EVENT_PARTICIPANT_CONFIRMED: (raw) => {
        const ctx = asParticipant(raw);
        const title = ctx.eventTitle || 'the event';
        const online = !!ctx.isOnline;
        const booker = ctx.bookerName || 'Your organisation';
        return {
            email: {
                subject: `${booker} booked a seat for you: ${title}`,
                title,
                preheader: [`${booker} reserved a seat for you`, ctx.formatLabel].filter(Boolean).join(' · '),
                tone: 'success',
                highlight: {
                    label: 'Booking ID',
                    value: ctx.bookingRef,
                    note: online ? 'Keep this for any question about your seat.' : 'Show this at the registration desk.'
                },
                bodyHtml: `<p style="margin:0;"><strong>${esc(booker)}</strong> has reserved a seat for you at this `
                    + `${online ? 'webinar' : 'event'}. Everything you need is below.</p>`
                    + (online && ctx.registerUrl
                        ? (onlineLinkKind(ctx.registerUrl) === 'register'
                            ? '<p style="margin:12px 0 0 0;"><strong>One step for you:</strong> register with the button below'
                                + ' — your personal joining link appears as soon as you submit the form.</p>'
                            : '<p style="margin:12px 0 0 0;">Join with the button below, 5–10 minutes before the start.</p>')
                        : ''),
                facts: [
                    ...bookingFacts(ctx, { payment: false, seatsLabel: 'Your seat' }),
                    { label: 'Booked by', value: booker }
                ],
                actionButton: online && ctx.registerUrl
                    ? { label: onlineLinkKind(ctx.registerUrl) === 'register'
                        ? `Register${ctx.onlinePlatform ? ` on ${ctx.onlinePlatform}` : ' now'}` : 'Join the webinar',
                    url: ctx.registerUrl }
                    : (ctx.eventUrl ? { label: 'View the event', url: ctx.eventUrl } : undefined),
                secondaryButton: !online && ctx.mapUrl ? { label: 'Get directions', url: ctx.mapUrl } : undefined,
                afterHtml: beforeYouComeHtml(ctx)
            },
            whatsapp: {
                ...richBookingWhatsApp('participant', [
                    ctx.firstName || 'Member',
                    `your seat at ${clause(title, 100)}, booked for you by ${clause(booker, 40)} (ID ${ctx.bookingRef})`,
                    ctx.whenLabel || 'the scheduled date'
                ], ctx),
                text: bookingText(ctx, {
                    heading: '🎟 *A seat has been booked for you*',
                    lead: `*${booker}* has reserved a seat for you at *${title}*${/[.?!]$/.test(title) ? '' : '.'}`,
                    closing: online ? 'See you online!' : 'We look forward to welcoming you!'
                })
            }
        };
    },

    // The reminder is the booker's, worded for one seat and greeting the participant.
    EVENT_PARTICIPANT_REMINDER: (raw) => {
        const out = TEMPLATES.EVENT_BOOKING_REMINDER(asParticipant(raw));
        delete out.inApp;
        return out;
    },

    // The cancellation too, without the booker's amount and payment rows.
    EVENT_PARTICIPANT_CANCELLED: (raw) => {
        const ctx = asParticipant(raw);
        const out = TEMPLATES.EVENT_BOOKING_CANCELLED({ ...ctx, settledVia: 'free' });
        delete out.inApp;
        out.email.bodyHtml = `<p style="margin:0 0 12px 0;">The booking <strong>${esc(ctx.bookingRef)}</strong> that `
            + `${esc(ctx.bookerName || 'your organisation')} made for you has been cancelled by the organiser, `
            + 'so your seat is released.</p>'
            + (ctx.reason ? `<p style="margin:0 0 12px 0;"><strong>Reason:</strong> ${esc(ctx.reason)}</p>` : '')
            + '<p style="margin:0;">Questions? Reply to this email or contact the organiser below.</p>';
        return out;
    }
};

/**
 * The templates to create and get approved on the BotBee dashboard.
 *
 * EACH ENTRY CARRIES TWO BODIES, AND WHICH ONE IS CORRECT DEPENDS ON THE
 * PROVIDER, NOT ON TASTE.
 *
 *   `body`               variable-free. What to type while BotBee is sending.
 *   `bodyWithVariables`  the same message with its variables. What to change it
 *                        to once META_ACCESS_TOKEN is set.
 *
 * WHY THE VARIABLE-FREE ONE IS CURRENT. BotBee's `/api/v1/whatsapp/send/template`
 * accepts variable values, answers `status:"1"`, and delivers a literal `-` in
 * every slot. That was measured to exhaustion on 7 Sep 2026, and it is worth
 * listing so nobody spends another day on it:
 *
 *   - ~40 send-payload shapes: `template_data`, `params`, `body_params`,
 *     `custom_fields`, `variable_map` flat and nested, Meta-style `components`,
 *     bare `"1"`, `"#1#"`, `data`, `template_variable`. One message carried a
 *     different marker under every key at once; it rendered `-`.
 *   - Subscriber custom fields, written every way `/subscriber/update` accepts.
 *     It answers success and `/subscriber/get` reads back `custom_fields: null`.
 *   - `first_name`, a SYSTEM field, set and CONFIRMED STORED on the subscriber,
 *     then sent with no values in the payload at all. Still `-`.
 *   - Templates bound to `#1#` and to `#first_name#`, both.
 *   - The dashboard's Sync Templates action, and registering the variables under
 *     Message Templates -> Variables. Neither changed the delivered message.
 *
 * So a variable in a body sent through BotBee is not a personalisation. It is a
 * guaranteed dash in a real member's chat, on the first message ACTIV ever sends
 * them, behind an HTTP 200 and a green row on the oversight screen.
 *
 * WHERE THE MEMBER'S NAME COMES FROM MEANWHILE. The `text` on each event above,
 * composed here in JavaScript with the values already interpolated, which BotBee
 * never parses and so cannot break. It is legal only inside the 24-hour window a
 * member's own message opens — which is exactly why every variable-free body
 * below asks for a word back. The reply opens the window, the keyword bot
 * answers with the member's real details, and the gap narrows to one tap.
 *
 * SWITCHING BACK COSTS NOTHING IN CODE. `botbee.service` reads each template's
 * `variable_map` off the account at send time and sends exactly the values that
 * template declares — none for a variable-free body, three for a three-slot one.
 * So restoring `bodyWithVariables` on the dashboard is the WHOLE change: no
 * deploy, no restart, no edit here. `metaCloud.service` fills them properly.
 *
 * CATEGORY IS UTILITY, NOT MARKETING. These are transactional. Utility is
 * cheaper, is not suppressed by marketing preferences on the handset, and is the
 * category Meta expects. The four on the account were created as Marketing.
 *
 * `scripts/test-notifications.js --templates` prints both versions.
 */
const WHATSAPP_TEMPLATES = [
    {
        /* A PARTICIPANT, booked for by somebody else. Names the booker; shows their seat, never the fee. */
        name: 'activ_participant_seat_v1',
        envKey: 'BOTBEE_TPL_BOOKING_PARTICIPANT',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '🎟 *{{2}}* has reserved a seat for you at *{{3}}*\n\n'
            + '🗓 *Date:* {{4}}\n'
            + '⏰ *Time:* {{5}}\n'
            + '📍 *Where:* {{6}}\n'
            + '🔗 *{{7}}:* {{8}}\n'
            + '🔖 *Booking ID:* {{9}}\n\n'
            + '📌 *Please note*\n'
            + '• {{10}}\n'
            + '• {{11}}\n\n'
            + '📞 *Need help? Contact the organiser*\n'
            + '👤 *Name:* {{12}}\n'
            + '📱 *Phone:* {{13}}\n'
            + '📧 *Email:* {{14}}\n\n'
            + 'We look forward to seeing you there!',
        params: ['participant name', 'booked by', 'event', 'date', 'time', 'venue, or online + platform',
            'link label', 'link', 'booking ID', 'note 1', 'note 2', 'organiser name', 'organiser phone', 'organiser email'],
        samples: ['Priya', 'Tharun', 'SCST Economic Liberty Conference', 'Saturday, 10 October 2026',
            '9:00 AM - 5:00 PM IST', 'DNC Vijay Mahal, Dharmapuri', 'Directions', 'https://maps.app.goo.gl/abc123',
            'ACTIVB-MUEE9IBU-445B', 'Please arrive 15 to 30 minutes before the start time for registration',
            'Carry a valid photo ID for each participant', 'Rajesh', '+91 82201 12188', 'events@activ.org.in']
    },
    /*
     * THE DETAILED BOOKING TEMPLATES — Meta Cloud API ({{n}} placeholders),
     * each with the event POSTER as an IMAGE header and "ACTIV" as the footer.
     *
     * Sent only once their names are set (BOTBEE_TPL_BOOKING, _CANCEL,
     * _REMINDER). Until then the booking goes out through the generic approved
     * event template. Create them in BotBee -> WhatsApp -> Message Templates
     * (Header: Image, with any sample picture; Category: Utility; Language:
     * English), or with `scripts/whatsapp-booking-templates.js --submit` once
     * META_WABA_ID holds the real WhatsApp Business Account id. Every variable
     * has text on both sides, which review requires; values never contain a
     * newline, which Meta refuses.
     */
    {
        /* ONLINE event, confirmed. The link section follows the link kind (register / join / none). */
        name: 'activ_webinar_registration_v3',
        envKey: 'BOTBEE_TPL_BOOKING_WEBINAR',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '✅ Thank you for registering for our webinar *{{2}}*\n\n'
            + '🗓 *Date:* {{3}}\n'
            + '⏰ *Time:* {{4}}\n'
            + '💻 *Platform:* {{5}}\n'
            + '🔖 *Booking ID:* {{6}}\n\n'
            + '👉 *{{7}}*\n'
            + '{{8}}\n\n'
            + '💡 {{9}}.\n\n'
            + '📞 *Need help? Contact the organiser*\n'
            + '👤 *Name:* {{10}}\n'
            + '📱 *Phone:* {{11}}\n'
            + '📧 *Email:* {{12}}\n\n'
            + 'We look forward to seeing you online!',
        params: ['full name', 'event', 'date', 'time', 'platform', 'booking ID', 'link heading', 'link',
            'what to do with the link', 'organiser name', 'organiser phone', 'organiser email'],
        samples: ['Tharun', 'How to get business opportunities at NLC', 'Sunday, 27 September 2026',
            '3:00 PM - 6:00 PM IST', 'Zoom', 'ACTIVB-MUHCP7NA-710D', 'Final step: complete your Zoom registration',
            'https://zoom.us/meeting/register/abc123',
            'As soon as you submit that form, your personal joining link appears on the screen. Save it, and join 5-10 minutes before the start',
            'Rajesh', '+91 82201 12188', 'online@activ.org.in']
    },
    {
        /* IN-PERSON event, confirmed. Every note and contact detail on its own line. */
        name: 'activ_event_booking_v3',
        envKey: 'BOTBEE_TPL_BOOKING',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '✅ Your seat is confirmed for *{{2}}*\n\n'
            + '🗓 *Date:* {{3}}\n'
            + '⏰ *Time:* {{4}}\n'
            + '📍 *Venue:* {{5}}\n'
            + '🗺 *Directions:* {{6}}\n'
            + '🎟 *Seats:* {{7}}\n'
            + '💳 *Fee:* {{8}}\n'
            + '🔖 *Booking ID:* {{9}}\n\n'
            + '📌 *Please note*\n'
            + '• {{10}}\n'
            + '• {{11}}\n\n'
            + '📞 *Need help? Contact the organiser*\n'
            + '👤 *Name:* {{12}}\n'
            + '📱 *Phone:* {{13}}\n'
            + '📧 *Email:* {{14}}\n\n'
            + 'We look forward to welcoming you!',
        params: ['full name', 'event', 'date', 'time', 'venue', 'map link', 'seats', 'fee', 'booking ID',
            'note 1', 'note 2', 'organiser name', 'organiser phone', 'organiser email'],
        samples: ['Tharun', 'Entrepreneurs Awareness Programme', 'Friday, 23 October 2026', '9:00 AM - 5:00 PM IST',
            'Annamalai University, Chidambaram', 'https://maps.app.goo.gl/abc123', '1 seat - Tharun', 'Free',
            'ACTIVB-MUHAF0VR-2EA6', 'Please arrive 15 to 30 minutes before the start time for registration',
            'Carry a valid photo ID for each participant', 'Rajesh', '+91 82201 12188', 'events@activ.org.in']
    },
    {
        /* Either format, a day or so before. */
        name: 'activ_booking_reminder_v3',
        envKey: 'BOTBEE_TPL_BOOKING_REMINDER',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '⏰ Friendly reminder: *{{2}}* starts *{{3}}*\n\n'
            + '🗓 *Date:* {{4}}\n'
            + '⏰ *Time:* {{5}}\n'
            + '📍 *Where:* {{6}}\n'
            + '🔗 *{{7}}:* {{8}}\n'
            + '🔖 *Booking ID:* {{9}}\n\n'
            + '📌 *Please note*\n'
            + '• {{10}}\n'
            + '• {{11}}\n\n'
            + '📞 *Need help? Contact the organiser*\n'
            + '👤 *Name:* {{12}}\n'
            + '📱 *Phone:* {{13}}\n'
            + '📧 *Email:* {{14}}\n\n'
            + 'See you there!',
        params: ['full name', 'event', 'starts in', 'date', 'time', 'venue, or online + platform', 'link label',
            'link', 'booking ID', 'note 1', 'note 2', 'organiser name', 'organiser phone', 'organiser email'],
        samples: ['Tharun', 'SCST Economic Liberty Conference', 'tomorrow', 'Saturday, 10 October 2026',
            '9:00 AM - 5:30 PM IST', 'DNC Vijay Mahal, Dharmapuri', 'Directions', 'https://maps.app.goo.gl/abc123',
            'ACTIVB-MUEE9IBU-445B', 'Please arrive 15 to 30 minutes before the start time for registration',
            'Carry a valid photo ID for each participant', 'Rajesh', '+91 82201 12188', 'events@activ.org.in']
    },
    {
        /* ONLINE event, confirmed: register on the platform, link arrives by email. */
        name: 'activ_webinar_registration_v2',
        envKey: 'BOTBEE_TPL_BOOKING_WEBINAR',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '✅ Thank you for registering for our webinar *{{2}}*.\n\n'
            + '🗓 *Date:* {{3}}\n'
            + '⏰ *Time:* {{4}}\n'
            + '💻 *Platform:* {{5}}\n'
            + '🔖 *Booking ID:* {{6}}\n\n'
            + '👉 *One last step - register here:*\n{{7}}\n\n'
            + '📧 Once you register, your personal joining link will be emailed to {{8}}.\n\n'
            + '⏱ Please join 5 minutes before the start.\n'
            + '📞 Need help? Contact {{9}}.\n\n'
            + 'We look forward to seeing you online!',
        params: ['full name', 'event', 'date', 'time', 'platform', 'booking ID', 'registration link',
            'email', 'organiser contact'],
        samples: ['Tharun', 'How to get business opportunities at NLC', 'Sunday, 27 September 2026',
            '3:00 PM - 6:00 PM IST', 'Zoom', 'ACTIVB-MUHCP7NA-710D', 'https://zoom.us/meeting/register/abc123',
            'tharun@example.com', 'Rajesh - +91 82201 12188']
    },
    {
        /* IN-PERSON event, confirmed. */
        name: 'activ_event_booking_v2',
        envKey: 'BOTBEE_TPL_BOOKING',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '✅ Your seat is confirmed for *{{2}}*.\n\n'
            + '🗓 *Date:* {{3}}\n'
            + '⏰ *Time:* {{4}}\n'
            + '📍 *Venue:* {{5}}\n'
            + '🗺 *Directions:* {{6}}\n'
            + '🎟 *Seats & fee:* {{7}}\n'
            + '🔖 *Booking ID:* {{8}}\n\n'
            + '📌 *Please note:* {{9}}\n\n'
            + '📞 Need help? Contact {{10}}.\n\n'
            + 'We look forward to welcoming you!',
        params: ['full name', 'event', 'date', 'time', 'venue', 'map link', 'seats & fee', 'booking ID',
            'note for attendees', 'organiser contact'],
        samples: ['Tharun', 'Entrepreneurs Awareness Programme', 'Friday, 23 October 2026', '9:00 AM - 5:00 PM IST',
            'Annamalai University, Chidambaram', 'https://maps.app.goo.gl/abc123', '1 seat - Tharun | Free',
            'ACTIVB-MUHAF0VR-2EA6', 'Arrive 15-30 minutes early and carry a photo ID', 'Rajesh - +91 82201 12188']
    },
    {
        /* Either format, a day or so before. */
        name: 'activ_booking_reminder_v2',
        envKey: 'BOTBEE_TPL_BOOKING_REMINDER',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '⏰ Friendly reminder: *{{2}}* starts *{{3}}*.\n\n'
            + '🗓 *Date:* {{4}}\n'
            + '⏰ *Time:* {{5}}\n'
            + '📍 *Where:* {{6}}\n'
            + '🔗 *Link:* {{7}}\n'
            + '🔖 *Booking ID:* {{8}}\n\n'
            + '📌 *Please note:* {{9}}\n\n'
            + '📞 Need help? Contact {{10}}.\n\n'
            + 'See you there!',
        params: ['full name', 'event', 'starts in', 'date', 'time', 'venue, or online + platform',
            'registration link / map', 'booking ID', 'note for attendees', 'organiser contact'],
        samples: ['Tharun', 'SCST Economic Liberty Conference', 'tomorrow', 'Saturday, 10 October 2026',
            '9:00 AM - 5:30 PM IST', 'DNC Vijay Mahal, Dharmapuri', 'https://maps.app.goo.gl/abc123',
            'ACTIVB-MUEE9IBU-445B', 'Arrive 15-30 minutes early and carry a photo ID', 'Rajesh - +91 82201 12188']
    },
    {
        name: 'activ_booking_cancelled_v2',
        envKey: 'BOTBEE_TPL_BOOKING_CANCEL',
        category: 'Utility',
        meta: true,
        header: 'IMAGE',
        footer: 'Adidravidar Confederation of Trade & Industrial Vision-ACTIV',
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Dear *{{1}}*, Jaibhim! 🙏\n\n'
            + '❌ Your booking *{{2}}* for *{{3}}* on {{4}} has been cancelled by the organiser.\n\n'
            + '📝 *Reason:* {{5}}\n\n'
            + 'Your seats have been released. For any questions, please contact {{6}}.\n\n'
            + 'We hope to see you at a future ACTIV event.',
        params: ['full name', 'booking ID', 'event', 'date & time', 'reason', 'organiser contact'],
        samples: ['Tharun', 'ACTIVB-MUEE9IBU-445B', 'SCST Economic Liberty Conference',
            'Saturday, 10 October 2026, 9:00 AM IST', 'Duplicate booking', 'Rajesh, +91 82201 12188']
    },
    {
        name: TPL.welcome,
        category: 'Utility',
        body: 'Welcome to ACTIV! Your account is ready. '
            + 'Complete your membership application to begin the review. '
            + 'Reply HELP for support.',
        bodyWithVariables: 'Welcome to ACTIV, #first_name#! Your account is ready. '
            + 'Complete your membership application to begin the review. Reply HELP for support.',
        params: ['#first_name# member first name'],
        samples: ['Rajeshwari']
    },
    {
        name: TPL.status,
        category: 'Utility',
        /*
         * IT DOES NOT NAME THE STATUS, AND THAT IS WHAT THE REPLY IS FOR.
         *
         * "Approved" and "Not approved" cannot both be written into a body with
         * no variable in it, so it says only that something changed and asks for
         * a word back. That word is not a courtesy: an inbound message OPENS the
         * 24-hour window, and `botbeeWebhook.service` answers STATUS with the
         * member's real stage, their reference and what happens next, as free
         * text this codebase composes itself.
         *
         * So the member does learn the actual status, one tap later, in a
         * message that is fully personalised.
         */
        body: 'Your ACTIV membership application has been updated. '
            + 'Reply STATUS to see your current stage and what happens next.',
        /*
         * A COMMA between #status# and #next_step#, not a full stop: the third
         * value arrives as a sentence FRAGMENT ("complete your payment to
         * activate your membership"), so a full stop would start a new sentence
         * in lower case. It also keeps real text between the two variables,
         * which is what Meta's review requires.
         */
        bodyWithVariables: 'Hello #first_name#, your ACTIV membership application is now '
            + '#status#, #next_step#. Reply STATUS for details.',
        params: [
            '#first_name# member first name',
            '#status# new status',
            '#next_step# what happens next'
        ],
        samples: ['Rajeshwari', 'Approved', 'complete your payment to activate your membership']
    },
    {
        name: TPL.payment,
        category: 'Utility',
        // The AMOUNT is absent rather than approximated. A figure in a payment
        // message is a promise, and the plans are edited by the Super Admin --
        // a stale number here is one a member could actually pay.
        body: 'Your ACTIV membership payment is pending. '
            + 'Complete it to activate your membership. '
            + 'Reply STATUS for the amount and the payment link.',
        // "Rs 10,000", never the rupee sign. A non-ASCII character in a body or
        // a sample is one of the commonest reasons Meta refuses a template.
        bodyWithVariables: 'Hello #first_name#, your ACTIV membership payment of #amount# '
            + 'is pending. Complete it to activate your membership.',
        params: ['#first_name# member first name', '#amount# amount'],
        samples: ['Rajeshwari', 'Rs 10,000']
    },
    {
        name: TPL.event,
        category: 'Utility',
        body: 'There is an upcoming ACTIV event in your region. '
            + 'Reply EVENTS for the programme, dates and venue.',
        bodyWithVariables: 'Hello #first_name#, a reminder about #event# on #date#. '
            + 'Reply EVENTS for the full programme.',
        params: ['#first_name# member first name', '#event# event title', '#date# date'],
        samples: ['Rajeshwari', 'Annual Industrial Expo', '15 August 2026']
    }
];

/**
 * The template used when the one an event asks for is not on the account.
 *
 * WHY A FALLBACK EXISTS AT ALL. Every message this platform sends unprompted has
 * to be a template that Meta has approved, and approval is a process that
 * happens outside this codebase, takes hours to days, and fails for reasons —
 * punctuation, category, a sample value — that have nothing to do with whether
 * the member should be told their application was approved. Without a fallback,
 * a template still in review means the member is told NOTHING on WhatsApp, and
 * the only trace is a failed row on a screen nobody is watching.
 *
 * `activ_membership_status` is the one to fall back to because its three
 * variables are, in order, exactly the shape every other message reduces to:
 * who, what happened, what next. A payment reminder rendered through it reads
 * "Hello Rajeshwari, your ACTIV membership application is now Payment pending.
 * Complete Rs 10,000 to activate your membership." — less precisely worded than
 * its own template, and infinitely better than silence.
 *
 * `BOTBEE_FALLBACK_TEMPLATE` overrides it; empty disables the fallback entirely
 * for a deployment that would rather send nothing than send something generic.
 */
const FALLBACK_TEMPLATE = {
    name: TPL.status,
    /** Squeeze any event's parameters into who / what / next. */
    adapt: (params = []) => {
        const list = params.map((p) => String(p === null || p === undefined ? '' : p));
        const [who = 'Member', second = '', third = ''] = list;
        return [who, second || 'updated', third || 'Open the ACTIV app for details'];
    }
};

/** Render one event. Returns `null` for a name with no template. */
const render = (eventName, ctx = {}) => {
    const builder = TEMPLATES[eventName];
    if (typeof builder !== 'function') return null;
    return builder(ctx);
};

module.exports = { TEMPLATES, WHATSAPP_TEMPLATES, FALLBACK_TEMPLATE, render, appUrl, oneLine, clause };
