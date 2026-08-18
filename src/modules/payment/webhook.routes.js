const express = require('express');
const paymentService = require('../payment/payment.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const logger = require('../../config/logger');

const router = express.Router();

/**
 * POST /api/v1/webhook/instamojo
 * Webhook endpoint for Instamojo payment notifications
 * Public endpoint (no authentication required)
 */
router.post('/instamojo', asyncHandler(async(req, res) => {
    const webhookData = req.body;

    logger.info('Received Instamojo webhook', {
        paymentId: webhookData.payment_id,
        status: webhookData.payment_status,
        buyer: webhookData.buyer
    });

    try {
        const result = await paymentService.processPaymentWebhook(webhookData);

        // Always return 200 to Instamojo to acknowledge receipt
        res.status(200).json(ApiResponse.success(result, 'Webhook processed successfully'));
    } catch (error) {
        logger.error('Webhook processing error', {
            error: error.message,
            paymentId: webhookData.payment_id
        });

        // Still return 200 to prevent retry storms
        res.status(200).json(ApiResponse.error('Webhook processing failed', 500));
    }
}));

module.exports = router;