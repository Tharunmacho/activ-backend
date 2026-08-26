const express = require('express');
const mongoose = require('mongoose');
const paymentService = require('./payment.service');
const notificationService = require('../notifications/notification.service');
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

    /**
     * Buyer details come from the member's profile, not from the token.
     *
     * The JWT payload is only { userId, email, role, block, district, state } —
     * it has never carried `fullName` or `phoneNumber`. Reading them off
     * `req.user` therefore yielded `undefined` every time: the buyer name
     * silently degraded to the email address and the phone was always empty,
     * while the request below asks Instamojo to send an SMS. That is a payment
     * that cannot complete, and nothing in the response said why.
     */
    const MemberDetails = require('../members/memberdetails.model');
    const profile = await MemberDetails.findOne({
        $or: [
            ...(mongoose.Types.ObjectId.isValid(user.userId) ? [{ _id: user.userId }] : []),
            { email: String(user.email || '').toLowerCase() }
        ]
    }).catch(() => null);

    const buyerName = (profile && profile.fullName) || user.email;
    const buyerEmail = (profile && profile.email) || user.email;
    const buyerPhone = (profile && profile.phoneNumber) || '';

    if (!buyerPhone) {
        // Failing here is kinder than letting the gateway reject it: the member
        // is told exactly what to fix, and no orphaned payment request exists.
        return res.status(400).json(ApiResponse.error(
            'A mobile number is required before paying. Please add one to your profile and try again.'
        ));
    }

    const paymentData = {
        amount: amount,
        purpose: purpose || `ACTIV Membership - ${membershipType}`,
        buyerName,
        email: buyerEmail,
        phone: buyerPhone,
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
    // The token claim is `userId`. `id` / `_id` are not in the payload, so this
    // was always undefined and the lookup only ever succeeded through the email
    // branch of the $or below — and `{ _id: undefined }` matches the first
    // document in the collection on some driver paths, which is worse than
    // failing. An invalid id is now left out of the query entirely.
    const userId = req.user.userId;
    const { paymentId, paymentMethod, transactionId, status, membershipType } = req.body;

    const MemberDetails = require('../members/memberdetails.model');

    const conditions = [];
    if (mongoose.Types.ObjectId.isValid(userId)) conditions.push({ _id: userId });
    if (req.user.email) conditions.push({ email: String(req.user.email).toLowerCase() });

    if (conditions.length === 0) {
        return res.status(400).json(ApiResponse.error('Could not identify the account to activate', 400));
    }

    const updatedMember = await MemberDetails.findOneAndUpdate(
        { $or: conditions },
        {
            membershipStatus: 'approved',
            membershipType: membershipType || 'annual',
            membershipActivatedAt: new Date(),
            paymentId: paymentId || transactionId || `TXN_${Date.now()}`,
            lastPaymentDate: new Date()
        },
        { new: true }
    );

    if (!updatedMember) {
        return res.status(404).json(ApiResponse.error('Member profile not found', 404));
    }

    // Non-fatal: a notification failure must never make a completed payment
    // look like it failed.
    await notificationService.safeCreate(updatedMember._id, {
        title: 'Membership activated',
        message: 'Your payment was received and your ACTIV membership is now active.',
        type: 'success',
        data: { event: 'membership.activated', membershipType: updatedMember.membershipType }
    });

    res.json(ApiResponse.success(updatedMember, 'Payment completed and membership activated'));
}));

module.exports = router;