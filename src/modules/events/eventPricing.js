/**
 * What a seat on an event costs THIS person.
 *
 * =========================================================================
 * ONE LOOKUP. THE PRICE SHOWN AND THE PRICE CHARGED COME FROM HERE, BOTH.
 * =========================================================================
 *
 * An event now carries two numbers rather than one — `registrationFee`, the
 * common price, and `memberFee`, the rate reserved for members who have paid
 * their membership. Two numbers and two audiences is exactly the shape that
 * invites a second copy of the rule: the booking page works out which one to
 * advertise, and a fortnight later the checkout works it out again, slightly
 * differently, and a member is shown ₹600 and debited ₹1,000 with nothing in
 * the system reporting a disagreement.
 *
 * The membership plans carry a note saying the same thing about
 * `getPlanForPayment`, and for the same reason. This is the events half of it.
 *
 * Every caller — the booking page, the booking write, the member registration
 * path, the admin lists, the public event card — asks this module and prints
 * or charges what it answers.
 *
 * ------------------------------------------------------------ the member rate
 *
 * `memberFee` is `null` on every event written before it existed and on every
 * event whose organiser has not set one, and null means "no member rate — one
 * price for everybody". It is NOT zero: zero is a real answer and a good offer
 * (a paid conference that members attend free), so the two cannot share a
 * value. See the note on the schema field.
 *
 * ----------------------------------------------------- who counts as a member
 *
 * ONE CONDITION: the membership has been PAID FOR.
 *
 * `context.isPaid`, which `resolveMemberContext` reads from the member's live
 * membership status — not from the token. A token issued last month says
 * nothing about a membership that lapsed last week, and the discount is
 * precisely the thing that must stop when the membership does.
 *
 * AN APPROVED APPLICATION IS NOT A PAYMENT. `approved` is deliberately absent
 * from `PAID_STATUSES`: the three-tier workflow approving an application is
 * what unlocks the payment step, not the payment itself, so somebody sitting at
 * `approved` — or at `pending` — pays the common price like anybody else.
 *
 * EVERY PLAN COUNTS, THE ASPIRANT ONE INCLUDED. The association's plans are
 * Starter ₹5,000, Intermediate ₹10,000 and Enterprise ₹20,000 for businesses
 * and Aspirant ₹1,000 for somebody who has not started one, and all four earn
 * the event rate. This was asked the other way round once — business plans
 * only — and settled here: a member is a member, and the plan they are on is
 * not a thing the event pricing looks at. If that is ever revisited, the signal
 * is `context.memberType` (`business` / `aspirant`), which mirrors the plan's
 * own `audience`; the member row does not record which plan was bought.
 *
 * A guest is never a member. `context` is `null` for guest checkout and the
 * common price applies, which is the whole point of the arrangement: the
 * saving is visible on the public booking page, beside the higher number the
 * visitor is about to pay.
 */

/** Rupees, non-negative, whole. Events are priced in rupees — never paise. */
const rupees = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * Whether a member rate has been set at all.
 *
 * `null` and `undefined` and `''` all mean "not set". A numeric 0 does not,
 * and is the reason this cannot be written as a plain truthiness check.
 */
const hasMemberRate = (event = {}) => {
    const raw = event.memberFee;
    if (raw === null || raw === undefined || raw === '') return false;
    return Number.isFinite(Number(raw));
};

/**
 * The member's price, floored by nothing and capped by the common price.
 *
 * A member rate ABOVE the common price is a typo — nobody offers a membership
 * that costs more at the door — and charging it would take more money from the
 * one group that has already paid the association. The cap means the worst a
 * slip can do is remove the discount.
 */
const memberPriceFor = (event = {}) => {
    const price = rupees(event.registrationFee);
    if (!hasMemberRate(event)) return price;
    return Math.min(price, rupees(event.memberFee));
};

/**
 * The whole pricing answer for one event and one viewer.
 *
 * Returned as a block rather than a single number because every screen needs
 * more than the number: the booking page prints the saving to advertise the
 * membership, the admin list prints both rates, and the receipt has to be able
 * to say WHICH rate was applied to a booking taken a year ago.
 *
 * @param {object}      event    the event document (or a lean row)
 * @param {object|null} context  the member context, or null for a guest
 */
const priceFor = (event = {}, context = null) => {
    const price = rupees(event && event.registrationFee);
    const memberPrice = memberPriceFor(event || {});
    const hasRate = hasMemberRate(event || {}) && memberPrice < price;

    /*
     * `context.isPaid` only. An admin is not a member, and a signed-in member
     * who has not paid is not one either — that is the distinction the discount
     * exists to make visible. Every paid plan qualifies; see the note above.
     */
    const isMember = !!(context && context.isPaid);
    const applied = isMember ? memberPrice : price;

    return {
        /** What anybody without an active membership pays. */
        price,
        /** What a member with an active membership pays. Equals `price` when no rate is set. */
        memberPrice,
        /** Whether a real member rate exists — a lower number, deliberately set. */
        hasMemberRate: hasRate,
        /** Rupees a member keeps. `0` when there is no rate. */
        memberSaving: Math.max(0, price - memberPrice),
        /** Whole percent off, for the "40% off" badge. `0` when there is no rate, or the price is free. */
        memberSavingPercent: price > 0 ? Math.round(((price - memberPrice) / price) * 100) : 0,

        /** THE NUMBER TO CHARGE AND THE NUMBER TO PRINT. One field, one answer. */
        amount: applied,
        /** Whether `amount` is the member rate — what the receipt records. */
        memberRateApplied: isMember && hasRate,
        /** Whether this viewer is an active member at all. */
        isMember
    };
};

module.exports = { priceFor, memberPriceFor, hasMemberRate, rupees };
