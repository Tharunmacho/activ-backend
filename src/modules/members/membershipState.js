/**
 * WHERE A MEMBERSHIP STANDS — one answer, used by the admin Members screen and
 * by the renewal sweep. Pure: no database, so it is unit-tested directly
 * (`npm run test:members`).
 *
 *   active            paid, and the period has not ended (lifetime / Platinum never ends)
 *   expired           was paid, the period has ended — the sweep also writes
 *                     `membershipStatus: 'expired'` so the member's own screens lock
 *   awaiting_payment  the State approved the application, the fee is not paid yet
 *   none              anything else (still applying, rejected, …) — not a member
 *
 * The period: `membershipExpiresAt` when it is stored. Rows written before that
 * field existed carry an activation date and no expiry; an ANNUAL one of those
 * runs a year from activation — the same fallback the certificate and the paid
 * dashboard use, so the three cannot disagree about when someone lapsed.
 */

const DAY = 24 * 60 * 60 * 1000;
const PAID = ['active', 'completed'];
const EXPIRING_SOON_DAYS = 30;

const lower = (v) => String(v || '').trim().toLowerCase();

const isLifetime = (member = {}) =>
    lower(member.membershipType) === 'lifetime' || lower(member.membershipTier) === 'platinum';

/** When the period ends, or null when it never does / is not known. */
const periodEnd = (member = {}) => {
    if (isLifetime(member)) return null;
    if (member.membershipExpiresAt) {
        const d = new Date(member.membershipExpiresAt);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (lower(member.membershipType) === 'annual' && member.membershipActivatedAt) {
        const d = new Date(member.membershipActivatedAt);
        if (Number.isNaN(d.getTime())) return null;
        d.setFullYear(d.getFullYear() + 1);
        return d;
    }
    return null;
};

/**
 * @param member            a MemberDetails row (lean is fine)
 * @param options.outcome   the application's outcome ('Approved' | 'Rejected' | 'Pending' | '')
 * @param options.now       Date, for tests
 */
const membershipState = (member = {}, { outcome = '', now = new Date() } = {}) => {
    const status = lower(member.membershipStatus);
    const lifetime = isLifetime(member);
    const expiresAt = periodEnd(member);
    const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY) : null;

    let state = 'none';
    if (PAID.includes(status)) {
        state = !lifetime && expiresAt && expiresAt.getTime() <= now.getTime() ? 'expired' : 'active';
    } else if (status === 'expired') {
        // Written by the sweep. Lifetime cannot lapse — a stray 'expired' on a
        // lifetime row is treated as active rather than locking out a life member.
        state = lifetime ? 'active' : 'expired';
    } else if (lower(outcome) === 'approved') {
        state = 'awaiting_payment';
    }

    return {
        state,
        lifetime,
        expiresAt,
        daysLeft,
        expiringSoon: state === 'active' && !lifetime && daysLeft !== null && daysLeft <= EXPIRING_SOON_DAYS,
    };
};

/* ------------------------------------------------------------- renewal */

/**
 * CAN THIS MEMBER RENEW, AND WHAT DOES THE SCREEN SAY — one answer, used by the
 * payment order (who may open one), the payment itself (where the new year
 * starts from) and the member's own screens (the Renew button).
 *
 *   expired                      -> renew now; the new year starts today
 *   active, <= 30 days left      -> renew early; the new year starts when the
 *                                   current one ends, so no paid day is lost
 *   active, more than 30 left    -> not yet; `opensAt` says when it will be
 *   lifetime / not a member      -> never
 *
 * The window is the SAME 30 days the reminder sweep writes "renew now" in, so a
 * member reading that message and pressing the button is never refused.
 */
const renewalFor = (member = {}, { now = new Date() } = {}) => {
    const s = membershipState(member, { now });
    const canRenew = !s.lifetime && (s.state === 'expired' || s.expiringSoon);
    const opensAt = s.expiresAt && !s.lifetime
        ? new Date(s.expiresAt.getTime() - EXPIRING_SOON_DAYS * DAY)
        : null;
    return {
        state: s.state,
        lifetime: s.lifetime,
        expiresAt: s.expiresAt,
        daysLeft: s.daysLeft,
        expiringSoon: s.expiringSoon,
        canRenew,
        /** When the Renew button unlocks, for a member not yet inside the window. */
        opensAt: !canRenew && s.state === 'active' ? opensAt : null,
    };
};

/**
 * Where the NEXT period starts when a renewal is paid.
 *
 * Early: from the current end date, so paying three weeks ahead does not throw
 * three paid weeks away. Late (or never recorded): from now.
 */
const renewalBase = (member = {}, { now = new Date() } = {}) => {
    const end = periodEnd(member);
    return end && end.getTime() > now.getTime() ? new Date(end) : new Date(now);
};

/* ------------------------------------------------ the twice-monthly reminder */

/**
 * The half-month a date falls in: 1st–14th is H1, 15th–end is H2.
 * `expired:2026-10-H1`. One reminder per member per key — a restart, a second
 * server or a sweep running every hour can never send it twice.
 */
const halfMonthKey = (now = new Date()) => {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `expired:${y}-${m}-${now.getDate() >= 15 ? 'H2' : 'H1'}`;
};

/** The first day of the half-month `now` is in (the 1st or the 15th, 00:00 local). */
const halfMonthStart = (now = new Date()) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() >= 15 ? 15 : 1);

/**
 * Is a twice-monthly "your membership has expired" due for this member now?
 *
 * Only for a half-month that STARTED AFTER the membership lapsed: the day it
 * lapses is covered by the expiry-day reminder, and a member who lapsed on the
 * 20th hearing it twice that week would be nagged, not reminded. So their first
 * twice-monthly one is on the next 1st.
 */
const monthlyReminderDue = (member = {}, { now = new Date(), already = [] } = {}) => {
    if (member.renewalReminderEnabled === false) return null;
    const { state, expiresAt } = membershipState(member, { now });
    if (state !== 'expired') return null;
    const start = halfMonthStart(now);
    if (expiresAt && start.getTime() <= expiresAt.getTime()) return null;
    const key = halfMonthKey(now);
    return (already || []).includes(key) ? null : key;
};

module.exports = {
    membershipState,
    renewalFor,
    renewalBase,
    periodEnd,
    isLifetime,
    halfMonthKey,
    halfMonthStart,
    monthlyReminderDue,
    EXPIRING_SOON_DAYS,
    PAID,
};
