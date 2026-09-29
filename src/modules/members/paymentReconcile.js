const PaymentOrder = require('../payment/paymentorder.model');
const logger = require('../../config/logger');

/**
 * A MEMBERSHIP IS ONLY AS PAID AS ITS PAYMENT.
 *
 * "Paid" is stored on the member (`membershipStatus: 'active'`), separately from
 * the payment itself (`payment orders`). Deleting or cancelling the payment in
 * the database therefore left the member on the paid dashboard with a live
 * membership nobody had paid for. The association's rule: remove the payment and
 * the member starts again — unpaid, on the unpaid dashboard, and must pay.
 *
 * This checks it wherever membership is read (member context, my-profile,
 * sign-in) and, when the payment is gone, resets the member in the database.
 *
 * DELIBERATELY NARROW, so no genuine member is ever downgraded:
 *   - only a member whose status is paid;
 *   - only when their `paymentId` is a reference THIS system writes on a
 *     payment order — `pay_…` (online / mock checkout) or `OFF-…` (a Platinum
 *     receipt recorded at the office). Members paid before payment orders
 *     existed, or renewed by hand without an order, carry no such reference
 *     and are never touched;
 *   - only when NO payment order with that reference is still `paid`.
 * A database that cannot be read answers "leave it alone".
 */
const OWN_REFERENCE = /^(pay_|OFF-)/;

const MISSING = { membershipStatus: 'approved', membershipType: 'none', paymentAmount: 0 };
const CLEARED = { membershipActivatedAt: '', membershipExpiresAt: '', paymentId: '', lastPaymentDate: '' };

const isPaid = (status) => ['active', 'completed'].includes(String(status || '').toLowerCase());

/** True when this member's recorded payment no longer exists as a paid order. */
const paymentIsGone = async (member) => {
    if (!member || !isPaid(member.membershipStatus)) return false;
    const ref = String(member.paymentId || '');
    if (!OWN_REFERENCE.test(ref)) return false;
    try {
        const stillPaid = await PaymentOrder.exists({
            $or: [{ gatewayPaymentId: ref }, { orderId: ref }],
            status: 'paid',
        });
        return !stillPaid;
    } catch (error) {
        logger.warn('Payment reconcile: could not read payment orders', { error: error && error.message });
        return false;
    }
};

/**
 * Reset the member to unpaid if their payment is gone. Returns the member as it
 * should now be read (the same object when nothing changed). Never throws.
 */
const reconcileMember = async (member) => {
    if (!(await paymentIsGone(member))) return member;
    try {
        const MemberDetails = require('./memberdetails.model');
        const extra = String(member.membershipTier || '') === 'platinum'
            ? { membershipTier: 'standard' } : {};
        await MemberDetails.updateOne(
            { _id: member._id, paymentId: member.paymentId },
            { $set: { ...MISSING, ...extra }, $unset: CLEARED },
        );
        const { invalidateMemberContext } = require('../common/memberContext');
        invalidateMemberContext(member._id);
        logger.warn('Membership reset to unpaid: its payment no longer exists', {
            memberId: String(member._id), paymentId: member.paymentId,
        });
        return {
            ...member, ...MISSING, ...extra,
            membershipActivatedAt: undefined, membershipExpiresAt: undefined, paymentId: undefined, lastPaymentDate: undefined,
        };
    } catch (error) {
        logger.warn('Payment reconcile: reset failed', { error: error && error.message });
        return member;
    }
};

module.exports = { reconcileMember, paymentIsGone, OWN_REFERENCE };
