const express = require('express');
const paymentService = require('./payment.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken } = require('../../core/middleware/auth');

const router = express.Router();

/**
 * POST /api/v1/payment/create-request
 * Create a new payment request
 * Requires authentication
 */
router.post('/create-request', verifyToken, asyncHandler(async(req, res) => {
    const { amount, purpose, membershipType } = req.body;
    const user = req.user;

    // Validate amount based on membership type
    const validAmounts = {
        starter: 500,
        intermediate: 1000,
        advanced: 2000,
        lifetime: 2500,
        aspirant: 500
    };

    if (!validAmounts[membershipType]) {
        return res.status(400).json(ApiResponse.error('Invalid membership type'));
    }

    if (parseFloat(amount) !== validAmounts[membershipType]) {
        return res.status(400).json(ApiResponse.error('Invalid amount for selected membership type'));
    }

    const paymentData = {
        amount: amount,
        purpose: purpose || `ACTIV Membership - ${membershipType}`,
        buyerName: user.fullName || user.email,
        email: user.email,
        phone: user.phoneNumber || '',
        redirectUrl: `${process.env.FRONTEND_URL}/payment-success`,
        webhookUrl: `${process.env.BACKEND_URL}/api/v1/webhook/instamojo`
    };

    const result = await paymentService.createPaymentRequest(paymentData);

    res.status(201).json(ApiResponse.created(result, 'Payment request created'));
}));

/**
 * GET /api/v1/payment/status/:paymentRequestId
 * Check payment status
 * Requires authentication
 */
router.get('/status/:paymentRequestId', verifyToken, asyncHandler(async(req, res) => {
    const { paymentRequestId } = req.params;

    const result = await paymentService.checkPaymentStatus(paymentRequestId);

    res.json(ApiResponse.success(result));
}));

/**
 * POST /api/v1/payment/renew
 * Renew membership manually (admin use)
 * Requires authentication
 */
router.post('/renew', verifyToken, asyncHandler(async(req, res) => {
    const { memberId, amount } = req.body;

    const result = await paymentService.renewMembership(memberId, amount);

    res.json(ApiResponse.success(result, 'Membership renewed successfully'));
}));

/**
 * POST /api/v1/payment/complete
 * Record payment completion and update membershipStatus to approved
 */
router.post('/complete', verifyToken, asyncHandler(async(req, res) => {
    const userId = req.user.id || req.user._id;
    const { paymentId, paymentMethod, transactionId, status, membershipType } = req.body;

    const MemberDetails = require('../members/memberdetails.model');
    const updatedMember = await MemberDetails.findOneAndUpdate(
        { $or: [{ _id: userId }, { email: req.user.email.toLowerCase() }] },
        {
            membershipStatus: 'approved',
            membershipType: membershipType || 'annual',
            membershipActivatedAt: new Date(),
            paymentId: paymentId || transactionId || `TXN_${Date.now()}`,
            lastPaymentDate: new Date()
        },
        { new: true }
    );

    res.json(ApiResponse.success(updatedMember, 'Payment completed and membership activated'));
}));

module.exports = router;