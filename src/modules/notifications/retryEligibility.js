const MemberDetails = require('../members/memberdetails.model');
const PaymentOrder = require('../payment/paymentorder.model');
const EventBooking = require('../events/eventbooking.model');
const { renewalFor, membershipState, periodEnd } = require('../members/membershipState');
const { expiryBoundary } = require('../members/membershipDates');
const Application = require('../applications/application.model');
const { normalizeStatus } = require('../common/applicationStatus');
const reviews = require('../common/tierReviews');

const APPLICATION_EVENTS = new Set(['APPLICATION_SUBMITTED', 'APPLICATION_ENDORSED', 'APPLICATION_APPROVED', 'CORRECTION_REQUESTED']);
const STATEFUL = new Set(['PAYMENT_REQUIRED', 'PAYMENT_FAILED', 'EVENT_PAYMENT_FAILED', 'MEMBERSHIP_RENEWAL_DUE',
    'MEMBERSHIP_STATUS_CHANGED', 'MEMBERSHIP_PLAN_ADVANCED', 'MEMBERSHIP_ACTIVATED', 'BOT_REPLY', ...APPLICATION_EVENTS]);
const dateValue = value => value ? new Date(value).getTime() : NaN;
const idOf = value => value && String(value._id || value);
const memberUnavailable = member => !member || member.deletedAt || member.isActive === false
    || String(member.membershipStatus || '').toLowerCase() === 'cancelled';
const iso = value => Number.isFinite(dateValue(value)) ? new Date(value).toISOString() : '';
// Persist only the facts that identify the paid period, never the whole member.
const snapshotActivation = member => ({
    membershipType: String(member.membershipType || '').toLowerCase(),
    membershipTier: String(member.membershipTier || 'standard').toLowerCase(),
    activatedAt: iso(member.membershipActivatedAt),
    expiresAt: iso(periodEnd(member)),
    paymentId: String(member.paymentId || ''),
    lastPaymentDate: iso(member.lastPaymentDate),
});

async function applicationReason(row, memberId, context) {
    if (!memberId || !context.applicationId) return 'The original application could not be verified.';
    const [application, directMember] = await Promise.all([
        Application.findById(context.applicationId).lean(), MemberDetails.findById(memberId).lean(),
    ]);
    if (!application || application.deletedAt || idOf(application.userId) !== memberId) return 'The application no longer matches this member.';
    // Older applications link the login ID through MemberDetails.userId. Keep
    // that original ownership check; never infer the owner from an email match.
    const member = directMember || await MemberDetails.findOne({ userId: memberId }).lean();
    if (memberUnavailable(member)) return 'The member account is no longer active.';
    const status = normalizeStatus(application.status);
    if (row.event === 'APPLICATION_SUBMITTED') {
        if (status !== 'Pending' || reviews.TIER_ORDER.some(tier => reviews.hasOwnVerdict(application, tier))) {
            return 'Application review has progressed since this submission notice.';
        }
        return '';
    }
    const expected = row.event === 'CORRECTION_REQUESTED' ? 'Rejected' : row.event === 'APPLICATION_APPROVED' ? 'Approved' : 'Pending';
    if (status !== expected) return 'The application decision has changed since this notification.';
    if (row.event === 'APPLICATION_APPROVED' && ['active', 'completed'].includes(String(member.membershipStatus || '').toLowerCase())) {
        return 'The member has already completed membership payment.';
    }
    const tier = row.event === 'APPLICATION_ENDORSED' ? context.tier : reviews.DECIDING_TIER;
    if (!reviews.TIER_ORDER.includes(tier)) return 'The original review tier could not be verified.';
    const verdict = reviews.tierVerdict(application, tier, { carried: false });
    const decision = row.event === 'CORRECTION_REQUESTED' ? 'rejected' : 'approved';
    if (verdict.auto || verdict.decision !== decision) return 'This review decision is no longer current.';
    if (row.event === 'APPLICATION_ENDORSED' && reviews.TIER_ORDER.slice(reviews.TIER_ORDER.indexOf(tier) + 1)
        .some(higher => reviews.hasOwnVerdict(application, higher) && reviews.tierVerdict(application, higher).decision === 'approved')) {
        return 'A later review has superseded this endorsement.';
    }
    const decidedAt = dateValue(verdict.decidedAt);
    const originalAt = dateValue(context.reviewDecidedAt);
    if (Number.isFinite(originalAt)) {
        if (decidedAt !== originalAt || (context.reviewDecision && context.reviewDecision !== verdict.decision)) {
            return 'The application has a newer review decision.';
        }
    } else if (!Number.isFinite(decidedAt) || !Number.isFinite(dateValue(row.createdAt)) || decidedAt > dateValue(row.createdAt)) {
        return 'The original review decision could not be verified.';
    }
    if (row.event === 'CORRECTION_REQUESTED' && context.reason
        && String(context.reason).trim() !== String(application.rejectionReason || verdict.reason || '').trim()) {
        return 'The application rejection reason has changed.';
    }
    return '';
}

const replyReasonToSkip = async (row = {}) => {
    const data = row.data || {};
    // A retry is for a rejected or failed part only. An accepted prefix must
    // never be re-sent when a later part of the conversation failed.
    if (row.deliveryStatus !== 'failed' && (row.deliveryStatus || row.status !== 'failed')) {
        return 'This reply part was already accepted or has no confirmed failure.';
    }
    if (!['meta', 'botbee'].includes(row.provider) || !data.inboundMessageId || !data.text) {
        return 'The original reply provider or message context could not be verified.';
    }
    const numeric = /^\d+$/.test(String(data.inboundAt || '')) ? Number(data.inboundAt) : NaN;
    const inboundAt = Number.isFinite(numeric)
        ? (numeric < 1e12 ? numeric * 1000 : numeric) : dateValue(data.inboundAt);
    const age = Date.now() - inboundAt;
    if (!Number.isFinite(inboundAt) || age < -60000 || age >= 24 * 60 * 60 * 1000) {
        return 'The original WhatsApp reply window is unknown or expired. Wait for a new incoming message.';
    }
    const part = data.part === undefined ? 1 : Number(data.part);
    const parts = data.parts === undefined ? 1 : Number(data.parts);
    if (!Number.isInteger(part) || !Number.isInteger(parts) || part < 1 || part > parts || parts > 100) {
        return 'The original reply-part sequence could not be verified.';
    }
    if (part === 1) return '';
    try {
        const previous = await require('./notificationLog.model').find({
            event: 'BOT_REPLY', channel: 'whatsapp', provider: row.provider, recipient: row.recipient,
            'data.inboundMessageId': data.inboundMessageId, 'data.part': { $lt: part }
        }).select('status deliveryStatus data.part').lean();
        const accepted = new Set(previous.filter(item => item.deliveryStatus !== 'failed'
            && (['accepted', 'sent', 'delivered', 'read'].includes(item.deliveryStatus)
                || (!item.deliveryStatus && item.status === 'sent'))).map(item => Number(item.data?.part)));
        for (let index = 1; index < part; index++) if (!accepted.has(index)) {
            return 'An earlier reply part is still waiting for successful delivery acceptance.';
        }
        return '';
    } catch {
        return 'Earlier reply-part delivery could not be checked. Retry after it can be verified.';
    }
};

/**
 * A delivery retry must still describe the recipient's current state.
 * Returns an empty string when eligible, otherwise a human-readable skip reason.
 * This does not send, mutate, or rebuild notifications. A failed lookup always
 * stops stateful payment/renewal replay; other event messages use booking resend.
 */
const reasonToSkip = async (row = {}) => {
    if (!STATEFUL.has(row.event)) return '';
    if (row.event === 'BOT_REPLY') return replyReasonToSkip(row);
    const data = row.data || {};
    const lifecycle = data.lifecycleData || {};
    const orderId = lifecycle.orderId || data.orderId;
    const memberId = idOf(row.user);
    try {
        if (APPLICATION_EVENTS.has(row.event)) return await applicationReason(row, memberId, { ...data, ...lifecycle });
        if (row.event === 'MEMBERSHIP_ACTIVATED') {
            if (!memberId) return 'The member for this activation could not be verified.';
            const member = await MemberDetails.findById(memberId).lean();
            if (memberUnavailable(member) || membershipState(member).state !== 'active') return 'This membership activation is no longer current.';
            const original = lifecycle.activationState || data.activationState;
            if (!original || typeof original !== 'object') return 'The original activation period could not be verified.';
            const current = snapshotActivation(member);
            if (Object.keys(current).some(key => original[key] !== current[key])) return 'Membership has changed since this activation notice.';
            if (orderId) {
                const order = await PaymentOrder.findOne({ orderId: String(orderId) }).lean();
                if (!order || order.status !== 'paid' || idOf(order.memberId) !== memberId
                    || !['membership', undefined].includes(order.orderType)) return 'The original membership payment is no longer confirmed.';
            }
            return '';
        }
        // These updates can refer to a deliberately cancelled receipt. Check
        // the membership/request itself before applying payment-order rules.
        if (row.event === 'MEMBERSHIP_STATUS_CHANGED' || row.event === 'MEMBERSHIP_PLAN_ADVANCED') {
            if (!memberId) return 'The member for this notification could not be verified.';
            const member = await MemberDetails.findById(memberId).lean();
            if (memberUnavailable(member)) return 'The member account is no longer active.';
            const context = { ...data, ...lifecycle };
            if (row.event === 'MEMBERSHIP_PLAN_ADVANCED') {
                if (!context.planId || renewalFor(member).state !== 'active') return 'This membership plan update is no longer current.';
                return String(member.planNotificationState?.planId || '') === String(context.planId)
                    ? '' : 'The member has moved to a different membership plan.';
            }
            if (context.change === 'lifetime_request_declined') {
                if (!context.requestId) return 'The original Lifetime request could not be verified.';
                const request = await require('../members/platinumrequest.model').findOne({
                    _id: context.requestId, memberId
                }).lean();
                if (!request || request.status !== 'declined' || member.membershipTier === 'platinum') return 'The Lifetime request decision is no longer current.';
                return '';
            }
            if (context.change === 'lifetime_revoked') {
                if (context.membershipTier !== 'standard' || !context.membershipStatus || !context.membershipType) return 'The restored membership details could not be verified.';
                if (member.membershipTier !== 'standard' || member.membershipStatus !== context.membershipStatus
                    || member.membershipType !== context.membershipType) return 'Membership has changed since this Lifetime update.';
                return '';
            }
            return 'The original membership status change could not be verified.';
        }
        let order;
        if (orderId) {
            order = await PaymentOrder.findOne({ orderId: String(orderId) }).lean();
            if (!order) return 'The payment order no longer exists.';
            if (order.status !== 'created') return 'The payment order is already paid or closed.';
            const expiry = dateValue(order.expiresAt);
            if (!Number.isFinite(expiry) || expiry <= Date.now()) return 'This checkout has expired. Check the current payment status instead.';
            if (memberId && order.memberId && memberId !== idOf(order.memberId)) return 'The payment no longer matches this member.';
        }

        if (row.event === 'EVENT_PAYMENT_FAILED') {
            if (!order || order.orderType !== 'event_booking' || !order.bookingRef) return 'The event payment could not be verified.';
            const booking = await EventBooking.findOne({ bookingRef: order.bookingRef }).lean();
            if (!booking || booking.deletedAt || booking.eventArchived || booking.status === 'cancelled') return 'The event booking is no longer active.';
            if (booking.payment?.status === 'paid') return 'The event booking has already been paid.';
            const ownerId = idOf(order.memberId) || booking.userId;
            if (ownerId && memberUnavailable(await MemberDetails.findById(ownerId).lean())) return 'The member account is no longer active.';
            return '';
        }

        const ownerId = idOf(order?.memberId) || memberId;
        if (!ownerId) return 'The member for this notification could not be verified.';
        const member = await MemberDetails.findById(ownerId).lean();
        if (memberUnavailable(member)) return 'The member account is no longer active.';
        const paidAt = Math.max(dateValue(member.lastPaymentDate) || 0, dateValue(member.membershipActivatedAt) || 0);
        const sentAt = dateValue(row.createdAt);

        if (row.event === 'MEMBERSHIP_RENEWAL_DUE') {
            const renewal = renewalFor(member);
            if (member.renewalReminderEnabled === false || !renewal.canRenew) return 'A membership renewal reminder is no longer due.';
            if (Number.isFinite(sentAt) && paidAt >= sentAt) return 'The member has paid since this reminder was created.';
            const recordedExpiry = lifecycle.expiresAt || data.expiresAt;
            if (recordedExpiry) {
                const prior = expiryBoundary(recordedExpiry);
                if (!prior || !renewal.expiresAt || +prior !== +renewal.expiresAt) return 'Membership validity has changed since this reminder.';
            } else if (!Number.isFinite(sentAt) || !renewal.expiresAt) {
                return 'The original renewal period could not be verified.';
            }
            return '';
        }

        if (order && !['membership', 'company_listing'].includes(order.orderType || 'membership')) return 'This is no longer a membership payment.';
        if (row.event === 'PAYMENT_REQUIRED') {
            if (order?.orderType === 'company_listing') return 'This reminder does not apply to a company publishing checkout.';
            if (['active', 'completed'].includes(String(member.membershipStatus || '').toLowerCase())) return 'Membership payment has already been completed.';
            if (order?.failedPaymentNoticeIds?.length) return 'A verified payment-attempt update has replaced this pending reminder.';
        } else if (!order) {
            return 'The original failed payment attempt could not be verified.';
        }
        // A membership renewal does not pay for an additional company listing.
        if (order?.orderType === 'company_listing') return '';
        const openedAt = dateValue(order?.createdAt);
        const originalAt = Number.isFinite(openedAt) ? openedAt : sentAt;
        if (Number.isFinite(originalAt) && paidAt >= originalAt) return 'The member has paid since this checkout was started.';
        return '';
    } catch {
        return 'Current payment or membership status could not be checked. Retry after the status can be verified.';
    }
};

module.exports = { reasonToSkip, snapshotActivation };
