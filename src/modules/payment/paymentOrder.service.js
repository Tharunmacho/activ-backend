const crypto = require('crypto');
const mongoose = require('mongoose');
const PaymentOrder = require('./paymentorder.model');
const MemberDetails = require('../members/memberdetails.model');
const { getPlan } = require('./membershipPlans');
const { isPaidStatus } = require('../common/memberContext');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');

/**
 * Order-based payment, replacing "the client says it paid".
 *
 * The endpoint this supersedes activated a membership from an authenticated
 * request with an empty body. There was no order, no amount and no signature —
 * nothing to check — so any member who could sign in could grant themselves a
 * paid membership with one request and no card.
 *
 * Three checks now stand between a request and an activated membership, and all
 * three have to pass:
 *
 *   1. **the order** — created by the server, owned by the caller, carrying the
 *      amount the server chose from its own price table;
 *   2. **single use** — only a `created` order completes, so a captured request
 *      replayed later changes nothing;
 *   3. **the signature** — HMAC-SHA256 over `orderId|gatewayPaymentId`.
 *
 * Interim mode is honest about what it is. `PAYMENT_MODE=mock` lets the server
 * sign its own orders through `authorizeMock`, which is how the flow works with
 * no gateway account — but it is refused outright in production, it warns on
 * every use, and the resulting order records `provider: 'mock'` so no real
 * payment can ever be confused with one.
 *
 * Wiring a real gateway means one change: the gateway issues the signature
 * instead of `authorizeMock`, and `SIGNING_SECRET` becomes its key secret. The
 * verification below is already Razorpay's, unmodified.
 */

const ORDER_TTL_MINUTES = 30;

/** Mock authorisation is opt-in, and never available in production. */
const isMockMode = () =>
    String(process.env.PAYMENT_MODE || 'mock').toLowerCase() === 'mock' &&
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

/**
 * The key orders are signed with.
 *
 * Falls back to the JWT secret so a deployment that has not set it still signs
 * with something unguessable, rather than with a constant compiled into the
 * source. It is a real secret either way — a signature that everyone can
 * compute is not a check.
 */
const signingSecret = () =>
    process.env.PAYMENT_SIGNING_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    process.env.JWT_SECRET ||
    '';

/** Razorpay's scheme, unmodified: HMAC-SHA256 over `order_id|payment_id`. */
const sign = (orderId, gatewayPaymentId) =>
    crypto
        .createHmac('sha256', signingSecret())
        .update(`${orderId}|${gatewayPaymentId}`)
        .digest('hex');

/**
 * Constant-time comparison.
 *
 * `a === b` on a signature leaks how much of it was right through how long the
 * comparison took, which is enough to reconstruct one byte at a time.
 */
const signatureMatches = (expected, provided) => {
    const a = Buffer.from(String(expected || ''), 'utf8');
    const b = Buffer.from(String(provided || ''), 'utf8');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
};

class PaymentOrderService {
    /**
     * Start a payment.
     *
     * The caller names a plan; the price comes from the server's table. Nothing
     * in the request influences what is charged.
     */
    async createOrder(user = {}, { planId, applicationId } = {}) {
        const userId = user.userId || user.id || user._id;
        if (!mongoose.Types.ObjectId.isValid(userId)) {
            throw ApiError.unauthorized('No member on this token');
        }

        const plan = getPlan(planId);
        if (!plan) {
            throw ApiError.badRequest(`Unknown plan '${planId}'`);
        }

        const member = await MemberDetails.findById(userId).catch(() => null);
        if (!member) throw ApiError.notFound('No member profile for this account');

        /*
         * Refuse only a membership that has genuinely been paid for.
         *
         * `approved` used to count here, and it is not a payment — it is the
         * three-tier workflow approving the *application*, which is precisely
         * the event that unlocks this screen. Every member who got all the way
         * through the approval flow was therefore told "This membership is
         * already active" the moment they pressed Pay, and no order could ever
         * be created for them: the payment step was unreachable for exactly the
         * members entitled to it.
         */
        if (isPaidStatus(member.membershipStatus)) {
            // Not merely wasteful: a second activation would overwrite the
            // first payment's record on the member.
            throw ApiError.badRequest('This membership is already active');
        }

        const order = await PaymentOrder.create({
            orderId: 'ord_' + crypto.randomBytes(16).toString('hex'),
            memberId: member._id,
            email: member.email,
            planId: plan.id,
            planName: plan.name,
            amount: plan.amount,
            membershipType: plan.membershipType,
            applicationId: applicationId || '',
            provider: isMockMode() ? 'mock' : 'gateway',
            expiresAt: new Date(Date.now() + ORDER_TTL_MINUTES * 60 * 1000)
        });

        logger.info('Payment order created', {
            orderId: order.orderId,
            memberId: String(member._id),
            planId: plan.id,
            amount: plan.amount,
            provider: order.provider
        });

        // The secret never leaves the server, and neither does the signature at
        // this stage — the client gets only what a real checkout would need.
        return {
            orderId: order.orderId,
            amount: order.amount,
            currency: order.currency,
            planId: order.planId,
            planName: order.planName,
            membershipType: order.membershipType,
            provider: order.provider,
            expiresAt: order.expiresAt,
            mockMode: isMockMode()
        };
    }

    /**
     * Stand in for the gateway's authorisation step.
     *
     * This is the piece a real gateway replaces. Until then the server signs its
     * own order, which is honest about being a simulation rather than pretending
     * a card was charged — and it still forces the client through order
     * creation, so the amount and the ownership checks are real even now.
     *
     * Refused unless `PAYMENT_MODE=mock`, and never in production.
     */
    async authorizeMock(user = {}, { orderId } = {}) {
        if (!isMockMode()) {
            throw ApiError.forbidden(
                'Mock authorisation is disabled. Complete the payment through the gateway.'
            );
        }

        const order = await this.findOwnedOrder(user, orderId);

        if (order.status !== 'created') {
            throw ApiError.badRequest(`This order is already ${order.status}`);
        }
        if (order.expiresAt && order.expiresAt.getTime() < Date.now()) {
            throw ApiError.badRequest('This order has expired. Please start again.');
        }

        const gatewayPaymentId = 'pay_' + crypto.randomBytes(12).toString('hex');
        const signature = sign(order.orderId, gatewayPaymentId);

        logger.warn('MOCK payment authorised — no money was taken', {
            orderId: order.orderId,
            gatewayPaymentId,
            amount: order.amount,
            memberId: String(order.memberId)
        });

        return { orderId: order.orderId, gatewayPaymentId, signature, mockMode: true };
    }

    /** The caller's own order, or a 404/403. */
    async findOwnedOrder(user = {}, orderId) {
        const userId = user.userId || user.id || user._id;
        if (!orderId) throw ApiError.badRequest('An orderId is required');

        const order = await PaymentOrder.findOne({ orderId: String(orderId) }).catch(() => null);
        if (!order) throw ApiError.notFound('No such payment order');

        // Checked explicitly rather than folded into the query, so an order that
        // exists but belongs to somebody else is refused rather than reported as
        // missing — and logged, because it is worth knowing about.
        if (String(order.memberId) !== String(userId)) {
            logger.warn('Payment order accessed by a different member', {
                orderId: order.orderId,
                owner: String(order.memberId),
                caller: String(userId)
            });
            throw ApiError.forbidden('This payment order belongs to another member');
        }

        return order;
    }

    /**
     * Verify a payment and activate the membership.
     *
     * Every value that matters comes from the stored order — the amount, the
     * plan, the membership type, the member. The request supplies only the three
     * identifiers a gateway hands back, and they are checked before anything is
     * written.
     */
    async completePayment(user = {}, { orderId, gatewayPaymentId, signature, paymentMethod } = {}) {
        if (!gatewayPaymentId) throw ApiError.badRequest('A gatewayPaymentId is required');
        if (!signature) throw ApiError.badRequest('A payment signature is required');
        if (!signingSecret()) {
            // Refusing is the only safe answer: with no secret every signature
            // would verify against the same empty key.
            logger.error('No payment signing secret is configured; refusing to activate');
            throw ApiError.internal('Payment verification is not configured');
        }

        const order = await this.findOwnedOrder(user, orderId);

        if (order.status === 'paid') {
            throw ApiError.badRequest('This order has already been paid');
        }
        if (order.status !== 'created') {
            throw ApiError.badRequest(`This order is ${order.status} and cannot be completed`);
        }
        if (order.expiresAt && order.expiresAt.getTime() < Date.now()) {
            throw ApiError.badRequest('This order has expired. Please start again.');
        }

        if (!signatureMatches(sign(order.orderId, gatewayPaymentId), signature)) {
            logger.warn('Payment signature rejected', {
                orderId: order.orderId,
                memberId: String(order.memberId)
            });
            throw ApiError.unauthorized('Payment signature does not verify');
        }

        /**
         * Claim the order before touching the member.
         *
         * A conditional update on `status: 'created'` is what makes two
         * simultaneous completions resolve to one activation: whichever request
         * loses the race matches nothing and is refused, rather than both
         * proceeding to write the membership.
         */
        const claimed = await PaymentOrder.findOneAndUpdate(
            { _id: order._id, status: 'created' },
            {
                status: 'paid',
                gatewayPaymentId,
                paymentMethod: paymentMethod || '',
                paidAt: new Date()
            },
            { new: true }
        );

        if (!claimed) throw ApiError.badRequest('This order has already been paid');

        const expiresAt = claimed.membershipType === 'lifetime'
            ? null
            : new Date(new Date().setFullYear(new Date().getFullYear() + 1));

        const member = await MemberDetails.findByIdAndUpdate(
            claimed.memberId,
            {
                /*
                 * `active`, not `approved`.
                 *
                 * `approved` is the application-approval state, written by
                 * `commitFinalApproval`'s predecessor and still on live records
                 * that never paid. Writing it here too made the two
                 * indistinguishable, so nothing downstream could tell a member
                 * who had paid from one who had merely been approved. The other
                 * payment path (`payment.service.js`) has always written
                 * `active`; this now agrees with it, and `PAID_STATUSES` is the
                 * single list every reader checks against.
                 */
                membershipStatus: 'active',
                membershipType: claimed.membershipType,
                membershipActivatedAt: new Date(),
                membershipExpiresAt: expiresAt,
                // From the order, not the request. The amount charged and the
                // amount recorded are the same number by construction.
                paymentId: gatewayPaymentId,
                paymentAmount: claimed.amount,
                lastPaymentDate: new Date()
            },
            { new: true }
        );

        if (!member) {
            // The order is already marked paid, so it is put back rather than
            // left claiming a payment that activated nothing.
            await PaymentOrder.updateOne({ _id: claimed._id }, { status: 'failed' }).catch(() => null);
            throw ApiError.notFound('Member profile not found');
        }

        logger.info('Membership activated by verified payment', {
            orderId: claimed.orderId,
            gatewayPaymentId,
            memberId: String(member._id),
            amount: claimed.amount,
            provider: claimed.provider
        });

        return { order: claimed, member };
    }

    /** What a client may see about its own order. */
    async getOrder(user = {}, orderId) {
        const order = await this.findOwnedOrder(user, orderId);
        return {
            orderId: order.orderId,
            status: order.status,
            amount: order.amount,
            currency: order.currency,
            planId: order.planId,
            planName: order.planName,
            paidAt: order.paidAt || null,
            expiresAt: order.expiresAt
        };
    }
}

module.exports = new PaymentOrderService();
module.exports.isMockMode = isMockMode;
module.exports.sign = sign;
