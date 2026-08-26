const express = require('express');
const controller = require('./audit.controller');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

// Read-only by design. The log is append-only: entries are written by
// audit.service from inside the actions themselves, never over HTTP, and no
// route updates or deletes one.
router.get('/', requireRole('super_admin'), controller.listAudit);
router.get('/counts', requireRole('super_admin'), controller.auditCounts);

module.exports = router;
