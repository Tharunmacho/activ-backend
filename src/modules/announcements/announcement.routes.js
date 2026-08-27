const express = require('express');
const controller = require('./announcement.controller');
const upload = require('../../core/middleware/upload');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

/**
 * The admin listing sits ABOVE `/:id`.
 *
 * Express matches in declaration order, so registered the other way round
 * `/announcements/admin` is read as an id, fails `isValid`, and answers 400
 * "Invalid announcement id" — the same trap `product.routes.js` documents for
 * `/discover` and `/stats`.
 */
router.get('/admin', requireRole('super_admin'), controller.listForAdmin);

// Read: any signed-in member. The service applies the region and paid-audience
// rules — the client never gets to ask for someone else's feed.
router.get('/', controller.listForMember);
router.get('/:id', controller.getForMember);

// Write: super admin only.
router.post('/', requireRole('super_admin'), upload.single('banner'), controller.create);
router.put('/:id', requireRole('super_admin'), upload.single('banner'), controller.update);
router.patch('/:id/status', requireRole('super_admin'), controller.setStatus);
router.delete('/:id', requireRole('super_admin'), controller.remove);

module.exports = router;
