/**
 * What a membership costs, decided here and nowhere else.
 *
 * The old `POST /payment/complete` never saw an amount at all — it activated a
 * membership from whatever body arrived, including an empty one — and
 * `POST /payment/create-request` took `amount` from the request and merely
 * compared it against a table that no plan on either client matched. Both
 * amount to the same thing: the price was not the server's to decide.
 *
 * It is now. A client names a `planId`; the server looks the price up here.
 * Nothing a client sends can change what is charged.
 *
 * These are the four plans the mobile `CompleteMembershipScreen` offers, at the
 * prices it offers them, so a payment recorded from either client describes the
 * same purchase.
 */

const PLANS = Object.freeze({
    basic: {
        id: 'basic',
        name: 'Starter',
        amount: 5000,
        membershipType: 'annual',
        forBusiness: true
    },
    intermediate: {
        id: 'intermediate',
        name: 'Professional',
        amount: 10000,
        membershipType: 'annual',
        forBusiness: true
    },
    ideal: {
        id: 'ideal',
        name: 'Enterprise',
        amount: 20000,
        membershipType: 'annual',
        forBusiness: true
    },
    aspirant: {
        id: 'aspirant',
        name: 'Aspirant',
        amount: 2000,
        membershipType: 'annual',
        forBusiness: false
    }
});

/** The plan, or `null`. Callers must treat `null` as "reject the request". */
const getPlan = planId => PLANS[String(planId || '').trim().toLowerCase()] || null;

/** Every plan, for the endpoint that lets a client render the picker. */
const listPlans = () => Object.values(PLANS);

module.exports = { PLANS, getPlan, listPlans };
