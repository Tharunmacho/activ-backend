const express = require('express');
const controller = require('./region.controller');
const { publicLimiter } = require('../../core/middleware/rateLimit');

const router = express.Router();

/**
 * Public, read-only region discovery.
 *
 * Unauthenticated on purpose — the registration screen calls these before the
 * applicant has an account. Rate-limited because they are the only endpoints on
 * the API that anyone can reach without a token.
 */
router.get('/states', publicLimiter, controller.getStates);
router.get('/districts', publicLimiter, controller.getDistricts);
router.get('/blocks', publicLimiter, controller.getBlocks);
router.get('/tree', publicLimiter, controller.getTree);
router.get('/validate', publicLimiter, controller.validate);

// The canonical India reference, used by the super admin's state picker.
router.get('/geography', publicLimiter, controller.getGeography);

module.exports = router;
