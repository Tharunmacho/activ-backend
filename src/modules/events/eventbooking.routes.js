const express = require('express');
const bookingService = require('./eventbooking.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { optionalAuth } = require('../../core/middleware/auth');
const { createRateLimiter } = require('../../core/middleware/rateLimit');
const logger = require('../../config/logger');

const router = express.Router();

/**
 * "Book Now" — the public half of event bookings.
 *
 * ========================================================================
 * THIS ROUTER IS UNAUTHENTICATED ON PURPOSE, AND WHERE IT IS MOUNTED MATTERS
 * ========================================================================
 *
 * `event.routes.js` opens with `router.use(verifyToken)`, so every route in it
 * requires a signed-in member. That is right for a member's own seat and wrong
 * for the thing the client asked for: a guest books without an account and is
 * offered one afterwards. So the guest paths live here instead of being carved
 * out of that router with per-route exceptions, where the next person adding a
 * route under the blanket `verifyToken` would not notice they had closed the
 * guest door.
 *
 * It MUST be mounted above `businessRoutes` in `routes.js`. That router is
 * mounted at '/' and calls `router.use(verifyToken)` inside itself, which makes
 * it a catch-all auth gate for everything registered after it — the same trap
 * `/regions` carries a note about, and with the same symptom: every booking
 * request answers 401 and the page looks broken with nothing to explain it.
 *
 * ------------------------------------------------------------- optionalAuth
 *
 * `optionalAuth`, not `verifyToken`: a signed-in member booking through the
 * same form should have their booking attached to their account, and a guest
 * must not be turned away. It populates `req.user` when a valid token is
 * present and continues silently when there is none.
 *
 * ------------------------------------------------------------- rate limiting
 *
 * `POST /:eventId` writes a row on an anonymous request, which is the one shape
 * that has to be rate limited. Reads are limited more loosely — a booking page
 * legitimately polls its own seat count.
 */

/** Writes: enough for a person filling a form in, not enough to script. */
const writeLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'Too many booking attempts. Please wait a few minutes and try again.'
});

/** Reads: a page load is several of these. */
const readLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 300 });

/**
 * The member behind the request, or `null` for a guest.
 *
 * `null` and not `{}`: the service branches on `!context` to decide `isGuest`,
 * and an empty object is truthy — every guest booking would be filed as a
 * member booking with no member on it.
 *
 * `resolveMemberContext` READS THE DATABASE, and that is the point rather than
 * overhead. It carries `isPaid`, the member's region and whether they are an
 * admin, and `event.service.getEvent` needs all three to decide whether this
 * person may see a members-only or region-targeted event. Built from the token
 * alone it would be missing exactly the fields the decision turns on —
 * `memberContext` has its own note on why membership status cannot come from a
 * token: it changes during that token's lifetime.
 */
const callerOrNull = async(req) => {
    const user = req.user;
    if (!user || !(user.userId || user.id || user._id)) return null;

    const { resolveMemberContext } = require('../common/memberContext');
    const context = await resolveMemberContext(req).catch(() => null);

    return {
        ...(context || {}),
        id: String(user.userId || user.id || user._id),
        email: (context && context.email) || user.email || '',
        fullName: (context && context.fullName) || user.fullName || '',
        phoneNumber: (context && context.phoneNumber) || user.phoneNumber || ''
    };
};

/**
 * GET /api/v1/event-bookings/event/:eventId
 * The event as the booking page needs it — price, seats left, venue, deadline.
 *
 * `/event/:eventId` rather than `/:eventId` so it cannot be confused with a
 * booking reference on the route below. Two parameter routes at the same depth
 * are matched in declaration order, and a reference that happened to be 24 hex
 * characters would be read as an event id.
 */
router.get('/event/:eventId', readLimiter, optionalAuth, asyncHandler(async(req, res) => {
    /*
     * `optionalAuth` here as well as on the POST.
     *
     * Without it this read applied the guest rule to everybody, so a signed-in
     * member opening the booking page for a region-targeted event — one that is
     * deliberately NOT on the public site — got "Event not found" on a page
     * they had just navigated to from their own events list. The booking then
     * could not even be attempted, because the page never loaded.
     */
    const data = await bookingService.getBookableEvent(req.params.eventId, await callerOrNull(req));
    res.json(ApiResponse.success(data));
}));

/**
 * POST /api/v1/event-bookings/event/:eventId
 * Body: { name, email, phone, noOfPersons, participants: [{name,email,phone}], note? }
 *
 * NO AMOUNT IS ACCEPTED. The unit price comes off the event and the total is
 * this server's multiplication — see the head of `eventbooking.service`.
 */
router.post('/event/:eventId', writeLimiter, optionalAuth, asyncHandler(async(req, res) => {
    const booking = await bookingService.createBooking(
        req.params.eventId,
        req.body || {},
        await callerOrNull(req),
        {
            // Kept for the abuse case only. An open endpoint that writes rows
            // needs something to look at, and an IP alone identifies very little.
            source: String(req.headers['user-agent'] || 'web').slice(0, 200)
        }
    );

    logger.info('Public event booking taken', {
        bookingRef: booking.bookingRef,
        eventId: String(req.params.eventId),
        seats: booking.noOfPersons,
        guest: booking.isGuest
    });

    res.status(201).json(ApiResponse.created(
        booking,
        booking.payment.status === 'not_required'
            ? 'Your booking is confirmed'
            : 'Booking held — complete the payment to confirm it'
    ));
}));

/**
 * GET /api/v1/event-bookings/:bookingRef
 *
 * The reference IS the credential, and that is a deliberate trade rather than
 * an oversight. A guest has no account, so a booking they cannot reach again is
 * a receipt they lose the moment they close the tab. The reference is
 * server-generated and unguessable, and what it discloses is one booking's own
 * details to somebody holding its reference — which is what a printed ticket
 * discloses to whoever is holding it.
 */
router.get('/:bookingRef', readLimiter, asyncHandler(async(req, res) => {
    const booking = await bookingService.getBooking(req.params.bookingRef);
    res.json(ApiResponse.success(booking));
}));

/**
 * POST /api/v1/event-bookings/:bookingRef/authorize
 *
 * Stands in for the gateway until a real one is connected: the server signs its
 * own booking and hands back the two values a gateway would return. Refused
 * unless `PAYMENT_MODE=mock`, and never in production.
 *
 * This is the single route a real integration deletes.
 */
router.post('/:bookingRef/authorize', writeLimiter, asyncHandler(async(req, res) => {
    const result = await bookingService.authorizeMock(req.params.bookingRef);
    res.json(ApiResponse.success(result, 'Mock payment authorised — no money was taken'));
}));

/**
 * POST /api/v1/event-bookings/:bookingRef/pay
 * Body: { gatewayPaymentId, signature, mode? }
 *
 * Verifies the signature against the amount stored on the booking and confirms
 * the seats. Nothing in the request decides what was charged.
 */
router.post('/:bookingRef/pay', writeLimiter, asyncHandler(async(req, res) => {
    const body = req.body || {};
    const booking = await bookingService.completePayment(req.params.bookingRef, {
        gatewayPaymentId: body.gatewayPaymentId,
        signature: body.signature,
        mode: body.mode
    });

    res.json(ApiResponse.success(booking, 'Payment received — your booking is confirmed'));
}));

module.exports = router;
