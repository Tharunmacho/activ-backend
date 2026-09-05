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

// Write: super admin only.
router.post('/', requireRole('super_admin'), upload.single('banner'), controller.createEvent);
router.put('/:id', requireRole('super_admin'), upload.single('banner'), controller.updateEvent);
router.patch('/:id/status', requireRole('super_admin'), controller.setStatus);
router.delete('/:id', requireRole('super_admin'), controller.deleteEvent);

module.exports = router;
