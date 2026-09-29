const express = require('express');
const { verifyToken, requireRole } = require('../../core/middleware/auth');
const platinum = require('./platinum.controller');

/**
 * A member asking for Platinum. Mounted at `/membership/platinum` in routes.js,
 * ABOVE `businessRoutes` (the catch-all auth gate — see CLAUDE.md).
 */
const router = express.Router();

router.get('/request', verifyToken, requireRole('member'), platinum.myRequest);
router.post('/request', verifyToken, requireRole('member'), platinum.createRequest);

module.exports = router;
