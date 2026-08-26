const mongoose = require('mongoose');

/**
 * A payment the server has authorised the start of.
 *
 * Nothing like this existed, and its absence was the vulnerability.
 * `POST /payment/complete` took a client's word for everything: an
 * authenticated request with an **empty body** set `membershipStatus` to
 * `approved`. No amount was checked because none was sent; no transaction was
 * looked up because there was nowhere to look. Anyone who could sign in could
 * give themselves a paid membership with one request.
 *
 * The fix is the shape every real gateway uses. The server creates the order
 * first and stores the amount **it** decided, from its own price table; the
 * client can only ever refer back to that order by id. Completion then has
 * something to verify against, and three independent things have to hold:
 *
 *   1. the order exists and belongs to the caller,
 *   2. it is still `created` — an order is single-use, so a captured request
 *      cannot be replayed into a second membership,
 *   3. the signature over `orderId|gatewayPaymentId` verifies.
 *
 * This is deliberately Razorpay's contract (`razorpay_order_id`,
 * `razorpay_payment_id`, `razorpay_signature`, HMAC-SHA256 over
 * `order_id|payment_id`), so swapping the interim mock authorisation for a real
 * checkout is a change of who issues the signature — not a redesign.
 */
const paymentOrderSchema = new mongoose.Schema({
    /** Server-generated. The only handle a client ever gets. */
    orderId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    /** The MemberDetails `_id` the order was created for. */
    memberId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },

    /** The plan key, resolved server-side against the price table. */
    planId: {
        type: String,
        required: true,
        trim: true
    },
    planName: {
        type: String,
        trim: true,
        default: ''
    },

    /**
     * In rupees, decided by the server.
     *
     * Never read from the request. A client-supplied amount is a client-chosen
     * price, and the old endpoint accepted one implicitly by accepting none.
     */
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    currency: {
        type: String,
        default: 'INR'
    },

    /** 'annual' | 'lifetime', derived from the plan. */
    membershipType: {
        type: String,
        enum: ['annual', 'lifetime'],
        default: 'annual'
    },

    /**
     * `created` -> `paid`, or `created` -> `failed`.
     *
     * Only a `created` order can be completed. This is what makes an order
     * single-use and a replayed completion request a no-op.
     */
    status: {
        type: String,
        enum: ['created', 'paid', 'failed'],
        default: 'created',
        index: true
    },

    /** Which gateway issued it — 'mock' until a real one is wired in. */
    provider: {
        type: String,
        default: 'mock'
    },

    /** The gateway's own payment id, recorded on completion. */
    gatewayPaymentId: {
        type: String,
        trim: true,
        default: ''
    },
    /** 'card' | 'upi' | 'netbanking', as reported at completion. */
    paymentMethod: {
        type: String,
        trim: true,
        default: ''
    },

    /** The application this membership is for, when the client knows it. */
    applicationId: {
        type: String,
        trim: true,
        default: ''
    },

    paidAt: {
        type: Date
    },

    /**
     * Orders expire so an abandoned one cannot be completed weeks later, after
     * prices or eligibility have changed.
     */
    expiresAt: {
        type: Date,
        required: true
    }
}, {
    collection: 'payment orders',
    timestamps: true
});

paymentOrderSchema.index({ memberId: 1, status: 1 });
paymentOrderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PaymentOrder', paymentOrderSchema);
