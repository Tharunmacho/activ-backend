const eventService = require('./event.service');
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
    myRegistrations
};
