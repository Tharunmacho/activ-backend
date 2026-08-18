const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const MemberDetails = require('../members/memberdetails.model');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

class PaymentService {
    constructor() {
        this.apiKey = config.instamojo.apiKey;
        this.authToken = config.instamojo.authToken;
        this.privateSalt = config.instamojo.privateSalt;
        this.baseUrl = config.instamojo.baseUrl || 'https://api.instamojo.com/v2';
    }

    /**
     * Create payment request on Instamojo
     * @param {Object} paymentData - Payment details
     * @returns {Promise<Object>} Payment request details
     */
    async createPaymentRequest(paymentData) {
        try {
            const { amount, purpose, buyerName, email, phone, redirectUrl, webhookUrl } = paymentData;

            const requestBody = {
                amount: parseFloat(amount),
                purpose: purpose,
                buyer_name: buyerName,
                email: email,
                phone: phone,
                redirect_url: redirectUrl || `${config.frontendUrl}/payment-success`,
                webhook: webhookUrl || `${config.backendUrl}/api/v1/webhook/instamojo`,
                send_email: true,
                send_sms: true,
                allow_repeated_payments: false
            };

            logger.info('Creating Instamojo payment request', {
                email,
                amount,
                purpose
            });

            const response = await axios.post(
                `${this.baseUrl}/payment-requests/`,
                requestBody, {
                    headers: {
                        'X-Api-Key': this.apiKey,
                        'X-Auth-Token': this.authToken,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.success) {
                logger.info('Payment request created successfully', {
                    paymentRequestId: response.data.payment_request.id,
                    email
                });

                return {
                    success: true,
                    payment_url: response.data.payment_request.longurl,
                    payment_request_id: response.data.payment_request.id,
                    status: response.data.payment_request.status
                };
            } else {
                throw new Error('Failed to create payment request');
            }
        } catch (error) {
            logger.error('Instamojo payment request failed', {
                error: error.message,
                response: error.response ? error.response.data : null
            });
            throw ApiError.badRequest('Failed to create payment request');
        }
    }

    /**
     * Verify webhook signature from Instamojo
     * @param {Object} webhookData - Webhook payload
     * @returns {Boolean} Verification status
     */
    verifyWebhookSignature(webhookData) {
        try {
            const receivedMac = webhookData.mac;

            // Build verification string as per Instamojo documentation
            const verificationString = [
                webhookData.payment_id,
                webhookData.payment_request_id,
                webhookData.payment_status,
                webhookData.buyer,
                webhookData.amount
            ].join('|');

            const calculatedMac = crypto
                .createHmac('sha1', this.privateSalt)
                .update(verificationString)
                .digest('hex');

            const isValid = calculatedMac === receivedMac;

            logger.info('Webhook signature verification', {
                paymentId: webhookData.payment_id,
                isValid
            });

            return isValid;
        } catch (error) {
            logger.error('Webhook signature verification failed', {
                error: error.message
            });
            return false;
        }
    }

    /**
     * Process payment webhook and activate membership
     * @param {Object} webhookData - Webhook payload from Instamojo
     * @returns {Promise<Object>} Processed result
     */
    async processPaymentWebhook(webhookData) {
        try {
            // Verify webhook signature
            if (!this.verifyWebhookSignature(webhookData)) {
                throw ApiError.unauthorized('Invalid webhook signature');
            }

            const { payment_id, payment_status, buyer, amount, buyer_name, buyer_phone } = webhookData;

            // Only process successful payments
            if (payment_status !== 'Credit') {
                logger.warn('Payment not successful', {
                    paymentId: payment_id,
                    status: payment_status
                });
                return {
                    success: false,
                    message: 'Payment not successful'
                };
            }

            logger.info('Processing successful payment', {
                paymentId: payment_id,
                email: buyer,
                amount: amount
            });

            // Determine membership type based on amount
            const paidAmount = parseFloat(amount);
            let membershipType = 'annual';
            let membershipExpiresAt = null;

            if (paidAmount >= 2500) {
                // Lifetime membership
                membershipType = 'lifetime';
                membershipExpiresAt = null;
            } else if (paidAmount >= 500) {
                // Annual membership (1 year from now)
                membershipType = 'annual';
                membershipExpiresAt = new Date();
                membershipExpiresAt.setFullYear(membershipExpiresAt.getFullYear() + 1);
            } else {
                throw ApiError.badRequest('Invalid payment amount');
            }

            // Find and update member details
            const member = await MemberDetails.findOneAndUpdate({ email: buyer.toLowerCase() }, {
                membershipStatus: 'active',
                membershipType: membershipType,
                membershipActivatedAt: new Date(),
                membershipExpiresAt: membershipExpiresAt,
                paymentId: payment_id,
                paymentAmount: paidAmount,
                lastPaymentDate: new Date()
            }, { new: true });

            if (!member) {
                logger.error('Member not found for payment', {
                    email: buyer,
                    paymentId: payment_id
                });
                throw ApiError.notFound('Member not found');
            }

            logger.info('Membership activated successfully', {
                memberId: member._id,
                email: buyer,
                membershipType,
                expiresAt: membershipExpiresAt
            });

            // TODO: Send confirmation email/SMS
            // TODO: Create activity log
            // TODO: Send notification to member

            return {
                success: true,
                message: 'Membership activated successfully',
                member: {
                    id: member._id,
                    fullName: member.fullName,
                    email: member.email,
                    membershipType,
                    membershipStatus: 'active',
                    activatedAt: member.membershipActivatedAt,
                    expiresAt: membershipExpiresAt
                }
            };
        } catch (error) {
            logger.error('Payment webhook processing failed', {
                error: error.message,
                paymentId: webhookData.payment_id
            });
            throw error;
        }
    }

    /**
     * Check payment status from Instamojo
     * @param {String} paymentRequestId - Payment request ID
     * @returns {Promise<Object>} Payment status
     */
    async checkPaymentStatus(paymentRequestId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/payment-requests/${paymentRequestId}/`, {
                    headers: {
                        'X-Api-Key': this.apiKey,
                        'X-Auth-Token': this.authToken
                    }
                }
            );

            if (response.data.success) {
                const paymentRequest = response.data.payment_request;
                return {
                    success: true,
                    status: paymentRequest.status,
                    payments: paymentRequest.payments || []
                };
            }

            throw new Error('Failed to fetch payment status');
        } catch (error) {
            logger.error('Payment status check failed', {
                error: error.message,
                paymentRequestId
            });
            throw ApiError.badRequest('Failed to check payment status');
        }
    }

    /**
     * Process manual membership renewal
     * @param {String} memberId - Member ID
     * @param {Number} amount - Payment amount
     * @returns {Promise<Object>} Updated member
     */
    async renewMembership(memberId, amount) {
        try {
            const member = await MemberDetails.findById(memberId);
            if (!member) {
                throw ApiError.notFound('Member not found');
            }

            const paidAmount = parseFloat(amount);
            let membershipType = member.membershipType;
            let membershipExpiresAt = null;

            if (paidAmount >= 2500) {
                membershipType = 'lifetime';
                membershipExpiresAt = null;
            } else if (paidAmount >= 500) {
                // Extend from current expiry or today
                const baseDate = member.membershipExpiresAt && member.membershipExpiresAt > new Date() ?
                    member.membershipExpiresAt :
                    new Date();
                membershipExpiresAt = new Date(baseDate);
                membershipExpiresAt.setFullYear(membershipExpiresAt.getFullYear() + 1);
            }

            member.membershipStatus = 'active';
            member.membershipType = membershipType;
            member.membershipExpiresAt = membershipExpiresAt;
            member.lastPaymentDate = new Date();
            member.paymentAmount = paidAmount;

            await member.save();

            logger.info('Membership renewed', {
                memberId,
                membershipType,
                expiresAt: membershipExpiresAt
            });

            return member;
        } catch (error) {
            logger.error('Membership renewal failed', {
                error: error.message,
                memberId
            });
            throw error;
        }
    }
}

module.exports = new PaymentService();