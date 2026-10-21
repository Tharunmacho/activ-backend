// Fixed labels and line breaks live in versioned Meta bodies. A parameter is
// always one fact on one line; approved older contracts remain in the fallback.
const flex = require('./whatsappFlex');
const config = require('../../config');
const { attendanceLink } = require('./eventAttendance');
const appUrl = path => `${String(config.frontendUrl || 'https://activ.org.in').replace(/\/+$/, '')}${path}`;
const line = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const name = ctx => (ctx.forParticipant ? ctx.participantName : '') || ctx.name || ctx.bookerName || ctx.firstName || 'Member';
const field = (label, read, sample, options = {}) => ({ label, read, sample, ...options });
const memberUrl = appUrl('/member/dashboard');
const eventUrl = ctx => ctx.eventUrl || appUrl('/events');
const bookingUrl = ctx => ctx.forParticipant ? ctx.ticketUrl || eventUrl(ctx) : ctx.viewUrl || ctx.ticketUrl || eventUrl(ctx);
const reference = ctx => ctx.bookingRef || ctx.reference || ctx.applicationRef;
const eventFields = () => [
    field('Event', ctx => ctx.eventTitle, 'Entrepreneurship workshop', { max: 110 }),
    field('Date', ctx => ctx.dateLabel || 'See the event schedule', '23 October 2026', { max: 70 }),
    field('Time', ctx => ctx.timeLabel || 'See the event schedule', '10:00 AM IST', { max: 60 }),
    field('Where', ctx => ctx.isOnline ? ['Online', ctx.onlinePlatform].filter(Boolean).join(' on ')
        : ctx.venueLabel || ctx.venue || 'To be announced by the organiser', 'Chennai', { max: 130 }),
];
const queries = email => field('Queries', () => email, email, { protected: true });
const bookingRef = () => field('Booking ID', reference, 'ACTIVB-ABC123', { protected: true });
const bookingLink = () => field('Booking details', bookingUrl, 'https://activ.org.in/events/workshop/book?ref=ACTIVB-ABC123', { protected: true, separate: true });
const definitions = [];
const specs = new Map();

function define(key, title, lead, fields, { image = false, version = 'v1', close = 'Keep this message with your ACTIV records.' } = {}) {
    const all = [field('name', name, 'Tharun', { max: 60 }), ...fields.flatMap(item => item.labelRead
        ? [field(`${item.label} label`, item.labelRead, item.labelSample, { protected: true, heading: true }), item] : [item])];
    let body = `Dear *{{1}}*,\n\n*${title}*\n${lead}\n\n`;
    all.slice(1).forEach((item, index) => {
        if (!item.heading) body += `*${item.labelRead ? `{{${index + 1}}}` : item.label}:*${item.separate ? '\n' : ' '}{{${index + 2}}}\n\n`;
    });
    body += close;
    const names = image ? ['image', 'plain'] : ['plain'];
    const spec = { key, version, body, fields: all, names };
    specs.set(`${key}_${version}`, spec);
    for (const variant of names) definitions.push({
        name: `activ_${key}_standard_${variant}_${version}`, category: 'Utility', meta: true, standard: true,
        ...(variant === 'image' ? { header: 'IMAGE' } : {}), footer: require('./organizationBrand').FOOTER,
        bodyWithVariables: body, params: all.map(item => item.label), samples: all.map(item => item.sample),
    });
}

for (const kind of ['confirmed', 'reminder', 'cancelled', 'waitlist']) {
    const title = { confirmed: 'Event booking confirmed', reminder: 'Event reminder',
        cancelled: 'Booking cancelled', waitlist: 'Event waitlist update' }[kind];
    const lead = { confirmed: 'Your event registration is confirmed.', reminder: 'Your booked event is coming up.',
        cancelled: 'Your booking has been cancelled. This notice does not confirm a refund.',
        waitlist: 'Your request is waitlisted. No seat is held and nothing has been charged.' }[kind];
    for (const channel of ['confirmed', 'reminder'].includes(kind) ? [false, true] : [false]) {
        const fields = eventFields();
        if (kind === 'reminder') fields.push(field('Starts', ctx => ctx.startsInLabel || 'At the scheduled time', 'tomorrow', { max: 40 }));
        fields.push(field(kind === 'waitlist' ? 'Seats requested' : kind === 'cancelled' ? 'Seats released' : 'Seats',
            ctx => ctx.forParticipant ? '1 seat' : ctx.seatsLabel || `${Number(ctx.seats) || 1} seat(s)`, '1 seat', { max: 40 }));
        if (['confirmed', 'reminder'].includes(kind)) fields.push(field('Payment / reservation', ctx => ctx.forParticipant
            ? `Booked for you${ctx.bookerName ? ` by ${ctx.bookerName}` : ''}` : flex.feeOf(ctx) || 'See your booking record',
        'Free entry', { max: 110 }));
        if (kind === 'cancelled') fields.push(field('Reason', ctx => ctx.reason || 'No reason was recorded', 'Duplicate booking', { max: 160 }));
        fields.push(bookingRef());
        if (['confirmed', 'reminder'].includes(kind)) fields.push(field('Event attendance',
            ctx => ctx.registerUrl || ctx.mapUrl || eventUrl(ctx), 'https://activ.org.in/events/workshop', { protected: true, separate: true }));
        fields.push(bookingLink());
        if (channel) fields.push(field('WhatsApp updates for this event', ctx => ctx.whatsappChannelUrl,
            'https://whatsapp.com/channel/0029VaDdseGKLaHrWNV7ZK1X', { protected: true, separate: true }));
        fields.push(queries('events@activ.org.in'));
        define(`evt_${kind}${channel ? '_whatsapp' : ''}`, title, lead, fields, { image: true,
            close: 'Open your event or booking page for the latest information and documents.' });
    }
}

define('payment_failed', 'Payment attempt unsuccessful', 'Your payment has not been confirmed.', [
    field('Payment for', ctx => ctx.eventTitle || ctx.companyName || ctx.planName || (ctx.orderType === 'company_listing' ? 'Business publishing' : 'Membership'), 'Beginner membership', { max: 110 }),
    field('Order', ctx => ctx.orderId || ctx.reference || 'See your payment record', 'ORD-ABC123', { protected: true }),
    field('Attempted amount', ctx => ctx.amountLabel || 'See your payment record', 'Rs 500', { max: 40 }),
    field('Check payment status', ctx => ctx.retryUrl || ctx.viewUrl || appUrl('/payment/membership-plans'), 'https://activ.org.in/payment/membership-plans', { protected: true, separate: true }),
    field('Queries', ctx => ctx.supportEmail, 'member@activ.org.in', { protected: true }),
], { close: 'If your bank shows a debit, contact us with the payment reference before trying again.' });
define('company_payment', 'Business publishing payment confirmed', 'Your business publishing plan is active.', [
    field('Business', ctx => ctx.companyName || 'Your business listing', 'Sri Lakshmi Enterprises', { max: 100 }),
    field('Plan', ctx => ctx.planName || 'See your payment receipt', 'Annual publishing', { max: 70 }),
    field('Amount paid', ctx => ctx.amountLabel || 'See your payment receipt', 'Rs 500', { max: 40 }),
    field('Order', ctx => ctx.orderId || 'See your payment receipt', 'ORD-ABC123', { protected: true }),
    field('Payment receipt', ctx => ctx.receiptUrl || memberUrl, memberUrl, { protected: true, separate: true }),
    queries('member@activ.org.in'),
], { close: 'This payment does not change your membership ID or paid membership validity.' });
define('membership_plan', 'Your membership plan has advanced', 'Congratulations on your next membership stage.', [
    field('Member ID', ctx => ctx.membershipNumber, 'ACTIV-BEG-20261012-001', { protected: true }),
    field('Previous plan', ctx => ctx.previousPlanName || 'See your membership history', 'Beginner', { max: 70 }),
    field('Current plan', ctx => ctx.planName, 'Intermediate', { max: 70 }),
    field('Paid validity', ctx => ctx.validUntilLabel || 'Unchanged; see your membership record', '11 October 2027', { max: 80 }),
    field('Fee at renewal', ctx => ctx.feeLabel || 'See the current plan price at renewal', 'Rs 1,000', { max: 70 }),
    field('Membership details', () => memberUrl, memberUrl, { protected: true, separate: true }),
    queries('member@activ.org.in'),
], { close: 'No extra payment is due now. Your paid validity stays the same; the new fee applies at renewal.' });
define('membership_status', 'Membership record updated', 'Please review this update to your existing membership record.', [
    field('Update', ctx => ctx.changeTitle || 'Membership request updated', 'Lifetime request reviewed', { max: 100 }),
    field('Reference', ctx => ctx.reference || ctx.membershipNumber || 'See your membership record', 'ACTIV-APP-20261012-001', { protected: true }),
    field('Details', ctx => ctx.changeSummary || ctx.reason || 'Open your dashboard to review the current status.', 'The membership office has completed its review.', { max: 280 }),
    field('Membership details', () => memberUrl, memberUrl, { protected: true, separate: true }),
    queries('member@activ.org.in'),
]);
define('event_updated', 'Event details updated', 'Please check the current information before attending.', [
    ...eventFields(), bookingRef(),
    field('What changed', ctx => ctx.changeSummary || 'The organiser updated the event details.', 'The start time has changed.', { max: 180 }),
    field('Latest event details', ctx => ctx.viewUrl || eventUrl(ctx), 'https://activ.org.in/events/workshop', { protected: true, separate: true }),
    queries('events@activ.org.in'),
]);
define('event_cancelled', 'Event registration update', 'A cancellation affects your registration.', [
    field('Event', ctx => ctx.eventTitle, 'Entrepreneurship workshop', { max: 110 }),
    field('Status', ctx => ctx.cancelledScope === 'registration' ? 'Registration cancelled' : 'Event cancelled', 'Event cancelled', { max: 60 }),
    bookingRef(), field('Reason', ctx => ctx.reason || 'The organiser has withdrawn this event.', 'The venue is unavailable.', { max: 180 }),
    field('Event details', ctx => ctx.viewUrl || eventUrl(ctx), 'https://activ.org.in/events/workshop', { protected: true, separate: true }),
    queries('events@activ.org.in'),
], { close: 'This notice does not confirm a refund. Contact the events team for payment questions.' });

// Never change an approved v1 body's parameter contract. v2 includes the
// attendance instruction and optional video on their own labelled lines.
const attendanceField = () => field('Attendance link', ctx => attendanceLink(ctx).url || eventUrl(ctx),
    'https://zoom.us/meeting/register/example', { protected: true, separate: true,
        labelRead: ctx => attendanceLink(ctx).label, labelSample: 'Online registration link' });
const videoField = () => field('Event video', ctx => ctx.videoUrl, 'https://youtu.be/example', { protected: true, separate: true });
for (const kind of ['confirmed', 'reminder']) for (const channel of [false, true]) for (const video of [false, true]) {
    const key = `evt_${kind}${channel ? '_whatsapp' : ''}`;
    const original = specs.get(`${key}_v1`);
    const fields = original.fields.slice(1).flatMap(item => item.label === 'Event attendance'
        ? [attendanceField(), ...(video ? [videoField()] : [])] : [item]);
    define(`${key}${video ? '_video' : ''}`, kind === 'confirmed' ? 'Event booking confirmed' : 'Event reminder',
        kind === 'confirmed' ? 'Your event registration is confirmed.' : 'Your booked event is coming up.', fields,
        { image: true, version: 'v2', close: 'Open your event or booking page for the latest information and documents.' });
}
for (const channel of [false, true]) for (const video of [false, true]) {
    define(`event_updated${channel ? '_whatsapp' : ''}${video ? '_video' : ''}`, 'Event details updated',
        'Please check the current information before attending.', [
            ...eventFields(), bookingRef(),
            field('What changed', ctx => ctx.changeSummary || 'The organiser updated the event details.', 'The start time has changed.', { max: 180 }),
            attendanceField(), ...(video ? [videoField()] : []),
            field('Latest event details', bookingUrl, 'https://activ.org.in/events/workshop', { protected: true, separate: true }),
            ...(channel ? [field('WhatsApp updates for this event', ctx => ctx.whatsappChannelUrl,
                'https://chat.whatsapp.com/ExampleInvite', { protected: true, separate: true })] : []),
            queries('events@activ.org.in'),
        ], { version: 'v2' });
}

const EVENT_KINDS = { EVENT_BOOKING_CONFIRMED: 'confirmed', EVENT_PARTICIPANT_CONFIRMED: 'confirmed', EVENT_REGISTERED: 'confirmed',
        EVENT_BOOKING_REMINDER: 'reminder', EVENT_PARTICIPANT_REMINDER: 'reminder', EVENT_REMINDER: 'reminder',
        EVENT_BOOKING_CANCELLED: 'cancelled', EVENT_PARTICIPANT_CANCELLED: 'cancelled', EVENT_BOOKING_WAITLISTED: 'waitlist' };
function keyFor(event, ctx) {
    const kind = EVENT_KINDS[event];
    if (['confirmed', 'reminder'].includes(kind) || event === 'EVENT_UPDATED') {
        return `${kind ? `evt_${kind}` : 'event_updated'}${ctx.whatsappChannelUrl ? '_whatsapp' : ''}${ctx.videoUrl ? '_video' : ''}_v2`;
    }
    if (kind) return `evt_${kind}_v1`;
    return { PAYMENT_FAILED: 'payment_failed', EVENT_PAYMENT_FAILED: 'payment_failed', COMPANY_PAYMENT_CONFIRMED: 'company_payment',
        MEMBERSHIP_PLAN_ADVANCED: 'membership_plan', MEMBERSHIP_STATUS_CHANGED: 'membership_status',
        EVENT_CANCELLED: 'event_cancelled' }[event] + '_v1';
}
function prepare(event, input = {}) {
    const ctx = { ...input, supportEmail: /^EVENT_/.test(event) ? 'events@activ.org.in' : 'member@activ.org.in',
        forParticipant: /^EVENT_PARTICIPANT_/.test(event) || input.forParticipant };
    const spec = specs.get(keyFor(event, ctx));
    if (!spec) return null;
    const params = spec.fields.map(item => {
        const value = line(item.read(ctx));
        return item.max && value.length > item.max ? `${value.slice(0, item.max - 1)}…` : value;
    });
    if (params.some(value => !value)) return null;
    for (let guard = 0; flex.renderBody(spec.body, params).length > 1000 && guard < 40; guard++) {
        const candidates = spec.fields.map((item, i) => ({ item, i }))
            .filter(({ item, i }) => !item.protected && item.max && params[i].length > 32);
        if (!candidates.length) return null; // Never damage an ID or URL to fit.
        const { i } = candidates.sort((a, b) => params[b.i].length - params[a.i].length)[0];
        params[i] = `${params[i].slice(0, Math.max(31, params[i].length - 25))}…`;
    }
    return { spec, params, rendered: flex.renderBody(spec.body, params) };
}
function prepend(event, ctx, current, defaultPoster, variants) {
    if (!current?.template || current.template === 'none') return current;
    const result = prepare(event, ctx);
    if (!result || result.rendered.length > 1024) return current;
    const { spec, params } = result;
    // The approved record-notice contract keeps exact attendance/video/group
    // links during review of v2. It is used only after a definite refusal, under
    // the dispatcher's existing fallback rules (never after a timeout).
    if (spec.version === 'v2' && (ctx.videoUrl || ctx.isOnline || event === 'EVENT_UPDATED')) {
        const attendance = attendanceLink(ctx);
        const participant = /^EVENT_PARTICIPANT_/.test(event) || ctx.forParticipant;
        const summary = [
            line(ctx.eventTitle).slice(0, 90),
            [ctx.dateLabel, ctx.timeLabel].filter(Boolean).map(line).join(', '),
            ctx.isOnline ? `Online${ctx.onlinePlatform ? ` on ${line(ctx.onlinePlatform)}` : ''}` : line(ctx.venueLabel || ctx.venue).slice(0, 90),
            `Booking ID: ${line(reference(ctx))}`,
            ...(event === 'EVENT_UPDATED' ? [line(ctx.changeSummary).slice(0, 120)] : [
                participant ? '1 seat, booked for you' : `${line(ctx.seatsLabel) || '1 seat'}; ${line(flex.feeOf(ctx))}`,
            ]),
            attendance.url ? `${attendance.label}: ${line(attendance.url)}` : '',
            ctx.videoUrl ? `Event video: ${line(ctx.videoUrl)}` : '',
            ctx.whatsappChannelUrl ? `WhatsApp updates: ${line(ctx.whatsappChannelUrl)}` : '',
        ].filter(Boolean).join(' | ');
        const title = event === 'EVENT_UPDATED' ? 'Event details updated' : EVENT_KINDS[event] === 'reminder' ? 'Event reminder' : 'Event booking confirmed';
        const values = [line(name({ ...ctx, forParticipant: participant })).slice(0, 40), title, summary,
            line(bookingUrl({ ...ctx, forParticipant: participant })), 'events@activ.org.in'];
        if (values.every(Boolean) && flex.renderBody(require('./workflowTemplates').RECORD_UPDATE_BODY, values).length <= 1024) {
            current = { template: 'activ_record_update_v1', params: values, fallback: current, text: current.text, skipped: current.skipped };
        }
    }
    return spec.names.filter(variant => !variants || variants.includes(variant)).reduceRight((fallback, variant) => ({
        template: `activ_${spec.key}_standard_${variant}_${spec.version}`, params,
        ...(variant === 'image' ? { headerImage: ctx.posterUrl || defaultPoster } : {}), fallback,
        text: current.text, skipped: current.skipped,
    }), current);
}
module.exports = { WHATSAPP_TEMPLATES: definitions, prepare, prepend, EVENT_KINDS };
