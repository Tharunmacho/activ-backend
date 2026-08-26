const express = require('express');
const controller = require('./event.controller');
const upload = require('../../core/middleware/upload');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

// Read: any signed-in user. The controller hides drafts from non-admins.
router.get('/', controller.listEvents);
router.get('/:id', controller.getEvent);

// Write: super admin only.
router.post('/', requireRole('super_admin'), upload.single('banner'), controller.createEvent);
router.put('/:id', requireRole('super_admin'), upload.single('banner'), controller.updateEvent);
router.patch('/:id/status', requireRole('super_admin'), controller.setStatus);
router.delete('/:id', requireRole('super_admin'), controller.deleteEvent);

module.exports = router;
