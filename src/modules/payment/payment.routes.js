const express = require('express');
const mongoose = require('mongoose');
const paymentService = require('./payment.service');
const orderService = require('./paymentOrder.service');
const { listPlans } = require('./membershipPlans');
const notificationService = require('../notifications/notification.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken, requireRole } = require('../../core/middleware/auth');
const logger = require('../../config/logger');

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
router.post('/renew', verifyToken, requireRole('super_admin'), asyncHandler(async(req, res) => {
    /*
     * Admin-only, and it was not.
     *
     * The comment above has always said "admin use", but the route was gated on
     * `verifyToken` alone: any signed-in member could rename someone else in the
     * `memberId` field and grant them a membership at an `amount` they chose —
     * including themselves. It is the same hole as the old `/complete`, reached
     * a different way.
     *
     * A member paying for their own renewal goes through `/payment/order` like
     * any other purchase. This route is only for an administrator recording a
     * payment taken outside the system.
     */
    const { memberId, amount } = req.body || {};

    const result = await paymentService.renewMembership(memberId, amount);

    logger.warn('Membership renewed manually by an admin', {
        memberId,
        amount,
        adminId: req.user && (req.user.userId || req.user.id)
    });

    res.json(ApiResponse.success(result, 'Membership renewed successfully'));
}));

/**
 * GET /api/v1/payment/plans
 * The plans and their prices, as the server holds them.
 * Public: a client needs them to render the picker, and they are not secret —
 * what matters is that the client cannot *change* them.
 */
router.get('/plans', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success({
        plans: listPlans(),
        mockMode: orderService.isMockMode()
    }));
}));

/**
 * POST /api/v1/payment/order
 * Begin a payment. Body: { planId, applicationId? }
 *
 * The amount is NOT accepted from the caller — it is looked up from the plan.
 */
router.post('/order', verifyToken, asyncHandler(async(req, res) => {
    const order = await orderService.createOrder(req.user, {
        planId: req.body && req.body.planId,
        applicationId: req.body && req.body.applicationId
    });
    res.status(201).json(ApiResponse.created(order, 'Payment order created'));
}));

/**
 * GET /api/v1/payment/order/:orderId
 * The caller's own order. Another member's returns 403.
 */
router.get('/order/:orderId', verifyToken, asyncHandler(async(req, res) => {
    const order = await orderService.getOrder(req.user, req.params.orderId);
    res.json(ApiResponse.success(order));
}));

/**
 * POST /api/v1/payment/mock-authorize
 * Body: { orderId }
 *
 * Stands in for the gateway until a real one is connected: the server signs its
 * own order and hands back the three values a gateway would return. Refused
 * unless `PAYMENT_MODE=mock`, and never available in production.
 *
 * This is the single route that a real integration deletes.
 */
router.post('/mock-authorize', verifyToken, asyncHandler(async(req, res) => {
    const result = await orderService.authorizeMock(req.user, {
        orderId: req.body && req.body.orderId
    });
    res.json(ApiResponse.success(result, 'Mock payment authorised — no money was taken'));
}));

/**
 * POST /api/v1/payment/complete
 * Body: { orderId, gatewayPaymentId, signature, paymentMethod? }
 *
 * Verify a payment and activate the membership.
 *
 * This route used to accept `{ paymentId, paymentMethod, transactionId, status }`
 * and trust all of it. None of those fields was checked against anything —
 * there was nothing to check them against — so an authenticated request with an
 * **empty body** set `membershipStatus` to `approved`. Any member who could sign
 * in could grant themselves a paid membership without a card.
 *
 * It now requires a server-created order, refuses one that is not the caller's,
 * refuses one that has already been paid, and verifies an HMAC signature over
 * `orderId|gatewayPaymentId` before writing anything. The amount recorded comes
 * from the order rather than from the request.
 */
router.post('/complete', verifyToken, asyncHandler(async(req, res) => {
    const body = req.body || {};

    const { order, member } = await orderService.completePayment(req.user, {
        orderId: body.orderId,
        gatewayPaymentId: body.gatewayPaymentId,
        signature: body.signature,
        paymentMethod: body.paymentMethod
    });

    // Non-fatal: a notification failure must never make a completed payment
    // look like it failed.
    await notificationService.safeCreate(member._id, {
        title: 'Membership activated',
        message: 'Your payment was received and your ACTIV membership is now active.',
        type: 'success',
        data: {
            event: 'membership.activated',
            membershipType: member.membershipType,
            orderId: order.orderId
        }
    });

    res.json(ApiResponse.success(member, 'Payment verified and membership activated'));
}));


module.exports = router;