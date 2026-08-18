const express = require('express');
const analyticsService = require('./analytics.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);
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