const express = require('express');
const donationService = require('./donation.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken, requireRole } = require('../../core/middleware/auth');
const { createRateLimiter } = require('../../core/middleware/rateLimit');

/**
 * PUBLIC donation routes — a donor has no account. Mounted at /donations
 * ABOVE `businessRoutes` in routes.js (its catch-all verifyToken would 401
 * every one of these otherwise).
 */
const publicRouter = express.Router();
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const readLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 300 });

publicRouter.post('/', writeLimiter, asyncHandler(async(req, res) => {
    const result = await donationService.create(req.body || {}, { origin: req.headers.origin });
    res.status(201).json(ApiResponse.created(result, 'Donation started'));
}));

publicRouter.post('/mock-complete/:orderId', writeLimiter, asyncHandler(async(req, res) => {
    const result = await donationService.mockComplete(req.params.orderId);
    res.json(ApiResponse.success(result, 'Test donation completed — no money was taken'));
}));

publicRouter.get('/return/:orderId', readLimiter, asyncHandler(async(req, res) => {
    const result = await donationService.resolveReturn(req.params.orderId, {
        paymentId: String(req.query.payment_id || '').slice(0, 100),
        gatewayStatus: String(req.query.payment_status || '').slice(0, 30)
    });
    res.json(ApiResponse.success(result));
}));

publicRouter.get('/receipt/:token', readLimiter, asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.receipt(req.params.token)));
}));

publicRouter.get('/statement/:token', readLimiter, asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.statement(req.params.token, String(req.query.fy || ''))));
}));

/**
 * SUPER ADMIN — every donor and every donation. Mounted at
 * /admin/super/donations.
 */
const adminRouter = express.Router();
adminRouter.use(verifyToken, requireRole('super_admin'));

adminRouter.get('/summary', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.summary(String(req.query.fy || ''))));
}));

adminRouter.get('/donors', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.listDonors(req.query || {})));
}));

adminRouter.get('/donors/:id', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.getDonor(req.params.id)));
}));

adminRouter.get('/', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.listDonations(req.query || {})));
}));

adminRouter.post('/:id/resend', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await donationService.resend(req.params.id), 'Receipt sent'));
}));

module.exports = { publicRouter, adminRouter };
