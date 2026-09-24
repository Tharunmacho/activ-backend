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

/** The practical notes before an in-person event, as a tinted box. */
const beforeYouComeHtml = (ctx = {}) => {
    const items = ctx.isOnline
        ? [
            'The joining link will reach you by email before the event starts.',
            'Join a few minutes early so you do not miss the opening.',
            'Keep your booking reference handy in case the organiser asks for it.'
        ]
        : [
            'Please arrive 15 to 30 minutes early for registration.',
            `Carry this email or your booking reference${ctx.bookingRef ? ` (${ctx.bookingRef})` : ''}.`,
            'Bring a photo ID for each participant.',
            'Fees are non-refundable, but you may change the names of the participants.'
        ];
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; margin:6px 0 4px 0;">
        <tr><td style="padding:14px 18px;">
          <div style="font-size:13px; font-weight:700; letter-spacing:1px; text-transform:uppercase; color:#1d4ed8;
                      padding-bottom:6px;">Before you come</div>
          ${items.map((i) => `<div style="font-size:14px; line-height:1.6; color:#1e3a8a;">&#10003;&nbsp; ${esc(i)}</div>`).join('')}
        </td></tr>
      </table>`;
};

/**
 * A booking message's WhatsApp template: the DETAILED one when it has been
 * approved and named in the environment, the generic event template otherwise.
 *
 * `fallback` rides along so that a detailed template which Meta refuses (still
 * in review, renamed, parameter count changed) is retried once through the
 * generic one by `notification.service` — the booker hears something either way.
 */
const bookingWhatsApp = (dedicatedName, dedicatedParams, eventParams) => (dedicatedName
    ? { template: dedicatedName, params: dedicatedParams, fallback: { template: TPL.event, params: eventParams } }
    : { template: TPL.event, params: eventParams });

/** A parameter value that is never empty — Meta refuses an empty one. */
const orDash = (value, dash = 'Not specified') => oneLine(value, 300) || dash;

/** "Who is coming", as a short list in a booking email. Empty when nobody is named. */
const participantsHtml = (names = []) => {
    const list = (Array.isArray(names) ? names : []).filter(Boolean);
    if (!list.length) return '';
    return `<p style="margin:0 0 6px 0;"><strong>Participants</strong></p>
        <ol style="margin:0 0 12px 0; padding-left:20px;">
          ${list.map((n) => `<li style="margin-bottom:4px;">${esc(n)}</li>`).join('')}
        </ol>`;
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
                { label: 'Event', value: ctx.eventTitle },
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
                { label: 'Event', value: ctx.eventTitle },
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
        const settled = ctx.settledVia === 'online'
            ? `We have received your payment of <strong>${esc(ctx.amountLabel)}</strong> online`
                + ' and your booking is confirmed.'
            : ctx.settledVia === 'offline'
                ? `The organiser has received your payment of <strong>${esc(ctx.amountLabel)}</strong>`
                    + `${ctx.paymentModeLabel ? ` (${esc(ctx.paymentModeLabel)})` : ''} and confirmed your booking.`
                : 'Your booking is confirmed. No payment is required for this event.';

        return {
            inApp: {
                title: 'Booking confirmed',
                message: `${ctx.seatsLabel} booked for ${title}${ctx.whenLabel ? ` on ${ctx.whenLabel}` : ''}. `
                    + `Reference ${ctx.bookingRef}.`,
                type: 'success'
            },
            email: {
                subject: `Booking confirmed — ${title} (${ctx.bookingRef})`,
                title: 'Your booking is confirmed',
                preheader: `${title}${ctx.whenLabel ? ` · ${ctx.whenLabel}` : ''} · ${ctx.seatsLabel}`,
                tone: 'success',
                badge: 'Booking confirmed',
                highlight: {
                    label: 'Your booking reference',
                    value: ctx.bookingRef,
                    note: ctx.isOnline ? 'Keep this — it is how we find your booking.'
                        : 'Show this at the registration desk.'
                },
                bodyHtml: `
                    <p style="margin:0 0 12px 0;">Thank you for booking
                    <strong>${ctx.eventTitleHtml || 'this event'}</strong>. ${settled}</p>
                    ${ctx.whenLabel ? `<p style="margin:0 0 12px 0;">We look forward to seeing you on
                    <strong>${esc(ctx.whenLabel)}</strong>${ctx.venueLabel && !ctx.isOnline
                        ? ` at <strong>${esc(ctx.venueLabel)}</strong>` : ''}.</p>` : ''}
                    ${participantsHtml(ctx.participantNames)}
                    ${beforeYouComeHtml(ctx)}`,
                facts: [
                    { label: 'Event', value: ctx.eventTitle },
                    { label: 'Date', value: ctx.dateLabel },
                    { label: 'Time', value: ctx.timeLabel },
                    { label: ctx.isOnline ? 'Attend' : 'Venue', value: ctx.venueLabel },
                    { label: 'Seats', value: String(ctx.seats || '') },
                    { label: 'Amount', value: ctx.settledVia === 'free' ? 'Free' : ctx.amountLabel },
                    { label: 'Payment', value: ctx.paymentLabel },
                    { label: 'Payment ID', value: ctx.paymentId },
                    { label: 'Booked by', value: ctx.bookedByLine },
                    { label: 'Booked on', value: ctx.bookedOnLabel },
                    { label: 'Organiser contact', value: ctx.contactLine }
                ],
                actionButton: ctx.viewUrl ? { label: 'View your booking', url: ctx.viewUrl } : undefined,
                secondaryButton: ctx.mapUrl ? { label: 'Get directions', url: ctx.mapUrl } : undefined
            },
            whatsapp: {
                ...bookingWhatsApp(TPL.booking, [
                    ctx.firstName || 'Member',
                    clause(title, 120) || 'the event',
                    orDash(ctx.whenLabel, 'Date to be confirmed'),
                    orDash(ctx.venueLabel, 'To be announced'),
                    orDash(ctx.participantNames && ctx.participantNames.length
                        ? `${ctx.seatsLabel} (${ctx.participantNames.join(', ')})` : ctx.seatsLabel),
                    ctx.settledVia === 'free' ? 'Free event, no payment required'
                        : orDash(`${ctx.amountLabel} ${ctx.paymentLabel ? `- ${ctx.paymentLabel}` : ''}`),
                    ctx.bookingRef || 'See your email'
                ], [
                    ctx.firstName || 'Member',
                    `your confirmed booking ${ctx.bookingRef} (${ctx.seatsLabel}) for ${clause(title, 110)}`,
                    ctx.whenLabel || 'the scheduled date'
                ]),
                text: `ACTIV: Booking confirmed ✅`
                    + `\n\nHello ${ctx.firstName || 'Member'},`
                    + `\nYour booking for *${title}* is confirmed.`
                    + `\n\nReference: ${ctx.bookingRef}`
                    + (ctx.dateLabel ? `\nDate: ${ctx.dateLabel}` : '')
                    + (ctx.timeLabel ? `\nTime: ${ctx.timeLabel}` : '')
                    + (ctx.venueLabel ? `\n${ctx.isOnline ? 'Attend' : 'Venue'}: ${ctx.venueLabel}` : '')
                    + (ctx.mapUrl ? `\nMap: ${ctx.mapUrl}` : '')
                    + `\nSeats: ${ctx.seats}`
                    + (ctx.participantNames && ctx.participantNames.length
                        ? `\nParticipants: ${ctx.participantNames.join(', ')}` : '')
                    + (ctx.settledVia === 'free'
                        ? '\nAmount: Free'
                        : `\nAmount: ${ctx.amountLabel}\nPayment: ${ctx.paymentLabel}`
                            + (ctx.paymentId ? ` (ID ${ctx.paymentId})` : ''))
                    + (ctx.contactLine ? `\n\nQuestions? ${ctx.contactLine}` : '')
                    + (ctx.viewUrl ? `\nYour booking: ${ctx.viewUrl}` : '')
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
                subject: `Booking cancelled — ${title} (${ctx.bookingRef})`,
                title: 'Your booking has been cancelled',
                preheader: `${title}${ctx.whenLabel ? ` · ${ctx.whenLabel}` : ''}`,
                tone: 'danger',
                badge: 'Booking cancelled',
                highlight: { label: 'Cancelled booking', value: ctx.bookingRef },
                actionButton: ctx.eventUrl ? { label: 'View the event', url: ctx.eventUrl } : undefined,
                bodyHtml: `
                    <p style="margin:0 0 12px 0;">Your booking <strong>${esc(ctx.bookingRef)}</strong> for
                    <strong>${ctx.eventTitleHtml || 'this event'}</strong> has been cancelled by the organiser,
                    and the ${esc(ctx.seatsLabel)} it held ${ctx.seats === 1 ? 'has' : 'have'} been released.</p>
                    ${ctx.reason ? `<p style="margin:0 0 12px 0;"><strong>Reason:</strong> ${esc(ctx.reason)}</p>` : ''}
                    <p style="margin:0 0 12px 0;">If you think this is a mistake, or you have a question about
                    a payment you made, please contact the organiser${ctx.contactLine
                        ? ` — ${esc(ctx.contactLine)}` : ''}.</p>`,
                facts: [
                    { label: 'Booking reference', value: ctx.bookingRef },
                    { label: 'Event', value: ctx.eventTitle },
                    { label: 'Date', value: ctx.dateLabel },
                    { label: 'Time', value: ctx.timeLabel },
                    { label: 'Seats released', value: String(ctx.seats || '') },
                    { label: 'Amount', value: ctx.settledVia === 'free' ? '' : ctx.amountLabel },
                    { label: 'Payment', value: ctx.paymentLabel }
                ]
            },
            whatsapp: {
                ...bookingWhatsApp(TPL.bookingCancel, [
                    ctx.firstName || 'Member',
                    ctx.bookingRef || 'your booking',
                    clause(title, 120) || 'the event',
                    orDash(ctx.whenLabel, 'Date to be confirmed'),
                    orDash(ctx.reason, 'No reason was given'),
                    orDash(ctx.contactLine, 'the ACTIV office')
                ], [
                    ctx.firstName || 'Member',
                    `the CANCELLATION of your booking ${ctx.bookingRef} for ${clause(title, 110)}`,
                    ctx.whenLabel || 'the scheduled date'
                ]),
                text: `ACTIV: Booking cancelled`
                    + `\n\nHello ${ctx.firstName || 'Member'},`
                    + `\nYour booking ${ctx.bookingRef} for *${title}*`
                    + (ctx.whenLabel ? ` (${ctx.whenLabel})` : '')
                    + ` has been cancelled by the organiser.`
                    + (ctx.reason ? `\nReason: ${oneLine(ctx.reason)}` : '')
                    + (ctx.contactLine ? `\n\nQuestions? ${ctx.contactLine}` : '')
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
                subject: `Waitlist — ${title} (${ctx.bookingRef})`,
                title: 'You are on the waitlist',
                preheader: `${title}${ctx.whenLabel ? ` · ${ctx.whenLabel}` : ''}`,
                tone: 'warning',
                badge: 'Waitlist',
                highlight: { label: 'Waitlist reference', value: ctx.bookingRef },
                actionButton: ctx.eventUrl ? { label: 'View the event', url: ctx.eventUrl } : undefined,
                bodyHtml: `
                    <p style="margin:0 0 12px 0;"><strong>${ctx.eventTitleHtml || 'This event'}</strong> is fully
                    booked, so your request for ${esc(ctx.seatsLabel)} has been placed on the waitlist.
                    <strong>No seat is held and nothing has been charged.</strong></p>
                    <p style="margin:0 0 12px 0;">The organiser will contact you if seats become available.</p>`,
                facts: [
                    { label: 'Reference', value: ctx.bookingRef },
                    { label: 'Event', value: ctx.eventTitle },
                    { label: 'Date', value: ctx.dateLabel },
                    { label: 'Time', value: ctx.timeLabel },
                    { label: 'Seats requested', value: String(ctx.seats || '') },
                    { label: 'Organiser contact', value: ctx.contactLine }
                ]
            },
            whatsapp: {
                template: TPL.event,
                params: [
                    ctx.firstName || 'Member',
                    `your WAITLIST request ${ctx.bookingRef} for ${clause(title, 110)} (event full, nothing charged)`,
                    ctx.whenLabel || 'the scheduled date'
                ],
                text: `ACTIV: You are on the waitlist`
                    + `\n\nHello ${ctx.firstName || 'Member'},`
                    + `\n*${title}* is fully booked. Your request for ${ctx.seatsLabel} is on the waitlist`
                    + ` (${ctx.bookingRef}). No seat is held and nothing has been charged.`
                    + (ctx.contactLine ? `\n\nQuestions? ${ctx.contactLine}` : '')
            }
        };
    },

    EVENT_BOOKING_REMINDER: (ctx) => {
        const title = ctx.eventTitle || 'your event';
        return {
            inApp: {
                title: 'Event reminder',
                message: `${title} starts ${ctx.startsInLabel}${ctx.whenLabel ? ` — ${ctx.whenLabel}` : ''}.`,
                type: 'info'
            },
            email: {
                subject: `Reminder: ${title} starts ${ctx.startsInLabel}`,
                title: `${title} starts ${ctx.startsInLabel}`,
                preheader: `${ctx.whenLabel || ''}${ctx.venueLabel ? ` · ${ctx.venueLabel}` : ''}`,
                tone: 'info',
                badge: 'Event reminder',
                highlight: { label: 'Your booking reference', value: ctx.bookingRef, note: 'Show this at the registration desk.' },
                bodyHtml: `
                    <p style="margin:0 0 12px 0;">This is a reminder that
                    <strong>${ctx.eventTitleHtml || 'your event'}</strong> starts
                    <strong>${esc(ctx.startsInLabel)}</strong>. Your ${esc(ctx.seatsLabel)}
                    ${ctx.seats === 1 ? 'is' : 'are'} confirmed under booking
                    <strong>${esc(ctx.bookingRef)}</strong>.</p>
                    ${participantsHtml(ctx.participantNames)}
                    ${beforeYouComeHtml(ctx)}`,
                facts: [
                    { label: 'Booking reference', value: ctx.bookingRef },
                    { label: 'Date', value: ctx.dateLabel },
                    { label: 'Time', value: ctx.timeLabel },
                    { label: ctx.isOnline ? 'Attend' : 'Venue', value: ctx.venueLabel },
                    { label: 'Seats', value: String(ctx.seats || '') },
                    { label: 'Organiser contact', value: ctx.contactLine }
                ],
                actionButton: ctx.viewUrl ? { label: 'View your booking', url: ctx.viewUrl } : undefined,
                secondaryButton: ctx.mapUrl ? { label: 'Get directions', url: ctx.mapUrl } : undefined
            },
            whatsapp: {
                ...bookingWhatsApp(TPL.bookingReminder, [
                    ctx.firstName || 'Member',
                    clause(title, 120) || 'your event',
                    ctx.startsInLabel || 'soon',
                    orDash(ctx.whenLabel, 'Date to be confirmed'),
                    orDash(ctx.venueLabel, 'To be announced'),
                    ctx.bookingRef || 'See your email',
                    orDash(ctx.seatsLabel)
                ], [
                    ctx.firstName || 'Member',
                    `${clause(title, 110)} (booking ${ctx.bookingRef}, ${ctx.seatsLabel})`,
                    ctx.whenLabel || 'the scheduled date'
                ]),
                text: `ACTIV reminder ⏰`
                    + `\n\nHello ${ctx.firstName || 'Member'},`
                    + `\n*${title}* starts ${ctx.startsInLabel}.`
                    + (ctx.dateLabel ? `\nDate: ${ctx.dateLabel}` : '')
                    + (ctx.timeLabel ? `\nTime: ${ctx.timeLabel}` : '')
                    + (ctx.venueLabel ? `\n${ctx.isOnline ? 'Attend' : 'Venue'}: ${ctx.venueLabel}` : '')
                    + (ctx.mapUrl ? `\nMap: ${ctx.mapUrl}` : '')
                    + `\nBooking: ${ctx.bookingRef} (${ctx.seatsLabel})`
                    + (ctx.contactLine ? `\n\nQuestions? ${ctx.contactLine}` : '')
            }
        };
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
    /*
     * THE DETAILED BOOKING TEMPLATES — Meta Cloud API ({{n}} placeholders).
     *
     * Sent only once their names are set (BOTBEE_TPL_BOOKING, _CANCEL,
     * _REMINDER). `scripts/whatsapp-booking-templates.js --submit` creates them
     * on the WhatsApp Business Account for review; the samples are what Meta's
     * reviewers see. Emoji are fine in a Utility body; every variable has text
     * on both sides, which review requires.
     */
    {
        name: 'activ_booking_confirmed',
        envKey: 'BOTBEE_TPL_BOOKING',
        category: 'Utility',
        meta: true,
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Hello {{1}}, your booking for *{{2}}* is confirmed! 🎉\n\n'
            + '📅 Date & time: {{3}}\n'
            + '📍 Venue: {{4}}\n'
            + '🎟️ Seats: {{5}}\n'
            + '💳 Payment: {{6}}\n'
            + '🔖 Booking reference: {{7}}\n\n'
            + 'Please arrive 15 to 30 minutes early and show your booking reference at the registration desk. '
            + 'A detailed confirmation has also been sent to your email.\n\n'
            + 'We look forward to welcoming you! Reply EVENTS to see your bookings and upcoming ACTIV events.',
        params: ['first name', 'event', 'date & time', 'venue', 'seats', 'payment', 'booking reference'],
        samples: ['Tharun', 'SCST Economic Liberty Conference', 'Saturday, 10 October 2026, 9:00 AM - 5:30 PM IST',
            'DNC Vijay Mahal, Dharmapuri', '2 seats (Tharun, Ravi)', 'Rs 2,000 - Paid online', 'ACTIVB-MUEE9IBU-445B']
    },
    {
        name: 'activ_booking_cancelled',
        envKey: 'BOTBEE_TPL_BOOKING_CANCEL',
        category: 'Utility',
        meta: true,
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Hello {{1}}, your booking {{2}} for *{{3}}* on {{4}} has been cancelled by the organiser.\n\n'
            + '📝 Reason: {{5}}\n\n'
            + 'The seats held by this booking have been released. If you think this is a mistake or have a '
            + 'question about a payment, please contact {{6}}.\n\n'
            + 'Reply EVENTS to see other upcoming ACTIV events.',
        params: ['first name', 'booking reference', 'event', 'date & time', 'reason', 'organiser contact'],
        samples: ['Tharun', 'ACTIVB-MUEE9IBU-445B', 'SCST Economic Liberty Conference',
            'Saturday, 10 October 2026, 9:00 AM IST', 'Duplicate booking', 'ACTIV Events, +91 82201 12188']
    },
    {
        name: 'activ_booking_reminder',
        envKey: 'BOTBEE_TPL_BOOKING_REMINDER',
        category: 'Utility',
        meta: true,
        body: '(Meta template with variables - submit bodyWithVariables below)',
        bodyWithVariables: 'Hello {{1}}, a friendly reminder that *{{2}}* starts {{3}}! ⏰\n\n'
            + '📅 Date & time: {{4}}\n'
            + '📍 Venue: {{5}}\n'
            + '🔖 Booking reference: {{6}} ({{7}})\n\n'
            + 'Please arrive 15 to 30 minutes early for registration and carry your booking reference. '
            + 'See you there!',
        params: ['first name', 'event', 'starts in', 'date & time', 'venue', 'booking reference', 'seats'],
        samples: ['Tharun', 'SCST Economic Liberty Conference', 'tomorrow',
            'Saturday, 10 October 2026, 9:00 AM - 5:30 PM IST', 'DNC Vijay Mahal, Dharmapuri',
            'ACTIVB-MUEE9IBU-445B', '2 seats']
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
