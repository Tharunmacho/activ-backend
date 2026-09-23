const express = require('express');
const controller = require('./event.controller');
const upload = require('../../core/middleware/upload');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

/**
 * Literal paths first.
 *
 * `/my-registrations` registered after `/:id` is read as an event id, fails the
 * ObjectId check and answers 400 — the same ordering trap `product.routes.js`
 * documents for `/discover` and `/stats`.
 */
router.get('/my-registrations', controller.myRegistrations);

/*
 * The audience preview, also a literal path and also above `/:id`.
 *
 * Super admin only: it counts members by region, which is a question only the
 * person choosing the region has any business asking.
 */
router.get('/reach', requireRole('super_admin'), controller.reach);

/*
 * The Booking Events landing table — every event, and how full it is.
 *
 * A LITERAL PATH, and it sits here for the ordering reason this file already
 * gives twice: registered after `/:id` it is read as the event id "bookings"
 * and answers 400 on a screen that would simply look broken.
 */
router.get('/bookings/overview', requireRole('super_admin'), controller.bookingOverview);

/*
 * The contact book: everyone who has booked anything, and one person's history.
 *
 * Literal paths, above `/:id`, for the third time in this file. `/person` is
 * declared beside `/people` rather than as `/people/:email` — an email address
 * in a path segment is a fight with every proxy that thinks `.com` is a file
 * extension, so the address travels as a query parameter.
 */
router.get('/bookings/people', requireRole('super_admin'), controller.listBookingPeople);
router.get('/bookings/person', requireRole('super_admin'), controller.getBookingPerson);

/*
 * CATEGORIES — the chips an event is filed under.
 *
 * Reading is open to any signed-in user because the EVENT FORM needs the list
 * to offer it, and every admin tier can open an event. Writing is super admin
 * only: the same list drives the filter chips on the public events page, so
 * renaming one changes what a visitor sees.
 *
 * `/categories` before `/:id`, again.
 */
router.get('/categories', controller.listCategories);
router.post('/categories', requireRole('super_admin'), controller.addCategory);
router.post('/categories/standard', requireRole('super_admin'), controller.addStandardCategories);
router.put('/categories/:categoryId', requireRole('super_admin'), controller.renameCategory);
router.post('/categories/:categoryId/move', requireRole('super_admin'), controller.reorderCategory);
router.delete('/categories/:categoryId', requireRole('super_admin'), controller.deleteCategory);

// Read: any signed-in user. The controller hides drafts from non-admins and the
// service hides members-only events from members who have not paid.
router.get('/', controller.listEvents);
router.get('/:id', controller.getEvent);

// Registration: the member acts on their own seat, always. There is no
// "register this other person" — the seat is taken from the token.
router.post('/:id/register', controller.register);
// Paying for that seat is a second step, not a flag on the first: a seat can be
// held now and paid for later, and a payment can fail and be retried.
router.post('/:id/register/pay', controller.payRegistration);
router.delete('/:id/register', controller.cancelRegistration);

// The attendee list is the organiser's, not the attendees'.
router.get('/:id/registrations', requireRole('super_admin'), controller.listRegistrations);

/*
 * The BOOKING list — the guest "Book Now" flow's other end.
 *
 * Behind this router's blanket `verifyToken` and super-admin gated, unlike the
 * public booking endpoints in `eventbooking.routes.js`. Taking a booking is a
 * thing a stranger does; reading everybody's name, email, mobile and what they
 * paid is not.
 *
 * `/bookings/:ref` is registered AFTER `/bookings` for the ordering reason this
 * file already documents twice, and `:ref` is a booking reference rather than
 * an id — `/:id/bookings/:ref` cannot collide with anything above it because
 * the literal `bookings` segment sits between the two parameters.
 */
router.get('/:id/bookings', requireRole('super_admin'), controller.listBookings);
/*
 * The spreadsheet, and the door list.
 *
 * BOTH ARE DECLARED ABOVE `/:id/bookings/:ref`. `export` and `attendees` are
 * literals at the same depth as that parameter, and Express matches in
 * declaration order — registered after it, "export" is read as a booking
 * reference and the download answers "booking not found".
 */
router.get('/:id/bookings/export', requireRole('super_admin'), controller.exportBookings);
router.get('/:id/attendees', requireRole('super_admin'), controller.listAttendees);
router.get('/:id/bookings/:ref', requireRole('super_admin'), controller.getBooking);
router.post('/:id/bookings/:ref/record-payment', requireRole('super_admin'), controller.recordBookingPayment);
router.post('/:id/bookings/:ref/cancel', requireRole('super_admin'), controller.cancelBooking);

// Write: super admin only.
router.post('/', requireRole('super_admin'), upload.single('banner'), controller.createEvent);
router.put('/:id', requireRole('super_admin'), upload.single('banner'), controller.updateEvent);
router.patch('/:id/status', requireRole('super_admin'), controller.setStatus);
router.delete('/:id', requireRole('super_admin'), controller.deleteEvent);

module.exports = router;
