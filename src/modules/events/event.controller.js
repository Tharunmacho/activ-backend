const eventService = require('./event.service');
const bookingService = require('./eventbooking.service');
const categoryService = require('./eventcategory.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { resolveMemberContext } = require('../common/memberContext');

/**
 * Who is asking.
 *
 * This replaces the `canSeeDrafts(req)` boolean the controller used to compute
 * from `req.user.role`. Drafts were the only gate then; there are two now, and
 * the second one — the members-only audience — cannot be answered from the
 * token at all, because membership status changes during a token's lifetime.
 * `resolveMemberContext` reads both from the database. See its own note.
 */
const listEvents = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await eventService.listEvents(req.query || {}, context);
    res.json(ApiResponse.success(data));
});

const myRegistrations = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await eventService.myRegistrations(context);
    res.json(ApiResponse.success(data));
});

const getEvent = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await eventService.getEvent(req.params.id, context);
    res.json(ApiResponse.success(data));
});

/** Multer puts an uploaded banner on req.file; a plain JSON body may send a URL. */
const bodyWithBanner = (req) => {
    if (req.file && req.file.filename) {
        return { ...req.body, bannerUrl: '/uploads/' + req.file.filename };
    }
    return req.body || {};
};

const createEvent = asyncHandler(async(req, res) => {
    const data = await eventService.createEvent(bodyWithBanner(req), req.user || {});
    res.status(201).json(ApiResponse.created(data, 'Event created'));
});

const updateEvent = asyncHandler(async(req, res) => {
    const data = await eventService.updateEvent(req.params.id, bodyWithBanner(req));
    res.json(ApiResponse.success(data, 'Event updated'));
});

const setStatus = asyncHandler(async(req, res) => {
    const data = await eventService.setStatus(req.params.id, (req.body || {}).status, req.user || {});
    res.json(ApiResponse.success(data, 'Event ' + data.status));
});

const deleteEvent = asyncHandler(async(req, res) => {
    const data = await eventService.deleteEvent(req.params.id, req.user || {});
    res.json(ApiResponse.success(data, 'Event deleted'));
});

/**
 * Who this targeting would actually reach. Super admin only — see the route.
 *
 * A GET with the target list in the query string so the editor can call it on
 * every change without a body: it is a preview, not a write.
 */
const reach = asyncHandler(async(req, res) => {
    const data = await eventService.reach({
        targets: req.query.targets,
        audience: req.query.audience
    });
    res.json(ApiResponse.success(data));
});

const register = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await eventService.register(req.params.id, context, req.body || {});

    /*
     * The message has to say what actually happened, and there are now four
     * outcomes rather than three. "Registered" on a seat that is still awaiting
     * payment is the one wording that could cost a member their place: they
     * would close the tab believing they were done.
     */
    const awaitingPayment = data.payment && data.payment.status === 'pending';

    const message = data.alreadyRegistered
        ? 'You are already registered'
        : awaitingPayment
            ? 'Seat held — complete the payment to confirm it'
            : data.status === 'waitlist'
                ? 'Added to the waiting list'
                : 'Registered';

    res.status(data.alreadyRegistered ? 200 : 201).json(ApiResponse.success(data, message));
});

/**
 * Settle the fee on a held seat.
 *
 * The dummy gateway's completion step. Its own route because paying is its own
 * action — see `EventService.payRegistration`.
 */
const payRegistration = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await eventService.payRegistration(req.params.id, context, req.body || {});
    res.json(ApiResponse.success(
        data,
        data.alreadyPaid ? 'This seat is already paid for' : 'Payment received — your seat is confirmed'
    ));
});

const cancelRegistration = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await eventService.cancelRegistration(req.params.id, context);
    res.json(ApiResponse.success(data, 'Registration cancelled'));
});

const listRegistrations = asyncHandler(async(req, res) => {
    const data = await eventService.listRegistrations(req.params.id, req.query || {});
    res.json(ApiResponse.success(data));
});

/* ------------------------------------------------------- public bookings */

/**
 * The organiser's booking list — the counterpart of the guest "Book Now" flow.
 *
 * A SECOND LIST BESIDE `listRegistrations`, NOT A REPLACEMENT. A registration
 * is one member's own seat; a booking is one person paying for several
 * participants and may have no member behind it at all. They are different
 * collections for the reasons `eventbooking.model` sets out, and merging them
 * into one endpoint would mean inventing a row shape that is neither.
 */
const listBookings = asyncHandler(async(req, res) => {
    const data = await bookingService.listBookings(req.params.id, req.query || {});
    res.json(ApiResponse.success(data));
});

/** One booking in full, for the "View Booking Details" panel. */
const getBooking = asyncHandler(async(req, res) => {
    const data = await bookingService.getBooking(req.params.ref);
    res.json(ApiResponse.success(data));
});

/**
 * Record money taken outside the gateway — cash at the door.
 *
 * The acting admin's identity is taken from the TOKEN, never from the body. A
 * `recordedBy` a client can choose is a name anybody can put against anybody
 * else's takings.
 */
const recordBookingPayment = asyncHandler(async(req, res) => {
    const user = req.user || {};
    const data = await bookingService.recordOfflinePayment(req.params.ref, {
        mode: (req.body || {}).mode,
        recordedBy: user.email || String(user.userId || user.id || '')
    });
    res.json(ApiResponse.success(data, 'Payment recorded'));
});

const cancelBooking = asyncHandler(async(req, res) => {
    const data = await bookingService.cancelBooking(req.params.ref, {
        reason: (req.body || {}).reason
    });
    res.json(ApiResponse.success(data, 'Booking cancelled'));
});

/* ==================================================== the organiser's overview */

/**
 * Every event with its seat figures — the Booking Events landing table.
 *
 * A LITERAL PATH, mounted above `/:id`. `/events/bookings/overview` registered
 * after the parameter route is read as the event id "bookings", fails the
 * ObjectId check and answers 400 — the trap this router already documents for
 * `/my-registrations` and `/reach`.
 */
const bookingOverview = asyncHandler(async(req, res) => {
    const data = await bookingService.bookingOverview(req.query || {});
    res.json(ApiResponse.success(data));
});

/** One row per PERSON in the room, rather than per booking. */
const listAttendees = asyncHandler(async(req, res) => {
    const data = await bookingService.listAttendees(req.params.id, req.query || {});
    res.json(ApiResponse.success(data));
});

/**
 * The bookings of one event as a CSV download.
 *
 * Sent as a FILE rather than inside an `ApiResponse` envelope: the browser
 * follows this link directly and a JSON wrapper would download a file whose
 * first line is `{"success":true,"data":{"csv":"...`. The two headers are what
 * make it save rather than render.
 */
const exportBookings = asyncHandler(async(req, res) => {
    const { filename, csv } = await bookingService.exportBookingsCsv(req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

/* ==================================================== the contact book */

/**
 * Everyone who has ever booked, across every event.
 *
 * NO CREDENTIAL IS READ OR RETURNED by this handler or the service behind it.
 * It replaces a screen that printed passwords in a column, and the omission is
 * deliberate rather than an oversight — see the note on `listBookingPeople`.
 */
const listBookingPeople = asyncHandler(async(req, res) => {
    const data = await bookingService.listBookingPeople(req.query || {});
    res.json(ApiResponse.success(data));
});

/**
 * One person's whole booking history.
 *
 * The address arrives as a QUERY PARAMETER, not as a path segment. An email
 * address carries dots and a `@`, and Express reads a trailing `.com` in a path
 * as part of the segment only until something in front of the app — a proxy, a
 * CDN — decides it is a file extension. A query parameter is escaped once by the
 * client and read once here.
 */
const getBookingPerson = asyncHandler(async(req, res) => {
    const data = await bookingService.getBookingPerson((req.query || {}).email);
    res.json(ApiResponse.success(data));
});

/* ============================================================ categories */

const listCategories = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await categoryService.listCategories()));
});

const addCategory = asyncHandler(async(req, res) => {
    const data = await categoryService.addCategory(req.body || {}, req.user || {});
    res.status(201).json(ApiResponse.created(data, 'Category added'));
});

const renameCategory = asyncHandler(async(req, res) => {
    const data = await categoryService.renameCategory(req.params.categoryId, req.body || {}, req.user || {});
    res.json(ApiResponse.success(
        data,
        // The count of re-stamped events is the half of this an editor cannot
        // see for themselves, so it goes in the message rather than only in the
        // payload.
        data.moved
            ? `Renamed, and moved ${data.moved} event${data.moved === 1 ? '' : 's'} onto it`
            : 'Category renamed'
    ));
});

const deleteCategory = asyncHandler(async(req, res) => {
    const data = await categoryService.deleteCategory(req.params.categoryId, req.user || {});
    res.json(ApiResponse.success(data, 'Category removed'));
});

const reorderCategory = asyncHandler(async(req, res) => {
    const data = await categoryService.reorderCategory(
        req.params.categoryId, (req.body || {}).direction, req.user || {}
    );
    res.json(ApiResponse.success(data, 'Order saved'));
});

const addStandardCategories = asyncHandler(async(req, res) => {
    const data = await categoryService.addStandard(req.user || {});
    res.json(ApiResponse.success(
        data,
        data.added.length
            ? `Added ${data.added.length} categor${data.added.length === 1 ? 'y' : 'ies'}`
            : 'Every standard category is already listed'
    ));
});

module.exports = {
    listEvents,
    getEvent,
    createEvent,
    updateEvent,
    setStatus,
    deleteEvent,
    reach,
    register,
    payRegistration,
    cancelRegistration,
    listRegistrations,
    myRegistrations,
    listBookings,
    getBooking,
    recordBookingPayment,
    cancelBooking,
    bookingOverview,
    listBookingPeople,
    getBookingPerson,
    listAttendees,
    exportBookings,
    listCategories,
    addCategory,
    renameCategory,
    deleteCategory,
    reorderCategory,
    addStandardCategories
};
