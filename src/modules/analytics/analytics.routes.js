const express = require('express');
const analyticsService = require('./analytics.service');
const memberAnalyticsService = require('./memberAnalytics.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

/**
 * A member's own operational analytics (BUS-003).
 *
 * MUST stay above the `requireRole` line below, which is a router-level gate
 * for everything registered after it: mounted lower down this answers 403 to
 * every member, which is the entire audience for it. It needs no role check of
 * its own because it is scoped to the caller's own id — there is no parameter
 * that could point it at anyone else's catalogue.
 */
router.get('/me', asyncHandler(async(req, res) => {
    const userId = String((req.user || {}).userId || (req.user || {}).id || '');
    const data = await memberAnalyticsService.overview(userId, req.query.days);
    res.json(ApiResponse.success(data));
}));

router.use(requireRole('district_admin', 'state_admin', 'super_admin'));

router.get('/user-growth', asyncHandler(async(req, res) => {
    const { period = '30d' } = req.query;
    const data = await analyticsService.getUserGrowth(period);
    res.json(ApiResponse.success(data));
}));

router.get('/applications', asyncHandler(async(req, res) => {
    const data = await analyticsService.getApplicationStats();
    res.json(ApiResponse.success(data));
}));

router.get('/members', asyncHandler(async(req, res) => {
    const data = await analyticsService.getMemberStats();
    res.json(ApiResponse.success(data));
}));

module.exports = router;