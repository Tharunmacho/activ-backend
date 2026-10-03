/**
 * Event-booking messages: real information only, confirmed exactly once on
 * every payment path, and delivery tracked after the provider said yes.
 *
 * PURE UNIT, NO DB AND NO NETWORK. Every model method and every sender is
 * replaced with a recorder, so nothing here can message anybody.
 *
 *   node tests/booking-delivery.test.js
 */

process.env.PAYMENT_SIGNING_SECRET = process.env.PAYMENT_SIGNING_SECRET || 'unit-test-secret';
process.env.PAYMENT_RECONCILE_ENABLED = 'false';
process.env.EVENT_REMINDERS_ENABLED = 'false';

const templates = require('../src/modules/notifications/notificationTemplates');
const deliveryStatus = require('../src/modules/notifications/deliveryStatus.service');
const deliveryQuery = require('../src/modules/notifications/deliveryQuery');
const NotificationLog = require('../src/modules/notifications/notificationLog.model');
const notificationService = require('../src/modules/notifications/notification.service');
const EventBooking = require('../src/modules/events/eventbooking.model');
const Event = require('../src/modules/events/event.model');
const bookingService = require('../src/modules/events/eventbooking.service');
const paymentService = require('../src/modules/payment/payment.service');
const PaymentOrder = require('../src/modules/payment/paymentorder.model');
const config = require('../src/config');
const publicUrl = require('../src/config/publicUrl');

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else {
        failed++; failures.push(`${label}${detail ? '  — ' + detail : ''}`);
        console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
    }
    return ok;
};
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================= 1. real information only */

const INVENTED = [
    /ACTIV Office/i, /82201\s?12188/, /enquiry@activ\.org\.in/i, /the ACTIV office/i,
    /photo\s*ID/i, /30 minutes/i, /5 minutes/i, /stable internet/i, /Rajesh/i,
    /will be added here soon/i, /reach you (soon|shortly)/i, /Shared before the event/i
];

/** Every string a rendered message could put in front of a person. */
const allText = (rendered) => {
    const parts = [];
    const walk = (v) => {
        if (v === null || v === undefined) return;
        if (typeof v === 'string') { parts.push(v); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k !== 'skipped') walk(x); });
    };
    walk(rendered);
    return parts.join('\n');
};

const chainOf = (wa) => {
    const out = [];
    for (let s = wa; s; s = s.fallback) out.push(s);
    return out;
};

const baseCtx = (over = {}) => ({
    kind: 'confirmed',
    bookingRef: 'ACTIVB-TEST-0001',
    eventTitle: 'SCST Economic Liberty Conference',
    name: 'Sampath Kumar', firstName: 'Sampath', bookerName: 'Sampath Kumar', bookerEmail: 'b@example.com',
    dateLabel: 'Saturday, 10 October 2026', timeLabel: '9:00 AM – 5:00 PM IST', whenLabel: 'Saturday, 10 October 2026, 9:00 AM IST',
    startClock: '9:00 AM IST', reportTimeLabel: '8:30 AM IST', joinTimeLabel: '8:55 AM IST',
    venueLabel: 'DNC Vijay Mahal, Dharmapuri', venue: 'DNC Vijay Mahal, Dharmapuri', formatLabel: 'In-person event',
    seats: 1, seatsLabel: '1 seat', participantNames: ['Sampath Kumar'],
    amountLabel: '₹1,500', settledVia: 'online', paymentLabel: 'Paid online',
    contactName: '', contactPhone: '', contactEmail: '', contactLine: '',
    attendeeNote: '', viewUrl: 'https://activ.org.in/events/x/book?ref=ACTIVB-TEST-0001',
    eventUrl: 'https://activ.org.in/events/x', ticketUrl: 'https://activ.org.in/events/x/book?ref=ACTIVB-TEST-0001',
    data: { bookingRef: 'ACTIVB-TEST-0001', eventId: 'e1' },
    ...over
});

const testRealInfoOnly = () => {
    section('No invented contact, instruction or promise reaches a booker');

    const cases = [
        ['in-person confirmation, no contact', 'EVENT_BOOKING_CONFIRMED', baseCtx()],
        ['webinar confirmation, email only (the reported case)', 'EVENT_BOOKING_CONFIRMED',
            baseCtx({ isOnline: true, onlinePlatform: 'Zoom', formatLabel: 'Online webinar on Zoom', venueLabel: 'Online (Zoom)',
                contactEmail: 'online@activ.org.in', contactLine: 'online@activ.org.in', registerUrl: '' })],
        ['reminder, no contact', 'EVENT_BOOKING_REMINDER', baseCtx({ kind: 'reminder', startsInLabel: 'tomorrow' })],
        ['cancellation, no contact', 'EVENT_BOOKING_CANCELLED', baseCtx({ kind: 'cancelled', reason: 'Duplicate' })],
        ['participant seat, no contact', 'EVENT_PARTICIPANT_CONFIRMED', baseCtx({ participantName: 'Priya', participantEmail: 'p@example.com' })],
        ['waitlist', 'EVENT_BOOKING_WAITLISTED', baseCtx({ kind: 'waitlist' })]
    ];

    for (const [label, eventName, ctx] of cases) {
        const rendered = templates.render(eventName, ctx);
        const text = allText(rendered);
        const hits = INVENTED.filter((re) => re.test(text)).map(String);
        check(`${label}: nothing invented`, hits.length === 0, hits.join(', '));
    }

    // The reported webinar: "👤 Name: ACTIV Office" must not appear, and the
    // real email the editor saved must.
    const webinar = templates.render('EVENT_BOOKING_CONFIRMED', cases[1][2]);
    check('webinar text keeps the real organiser email', /online@activ\.org\.in/.test(webinar.whatsapp.text));
    check('webinar text has no Name line at all', !/Name:\*/.test(webinar.whatsapp.text));
    const chain = chainOf(webinar.whatsapp).map((s) => s.template);
    check('the 3-contact-line webinar template is skipped when the name is blank',
        !chain.some((t) => /webinar_registration_v[34]$/.test(t)), chain.join(' > '));
    check('the skip is recorded with its reason',
        (webinar.whatsapp.skipped || []).some((s) => /organiser name/.test(s)), JSON.stringify(webinar.whatsapp.skipped));
    check('no template parameter is blank or a dash placeholder for contact',
        chainOf(webinar.whatsapp).every((s) => (s.params || []).every((p) => String(p).trim() !== '')));

    // Organiser left everything blank: no contact block, no notes heading.
    const bare = templates.render('EVENT_BOOKING_CONFIRMED', baseCtx());
    check('no contact → no "Need help" block', !/Need help/.test(bare.whatsapp.text));
    check('no notes → no "Before you come" advice invented', !/Before you come|Please note/.test(bare.whatsapp.text));
    check('no notes → email has no invented advice box', !/Carry|arrive/i.test(bare.email.afterHtml || ''));
    check('no reporting-time row invented', !(bare.email.facts || []).some((f) => /Reporting/.test(f.label)));

    // Everything given: the rich template goes first, with exactly those values.
    const full = templates.render('EVENT_BOOKING_CONFIRMED', baseCtx({
        contactName: 'K. Ravi', contactPhone: '+918220112188', contactEmail: 'events@activ.org.in',
        contactLine: 'K. Ravi · +918220112188 · events@activ.org.in',
        attendeeNote: 'Bring your visiting cards\nLunch is provided'
    }));
    // The approved flexible templates lead by default (they are what Meta
    // actually delivers); the detailed template is the first step after them.
    const steps = chainOf(full.whatsapp);
    check('the approved flexible confirmation is tried first by default',
        steps[0].template === 'activ_evt_confirmed_readable_v1', steps.map((s) => s.template).join(' > '));
    const first = steps.find((s) => !/^activ_evt_/.test(s.template)) || {};
    check('with a full contact + two notes the detailed template is first after them', /event_booking_v4$/.test(first.template), first.template);
    check('its values are the organiser\'s own',
        first.params.includes('K. Ravi') && first.params.includes('events@activ.org.in')
        && first.params.includes('Bring your visiting cards') && first.params.includes('Lunch is provided'), JSON.stringify(first.params));
    check('the text lists the organiser name the editor saved', /Name:\* K\. Ravi/.test(full.whatsapp.text));

    // The cancellation with no contact goes on the generic notice, not "the ACTIV office".
    const cancel = templates.render('EVENT_BOOKING_CANCELLED', baseCtx({ kind: 'cancelled' }));
    check('cancellation with no contact does not name an office',
        !chainOf(cancel.whatsapp).some((s) => (s.params || []).some((p) => /office/i.test(p))));
};

/* ===================================== 2. confirmation exactly once, every path */

const stubs = [];
const stub = (obj, key, fn) => { stubs.push([obj, key, obj[key]]); obj[key] = fn; };
const restore = () => { while (stubs.length) { const [o, k, v] = stubs.pop(); o[k] = v; } };
const chain = (value) => ({ lean: () => chain(value), select: () => chain(value), sort: () => chain(value), limit: () => chain(value), catch: () => Promise.resolve(value), then: (a, b) => Promise.resolve(value).then(a, b) });

/** A fake booking store: one pending paid booking; the claim is real compare-and-set. */
const fakeBookingStore = () => {
    const doc = {
        _id: 'b1', bookingRef: 'ACTIVB-PAID-0001', eventId: 'e1', status: 'active', noOfPersons: 1, totalAmount: 1500,
        bookedBy: { name: 'Paid Booker', email: 'paid@example.com', phone: '9940100000' },
        participants: [{ name: 'Paid Booker', email: 'paid@example.com', phone: '9940100000' }],
        payment: { status: 'pending', reference: 'EVTPAY-X', mode: '' }, confirmationSentAt: null
    };
    stub(EventBooking, 'findOne', () => chain({ ...doc, payment: { ...doc.payment } }));
    stub(EventBooking, 'findOneAndUpdate', async(filter, update) => {
        if (!['pending', 'failed'].includes(doc.payment.status)) return null;
        doc.payment.status = 'paid';
        doc.payment.mode = update['payment.mode'];
        doc.payment.gatewayPaymentId = update['payment.gatewayPaymentId'];
        return { ...doc, payment: { ...doc.payment } };
    });
    stub(EventBooking, 'updateOne', async(filter, update) => {
        if (filter && 'confirmationSentAt' in filter) {
            if (doc.confirmationSentAt) return { matchedCount: 0, modifiedCount: 0 };
            doc.confirmationSentAt = update.$set.confirmationSentAt;
            return { matchedCount: 1, modifiedCount: 1 };
        }
        return { matchedCount: 1, modifiedCount: 1 };
    });
    stub(Event, 'findById', () => chain({ _id: 'e1', title: 'Paid Event', mode: 'offline', venue: 'Hall', startAt: new Date(Date.now() + 864e5) }));
    return doc;
};

const recordDispatches = () => {
    const sent = [];
    stub(notificationService, 'dispatchLifecycleEvent', async(eventName, recipient) => {
        sent.push({ eventName, to: recipient.email || recipient.phone });
        return { channels: {}, rows: {} };
    });
    stub(notificationService, 'log', async() => null);
    return sent;
};

const testExactlyOnce = async() => {
    section('A paid booking is confirmed exactly once, whichever path settles it');

    // (a) The claim: webhook and return page both call completePayment.
    fakeBookingStore();
    let sent = recordDispatches();
    const results = await Promise.allSettled([
        bookingService.completePayment('ACTIVB-PAID-0001', { gatewayPaymentId: 'MOJO1', signature: 'instamojo_webhook_verified', mode: 'online' }),
        bookingService.completePayment('ACTIVB-PAID-0001', { gatewayPaymentId: 'MOJO1', signature: 'instamojo_webhook_verified', mode: 'online' })
    ]);
    await wait(50);
    check('two simultaneous settlements: one succeeds', results.filter((r) => r.status === 'fulfilled').length === 1);
    check('…and ONE booker confirmation is sent', sent.filter((s) => s.eventName === 'EVENT_BOOKING_CONFIRMED').length === 1,
        JSON.stringify(sent));
    restore();

    // (b) The guard itself: announce twice on the same paid booking.
    const doc = fakeBookingStore();
    doc.payment.status = 'paid';
    sent = recordDispatches();
    bookingService.announce({ ...doc }, 'confirmed');
    bookingService.announce({ ...doc }, 'confirmed');
    await wait(50);
    check('announce(confirmed) twice sends once', sent.filter((s) => s.eventName === 'EVENT_BOOKING_CONFIRMED').length === 1,
        JSON.stringify(sent));
    restore();

    // (c) settleEventBookingOrder: the loser of the race is success, not an error.
    fakeBookingStore();
    sent = recordDispatches();
    const orderA = { orderId: 'ord_a', bookingRef: 'ACTIVB-PAID-0001', status: 'created', amount: 1500, save: async() => {} };
    const orderB = { orderId: 'ord_a', bookingRef: 'ACTIVB-PAID-0001', status: 'created', amount: 1500, save: async() => {} };
    stub(bookingService, 'getBooking', async() => ({ bookingRef: 'ACTIVB-PAID-0001', payment: { status: 'paid' } }));
    const [s1, s2] = await Promise.allSettled([
        paymentService.settleEventBookingOrder(orderA, 'MOJO2'),
        paymentService.settleEventBookingOrder(orderB, 'MOJO2')
    ]);
    await wait(50);
    check('webhook + return settling together both resolve', s1.status === 'fulfilled' && s2.status === 'fulfilled');
    check('…with one confirmation', sent.filter((s) => s.eventName === 'EVENT_BOOKING_CONFIRMED').length === 1);
    check('the order is marked paid', orderA.status === 'paid' && orderB.status === 'paid');
    restore();

    // (d) Webhook: an amount below the order is refused, and settles nothing.
    fakeBookingStore();
    sent = recordDispatches();
    stub(paymentService, 'verifyWebhookSignature', () => true);
    stub(PaymentOrder, 'findOne', async() => ({ orderId: 'ord_w', orderType: 'event_booking', bookingRef: 'ACTIVB-PAID-0001', status: 'created', amount: 1500, save: async() => {} }));
    const low = await paymentService.processPaymentWebhook({ payment_id: 'MOJO3', payment_status: 'Credit', amount: '10.00', buyer: 'x@y.z', payment_request_id: 'req' });
    check('webhook with a short amount is refused', low && low.success === false);
    const ok = await paymentService.processPaymentWebhook({ payment_id: 'MOJO3', payment_status: 'Credit', amount: '1500.00', buyer: 'x@y.z', payment_request_id: 'req' });
    await wait(50);
    check('webhook with the full amount confirms the booking', ok && ok.success === true);
    check('…and sends the confirmation once', sent.filter((s) => s.eventName === 'EVENT_BOOKING_CONFIRMED').length === 1);
    restore();

    // (e) Reconcile: never settles without the gateway saying Credit.
    fakeBookingStore();
    sent = recordDispatches();
    const pending = [{ orderId: 'ord_r', bookingRef: 'ACTIVB-PAID-0001', status: 'created', amount: 1500, gatewayPaymentId: 'req_r', save: async() => {} }];
    stub(PaymentOrder, 'find', () => chain(pending));
    stub(paymentService, 'isConfigured', () => true);
    stub(paymentService, 'verifyPaymentWithGateway', async() => ({ paid: false }));
    const none = await paymentService.reconcilePendingEventOrders();
    check('reconcile: gateway says unpaid → nothing settled', none.settled === 0 && sent.length === 0);
    paymentService.verifyPaymentWithGateway = async() => ({ paid: true, paymentId: 'MOJO4' });
    const one = await paymentService.reconcilePendingEventOrders();
    await wait(50);
    check('reconcile: gateway says Credit → settled and confirmed once',
        one.settled === 1 && sent.filter((s) => s.eventName === 'EVENT_BOOKING_CONFIRMED').length === 1, JSON.stringify(one));
    restore();

    // (f) The organiser's "confirm booking" (offline payment) takes the same guard.
    fakeBookingStore();
    sent = recordDispatches();
    stub(bookingService, 'seatsFor', async() => ({ capacity: 0, seatsTaken: 0, seatsLeft: Number.MAX_SAFE_INTEGER }));
    await bookingService.recordOfflinePayment('ACTIVB-PAID-0001', { mode: 'cash', recordedBy: 'admin' }).catch(() => null);
    await bookingService.recordOfflinePayment('ACTIVB-PAID-0001', { mode: 'cash', recordedBy: 'admin' }).catch(() => null);
    await wait(50);
    check('record-payment twice → one confirmation', sent.filter((s) => s.eventName === 'EVENT_BOOKING_CONFIRMED').length === 1,
        JSON.stringify(sent));
    restore();
};

/* ============================================ 3. delivery statuses from Meta */

const testDeliveryStatus = async() => {
    section('Meta delivery callbacks update the log row');

    const meta = {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { statuses: [
            { id: 'wamid.A', status: 'delivered', timestamp: '1790000000', recipient_id: '919940100000' },
            { id: 'wamid.B', status: 'failed', timestamp: '1790000001', errors: [{ code: 131053, title: 'Media upload error', error_data: { details: 'Downloading media from weblink failed' } }] }
        ] } }] }]
    };
    const found = deliveryStatus.extractStatuses(meta);
    check('both statuses are read from the Meta envelope', found.length === 2 && found[1].status === 'failed');
    check('an inbound text message is not a status', deliveryStatus.extractStatuses({ entry: [{ changes: [{ value: { messages: [{ from: '91', text: { body: 'hi' } }] } }] }] }).length === 0);

    const rows = {
        'wamid.A': { _id: 'r1', status: 'sent', deliveryStatus: 'accepted', statusHistory: [{ status: 'accepted' }] },
        'wamid.B': { _id: 'r2', status: 'sent', deliveryStatus: 'accepted', statusHistory: [{ status: 'accepted' }] },
        'wamid.C': { _id: 'r3', status: 'sent', deliveryStatus: 'read', statusHistory: [{ status: 'accepted' }, { status: 'read' }] }
    };
    const updates = {};
    stub(NotificationLog, 'findOne', (q) => chain(rows[q.providerMessageId] || null));
    stub(NotificationLog, 'updateOne', async(q, u) => { updates[q._id] = u; return { modifiedCount: 1 }; });

    await deliveryStatus.applyFromWebhook(meta);
    check('delivered is recorded', updates.r1 && updates.r1.$set.deliveryStatus === 'delivered' && updates.r1.$set.deliveredAt);
    check('failed flips the row to failed with Meta\'s reason',
        updates.r2 && updates.r2.$set.status === 'failed' && /Media upload error/.test(updates.r2.$set.failureReason)
        && updates.r2.$set.failureCode === '131053', JSON.stringify(updates.r2 && updates.r2.$set));
    await deliveryStatus.applyStatus({ id: 'wamid.C', status: 'delivered', timestamp: '1790000002' });
    check('a late "delivered" does not demote a read message', !updates.r3.$set.deliveryStatus);
    check('…but is kept in the timeline', updates.r3.$push.statusHistory.status === 'delivered');
    delete updates.r1;
    await deliveryStatus.applyStatus({ id: 'wamid.C', status: 'read' });
    check('a repeated callback is ignored', !updates.r1);
    restore();

    check('old "sent" rows read as accepted', deliveryStatus.effectiveStatus({ status: 'sent' }) === 'accepted');
    check('mock rows read as mock', deliveryStatus.effectiveStatus({ status: 'sent', mock: true }) === 'mock');
};

/* ================================================== 4. the Super Admin's query */

const testQuery = () => {
    section('Delivery filters');
    const q = deliveryQuery.buildLogQuery({ group: 'automation', delivery: 'failed', search: '+91 99401 00000', from: '2026-09-26', to: '2026-09-30' });
    const json = JSON.stringify(q);
    check('automation excludes the bot and in-app', /BOT_REPLY/.test(json) && /"email","whatsapp"/.test(json));
    const searchOr = q.$and[q.$and.length - 1].$or;
    check('a phone search matches the last ten digits',
        searchOr.some((c) => c.recipient && c.recipient.source === '9940100000$'),
        searchOr.map((c) => String(Object.values(c)[0])).join(' '));
    check('failed includes legacy failed rows', /"status":"failed"/.test(json) && /"deliveryStatus":"failed"/.test(json));
    const range = q.$and.find((c) => c.createdAt);
    check('date range is IST days, inclusive', range && range.createdAt.$gte.toISOString() === '2026-09-25T18:30:00.000Z'
        && range.createdAt.$lt.toISOString() === '2026-09-30T18:30:00.000Z');
    const s = deliveryQuery.summarise([
        { channel: 'email', status: 'failed', lastError: 'Invalid login: 535', createdAt: new Date('2026-09-29') },
        { channel: 'whatsapp', status: 'sent', deliveryStatus: 'delivered', createdAt: new Date('2026-09-29') }
    ]);
    check('summary shows the SMTP reason', s.email.status === 'failed' && /535/.test(s.email.reason));
    check('summary shows WhatsApp delivered', s.whatsapp.status === 'delivered');
};

/* ================================================ 5. the public API address */

const testPublicUrl = () => {
    section('Instamojo webhook address');
    const saved = { b: config.backendUrl, f: config.frontendUrl, p: process.env.PUBLIC_API_URL };
    try {
        delete process.env.PUBLIC_API_URL;
        publicUrl._reset();
        config.backendUrl = 'http://localhost:5000';
        config.frontendUrl = 'https://activ.org.in';
        check('local BACKEND_URL + public site → the site\'s /api/v1',
            publicUrl.instamojoWebhookUrl() === 'https://activ.org.in/api/v1/webhook/instamojo', publicUrl.instamojoWebhookUrl());
        config.frontendUrl = 'http://localhost:3000';
        check('all local → local dev keeps working', publicUrl.instamojoWebhookUrl() === 'http://localhost:5000/api/v1/webhook/instamojo');
        process.env.PUBLIC_API_URL = 'https://activ.org.in/api/v1/';
        check('PUBLIC_API_URL wins', publicUrl.instamojoWebhookUrl() === 'https://activ.org.in/api/v1/webhook/instamojo');
        check('media hangs off the public origin', publicUrl.publicOrigin() === 'https://activ.org.in');
    } finally {
        config.backendUrl = saved.b; config.frontendUrl = saved.f;
        if (saved.p === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = saved.p;
        publicUrl._reset();
    }
};

(async() => {
    try {
        testRealInfoOnly();
        await testExactlyOnce();
        await testDeliveryStatus();
        testQuery();
        testPublicUrl();
    } catch (error) {
        failed++;
        failures.push(`crashed: ${error && error.stack}`);
        console.log(error);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
    process.exit(0);
})();
