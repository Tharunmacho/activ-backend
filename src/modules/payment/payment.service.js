const axios = require('axios');
const crypto = require('crypto');
const config = require('../../config');
const MemberDetails = require('../members/memberdetails.model');
const membershipPlanService = require('../members/membershipplan.service');
const notificationService = require('../notifications/notification.service');
/* The member context caches `isPaid`; every activation below tells it. */
const { invalidateMemberContext } = require('../common/memberContext');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

/**
 * Tell a member their membership went live, on every channel they can be
 * reached on.
 *
 * THIS PATH ACTIVATED MEMBERSHIPS SILENTLY. `processPaymentWebhook` and
 * `renewMembership` both write `membershipStatus: 'active'` and both ended at a
 * `// TODO: Send notification to member`. A member who paid through Instamojo —
 * which is the route the mobile app uses — or whose renewal an admin recorded by
 * hand got the paid dashboard and no message at all, while a member paying the
 * same fee through the website got a bell entry, an email and a WhatsApp
 * message. Same event, same collection, two different experiences, decided by
 * which client they happened to use.
 *
 * `dispatchInBackground` cannot throw and is not awaited: the money has already
 * moved by the time this runs, and a mail host that is down must not turn a
 * completed payment into a webhook failure Instamojo then retries.
 */
const announceActivation = (member, { amount, orderId } = {}) => {
    if (!member) return;

    const rupees = Number(amount || member.paymentAmount || 0);

    notificationService.dispatchInBackground('MEMBERSHIP_ACTIVATED', {
        id: member._id,
        name: member.fullName,
        email: member.email,
        phone: member.phoneNumber,
        whatsapp: member.whatsappNumber,
        state: member.state,
        district: member.district,
        block: member.block
    }, {
        // Derived exactly as `member.controller` derives it for the dashboard —
        // the field itself is not on the schema. See the note in payment.routes.
        membershipNumber: member.membershipNumber
            || String(member._id || '').slice(-8).toUpperCase(),
        membershipType: member.membershipType,
        amountLabel: Number.isFinite(rupees) && rupees > 0
            ? `₹${rupees.toLocaleString('en-IN')}`
            : '',
        orderId: orderId || member.paymentId || '',
        data: { membershipType: member.membershipType, orderId: orderId || '' }
    });
};

/**
 * ============================================================================
 * INSTAMOJO API v1.1 — AND IT MUST BE v1.1
 * ============================================================================
 *
 * This called `https://api.instamojo.com/v2/payment-requests/` with the
 * `X-Api-Key` / `X-Auth-Token` headers. Those are two different APIs mixed
 * together, and the result never worked:
 *
 *   POST /v2/payment-requests/   -> 404 "no Route matched with those values"
 *   POST /v2/payment_requests/   -> 401, and wants an OAuth2 Bearer token
 *   POST /api/1.1/payment-requests/ with the key+token -> 200
 *
 * v2 uses an underscore in the path AND OAuth2 (client id/secret exchanged for
 * a bearer token), which this code never obtained. v1.1 uses the key/token
 * header pair, which is exactly what the account is configured with — verified
 * against the live account, which answered 200 and listed its requests. So the
 * credentials were never the problem; the URL and the auth scheme were.
 *
 * TWO MORE THINGS v1.1 NEEDS that v2 does not, and both fail silently-ish:
 *
 *   - The request body is FORM-ENCODED, not JSON. v1.1 answers a JSON body
 *     with a 400 whose message names the fields as missing, which reads like
 *     a bug in the caller's data rather than in its Content-Type.
 *   - `allow_repeated_payments` must be a STRING ("False"), because a form
 *     body has no booleans. Sent as a real `false` it serialises to the string
 *     "false", which Instamojo's parser treats as truthy — leaving the link
 *     reusable after it has been paid, which is somebody paying twice.
 */
class PaymentService {
    constructor() {
        this.apiKey = config.instamojo.apiKey;
        this.authToken = config.instamojo.authToken;
        this.privateSalt = config.instamojo.privateSalt;
        this.baseUrl = config.instamojo.baseUrl || 'https://www.instamojo.com/api/1.1';
    }

    /** Is there an account to talk to at all? */
    isConfigured() {
        return !!(this.apiKey && this.authToken);
    }

    /** The two headers every v1.1 call carries. */
    authHeaders() {
        return { 'X-Api-Key': this.apiKey, 'X-Auth-Token': this.authToken };
    }

    /**
     * Create payment request on Instamojo
     * @param {Object} paymentData - Payment details
     * @returns {Promise<Object>} Payment request details
     */
    async createPaymentRequest(paymentData) {
        try {
            const { amount, purpose, buyerName, email, phone, redirectUrl, webhookUrl } = paymentData;

            if (!this.isConfigured()) {
                throw ApiError.badRequest('The payment gateway is not configured.');
            }

            /*
             * `purpose` is capped, and the cap is NOT the 30 characters the
             * older docs give: a 45-character purpose was accepted by this
             * account, and the account already holds a 32-character one. 45 is
             * what was actually tested, so 45 is what is trusted — a tighter
             * guess would silently truncate "ACTIV Membership - startup-company"
             * to something an editor never wrote, on every receipt.
             */
            const shortPurpose = String(purpose || 'ACTIV').trim().slice(0, 45);

            /*
             * =============================================================
             * INSTAMOJO VALIDATES THE NUMBER AGAINST REAL INDIAN RANGES
             * =============================================================
             *
             * Not a regex. `+919876543210` and `9999999999` are both rejected
             * with "Enter a valid phone number" even though both are ten
             * digits starting 6-9 — they are not numbers a carrier has been
             * assigned. `+918056127890` is accepted.
             *
             * Two consequences. A real member's number is fine, so this is
             * not a problem in practice; and a TEST number is not, so anybody
             * debugging this with 9999999999 will conclude the integration is
             * broken when it is the number that is wrong.
             *
             * The number is normalised to `+91XXXXXXXXXX`, which is the shape
             * every request on the account is stored in. A blank phone is sent
             * as no field at all rather than as an empty one: Instamojo accepts
             * a request with no `phone` key and rejects one with an empty
             * value, and the difference is a member who cannot pay.
             */
            const digits = String(phone || '').replace(/\D/g, '');
            const national = digits.length > 10 ? digits.slice(-10) : digits;
            const normalisedPhone = national.length === 10 ? `+91${national}` : '';

            /*
             * Form-encoded, and every value a string — see the note above the
             * class. `URLSearchParams` is what makes axios send
             * `application/x-www-form-urlencoded` without the header being set
             * by hand, so the two cannot drift apart.
             */
            const body = new URLSearchParams({
                amount: Number(amount).toFixed(2),
                purpose: shortPurpose,
                buyer_name: String(buyerName || '').slice(0, 100),
                email: String(email || ''),
                /* Omitted entirely when there is none — see above. */
                ...(normalisedPhone ? { phone: normalisedPhone } : {}),
                redirect_url: redirectUrl || `${config.frontendUrl}/payment-success`,
                webhook: webhookUrl || `${config.backendUrl}/api/v1/webhook/instamojo`,
                send_email: 'True',
                send_sms: 'True',
                /* "False" as a STRING — see the note above the class. */
                allow_repeated_payments: 'False'
            });

            logger.info('Creating Instamojo payment request', {
                email,
                amount,
                purpose: shortPurpose
            });

            const response = await axios.post(
                `${this.baseUrl}/payment-requests/`,
                body.toString(),
                {
                    headers: {
                        ...this.authHeaders(),
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    timeout: 20000
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
                status: error.response ? error.response.status : null,
                response: error.response ? error.response.data : null
            });

            /*
             * SAY WHICH FIELD, because Instamojo already told us.
             *
             * This threw a flat "Failed to create payment request" and dropped
             * the body, so the two most likely real failures —
             *
             *     {"phone":["Enter a valid phone number"]}
             *     {"amount":["Amount cannot be less than INR 9.00."]}
             *
             * — reached the member as the same unactionable sentence, and
             * reached the log only because the log kept the body. A member
             * whose profile number is wrong can fix it the moment they are
             * told; they cannot guess it.
             *
             * `message` on a v1.1 error is an OBJECT of field -> [messages],
             * not a string. Flattened here, capped, and nothing else from the
             * gateway response is passed through.
             */
            const detail = error.response && error.response.data && error.response.data.message;
            const fields = detail && typeof detail === 'object'
                ? Object.keys(detail)
                    .map((key) => `${key}: ${[].concat(detail[key]).join(' ')}`)
                    .join('; ')
                    .slice(0, 300)
                : (typeof detail === 'string' ? detail.slice(0, 300) : '');

            throw ApiError.badRequest(
                fields
                    ? `The payment could not be started — ${fields}`
                    : 'The payment could not be started. Please try again.'
            );
        }
    }

    /**
     * Verify webhook signature from Instamojo
     * @param {Object} webhookData - Webhook payload
     * @returns {Boolean} Verification status
     */
    /*
     * =====================================================================
     * EVERY POSTED FIELD, SORTED BY KEY — not a chosen five
     * =====================================================================
     *
     * This built the string from five named fields:
     *
     *     [payment_id, payment_request_id, payment_status, buyer, amount]
     *
     * Instamojo does not compute it that way. The MAC is HMAC-SHA1, keyed on
     * the private salt, over EVERY field in the POST except `mac` itself,
     * sorted by field NAME, values joined with "|". A webhook carries around
     * twenty fields, so the five-field string could never match — meaning
     * every genuine webhook this server ever received was rejected as
     * "Invalid webhook signature", and no membership was ever activated by
     * one. The gateway's URL being wrong meant no webhook ever arrived to
     * expose it.
     *
     * Two details that look like nothing and are not:
     *
     *   - The sort is over the KEYS and the join is over their VALUES. Sorting
     *     the values instead produces a plausible-looking string that never
     *     verifies.
     *   - `timingSafeEqual`, not `===`. A MAC compared with `===` leaks how
     *     much of a guess was right through how long the comparison took, and
     *     this MAC is the only thing standing between a forged POST and an
     *     activated membership. Lengths are checked first because
     *     `timingSafeEqual` throws on a mismatch.
     */
    verifyWebhookSignature(webhookData) {
        try {
            const received = String((webhookData || {}).mac || '');
            if (!received || !this.privateSalt) return false;

            const message = Object.keys(webhookData)
                .filter((key) => key !== 'mac')
                .sort()
                .map((key) => String(webhookData[key] ?? ''))
                .join('|');

            const calculated = crypto
                .createHmac('sha1', this.privateSalt)
                .update(message)
                .digest('hex');

            const a = Buffer.from(calculated, 'utf8');
            const b = Buffer.from(received, 'utf8');
            const isValid = a.length === b.length && crypto.timingSafeEqual(a, b);

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

            // Look up the order we created before sending the user to Instamojo
            const PaymentOrder = require('./paymentorder.model');
            const order = await PaymentOrder.findOne({ gatewayPaymentId: webhookData.payment_request_id });

            if (!order) {
                logger.error('No matching order found for Instamojo payment', { payment_request_id: webhookData.payment_request_id });
                throw ApiError.notFound('Matching order not found');
            }

            if (order.status === 'paid') {
                return { success: true, message: 'Already processed' };
            }

            const paidAmount = parseFloat(amount);

            if (order.orderType === 'event_booking') {
                const booking = await this.settleEventBookingOrder(order, payment_id);
                return {
                    success: true,
                    message: 'Event booking paid successfully',
                    booking
                };
            } else {
                // MEMBERSHIP LOGIC
                if (!(paidAmount > 0)) {
                    throw ApiError.badRequest('Invalid payment amount');
                }

                const paidPlan = await membershipPlanService.resolveByAmount(paidAmount)
                    .catch(() => null);

                const membershipType = paidPlan?.membershipType || 'annual';
                let membershipExpiresAt = null;

                if (membershipType !== 'lifetime') {
                    membershipExpiresAt = new Date();
                    membershipExpiresAt.setFullYear(membershipExpiresAt.getFullYear() + 1);
                }

                const member = await MemberDetails.findOneAndUpdate({ email: buyer.toLowerCase() }, {
                    membershipStatus: 'active',
                    membershipType: membershipType,
                    membershipActivatedAt: new Date(),
                    membershipExpiresAt: membershipExpiresAt,
                    paymentId: payment_id,
                    paymentAmount: paidAmount,
                    lastPaymentDate: new Date()
                }, { new: true });

                invalidateMemberContext(member?._id);

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

                announceActivation(member, { amount: paidAmount, orderId: payment_id });

                // Mark order as paid
                order.status = 'paid';
                order.gatewayPaymentId = payment_id; 
                order.paidAt = new Date();
                order.paymentMethod = 'instamojo';
                await order.save();

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
            }
        } catch (error) {
            logger.error('Payment webhook processing failed', {
                error: error.message,
                paymentId: webhookData.payment_id
            });
            throw error;
        }
    }

    /**
     * Confirm an event booking whose payment has been VERIFIED — by the
     * webhook's MAC, or by asking Instamojo directly (`verifyPaymentWithGateway`).
     *
     * Idempotent, because both paths can arrive for the same payment and in
     * either order: the webhook and the buyer's browser leave Instamojo at the
     * same moment. Whichever loses finds the booking already paid and answers
     * with it rather than failing. `completePayment` claims the booking with a
     * conditional update, so the seats are confirmed and the confirmation
     * email / WhatsApp goes out exactly once.
     */
    async settleEventBookingOrder(order, paymentId) {
        const eventBookingService = require('../events/eventbooking.service');

        let booking;
        try {
            booking = await eventBookingService.completePayment(order.bookingRef, {
                gatewayPaymentId: paymentId,
                signature: 'instamojo_webhook_verified', // verified by the caller, see above
                mode: 'online'
            });
        } catch (error) {
            // Already paid by the other path: that is success, not failure.
            booking = await eventBookingService.getBooking(order.bookingRef).catch(() => null);
            if (!booking || !booking.payment || booking.payment.status !== 'paid') throw error;
        }

        if (order.status !== 'paid') {
            order.status = 'paid';
            order.gatewayPaymentId = paymentId || order.gatewayPaymentId;
            order.paidAt = new Date();
            order.paymentMethod = 'instamojo';
            await order.save();
        }

        return booking;
    }

    /**
     * Ask INSTAMOJO whether a payment request has been paid.
     *
     * The payment request id comes from OUR stored order, never from the
     * browser — so what is being verified is the order this server created,
     * and a query string cannot point it at somebody else's payment. Returns
     * `{ paid, paymentId }`; any error answers `paid: false` and the caller
     * keeps waiting for the webhook.
     */
    async verifyPaymentWithGateway(paymentRequestId, paymentId = '', expectedAmount = 0) {
        if (!paymentRequestId || !this.isConfigured()) return { paid: false };

        const amountOk = (value) => !(expectedAmount > 0) || parseFloat(value) + 0.001 >= Number(expectedAmount);

        try {
            if (paymentId) {
                const res = await axios.get(
                    `${this.baseUrl}/payment-requests/${encodeURIComponent(paymentRequestId)}/${encodeURIComponent(paymentId)}/`,
                    { headers: this.authHeaders(), timeout: 20000 }
                );
                const payment = res.data && res.data.payment_request && res.data.payment_request.payment;
                if (payment && String(payment.status).toLowerCase() === 'credit' && amountOk(payment.amount)) {
                    return { paid: true, paymentId: payment.payment_id || paymentId };
                }
            }

            const res = await axios.get(
                `${this.baseUrl}/payment-requests/${encodeURIComponent(paymentRequestId)}/`,
                { headers: this.authHeaders(), timeout: 20000 }
            );
            const request = (res.data && res.data.payment_request) || {};
            const payments = Array.isArray(request.payments) ? request.payments : [];
            const credited = payments.find((p) => p && typeof p === 'object'
                && String(p.status).toLowerCase() === 'credit' && amountOk(p.amount));
            if (credited) return { paid: true, paymentId: credited.payment_id || paymentId };
            if (String(request.status).toLowerCase() === 'completed' && amountOk(request.amount)) {
                const first = payments[0];
                return { paid: true, paymentId: (typeof first === 'string' ? first : first && first.payment_id) || paymentId };
            }
        } catch (error) {
            logger.warn('Instamojo payment verification failed', {
                paymentRequestId, error: error && error.message
            });
        }
        return { paid: false };
    }

    /**
     * Where the buyer lands after Instamojo — `GET /payment/return/:orderId`.
     *
     * PUBLIC, because a GUEST pays for seats and has no token. What it reveals
     * is the order's own state and booking reference, to whoever holds the
     * random 32-hex order id that was only ever in that buyer's return URL.
     *
     * If the order is an unpaid event booking it asks Instamojo directly, and
     * confirms the booking when Instamojo says the money is credited. So the
     * booking — and its email / WhatsApp — no longer waits on the webhook
     * reaching this server, which on a local or mis-configured deployment it
     * never did: the seats sat unpaid until an admin confirmed them by hand.
     */
    async resolveReturn(orderId, { paymentId = '', gatewayStatus = '' } = {}) {
        const PaymentOrder = require('./paymentorder.model');
        const order = await PaymentOrder.findOne({ orderId: String(orderId || '') }).catch(() => null);
        if (!order) throw ApiError.notFound('No such payment order');

        if (order.orderType === 'event_booking' && order.status !== 'paid'
            && String(gatewayStatus).toLowerCase() !== 'failed') {
            const requestId = String(order.gatewayPaymentId || '');
            if (requestId && !requestId.startsWith('ord_')) {
                const verdict = await this.verifyPaymentWithGateway(requestId, paymentId, order.amount);
                if (verdict.paid) {
                    await this.settleEventBookingOrder(order, verdict.paymentId).catch((error) => {
                        logger.error('Verified event payment could not be settled', {
                            orderId: order.orderId, bookingRef: order.bookingRef, error: error && error.message
                        });
                    });
                }
            }
        }

        /*
         * THE ANSWER AFTER SETTLING, and the event from the BOOKING.
         *
         * `order` was read before the gateway check above, so the call that
         * confirmed the payment used to report it as still pending. And orders
         * written while the client supplied the event id have none, which left
         * the return page unable to open the booking ("still confirming"
         * forever, and a View-my-booking button pointing at a missing page).
         * The booking always knows its event, so it is asked.
         */
        const fresh = await PaymentOrder.findOne({ orderId: order.orderId }).lean().catch(() => null) || order;
        let eventId = fresh.eventId ? String(fresh.eventId) : '';
        let eventSlug = '';
        if (fresh.orderType === 'event_booking' && fresh.bookingRef) {
            const EventBooking = require('../events/eventbooking.model');
            const booking = await EventBooking.findOne({ bookingRef: fresh.bookingRef }).select('eventId').lean().catch(() => null);
            if (!eventId && booking && booking.eventId) eventId = String(booking.eventId);
            if (eventId) {
                const Event = require('../events/event.model');
                const ev = await Event.findById(eventId).select('slug').lean().catch(() => null);
                eventSlug = (ev && ev.slug) || '';
            }
        }

        return {
            orderId: fresh.orderId,
            orderType: fresh.orderType || 'membership',
            status: fresh.status,
            amount: fresh.amount,
            bookingRef: fresh.bookingRef || '',
            eventId,
            // The readable address to send the buyer to (events/eventSlug.js).
            eventSlug
        };
    }

    /**
     * Check payment status from Instamojo
     * @param {String} paymentRequestId - Payment request ID
     * @returns {Promise<Object>} Payment status
     */
    async checkPaymentStatus(paymentRequestId) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/payment-requests/${paymentRequestId}/`,
                { headers: this.authHeaders(), timeout: 20000 }
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

            /* The same lookup the activation path uses — see it for why the
               amount is not interpreted with a rule of thumb. */
            const paidAmount = parseFloat(amount);
            const paidPlan = paidAmount > 0
                ? await membershipPlanService.resolveByAmount(paidAmount).catch(() => null)
                : null;

            /*
             * A renewal that matches no current plan LEAVES THE MEMBER'S KIND
             * ALONE and extends them by a year. It is a renewal: what they hold
             * is already the right answer to "what kind of membership is this",
             * and the payment is about how long it runs.
             */
            const membershipType = paidPlan?.membershipType || member.membershipType || 'annual';
            let membershipExpiresAt = null;

            if (membershipType !== 'lifetime' && paidAmount > 0) {
                // Extend from current expiry or today, whichever is later.
                const baseDate = member.membershipExpiresAt && member.membershipExpiresAt > new Date() ?
                    member.membershipExpiresAt :
                    new Date();
                membershipExpiresAt = new Date(baseDate);
                membershipExpiresAt.setFullYear(membershipExpiresAt.getFullYear() + 1);
            }

            member.membershipStatus = 'active';
            invalidateMemberContext(member._id);

            // The one activity a member most expects to see recorded.
            try {
                const { recordActivity } = require('../members/memberExtras.controller');
                await recordActivity(member._id, 'membership_activated', 'Payment', member._id,
                    'Membership activated');
            } catch { /* a feed entry is never worth failing a payment over */ }
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

            // A renewal recorded by an admin is still the member's membership
            // going live, and it is the one they are least likely to have seen
            // happen — they were not at a checkout when it did.
            announceActivation(member, { amount: paidAmount });

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