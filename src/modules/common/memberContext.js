const MemberDetails = require('../members/memberdetails.model');

const ADMIN_ROLES = ['block_admin', 'district_admin', 'state_admin', 'super_admin'];

/**
 * Whether a membership counts as paid.
 *
 * `active` is the answer, and `approved` is deliberately NOT one.
 *
 * `approved` means the three-tier workflow approved the *application*, which is
 * what unlocks the payment step — it is not the payment. Counting it as paid
 * had this backwards in both directions at once: an approved member was shown
 * the paid dashboard and the paid-only directory without having paid a rupee,
 * and `paymentOrder.createOrder` refused to open an order for them at all
 * ("This membership is already active"), so the one action left to them was the
 * one action they could not take. `commitFinalApproval` already writes
 * `'pending'` for exactly this reason; the reads had not caught up.
 *
 * `completed` is tolerated because the Instamojo path in `payment.service.js`
 * has used it. The website's `getPaymentStatus()` mirrors this list, and the
 * two must agree — a member who sees paid-only cards on the dashboard and then
 * gets 403 from the endpoint behind them has been shown a door that does not
 * open.
 */
const PAID_STATUSES = ['active', 'completed'];

const isPaidStatus = (value) => PAID_STATUSES.includes(String(value || '').toLowerCase());

/**
 * Who is asking, where they are, and whether they have paid.
 *
 * Read from the database rather than from the token, deliberately. The token
 * DOES carry `block`/`district`/`state` — but only on the sign-in paths that
 * bother to pass them: `auth.service.js:182` mints a member token from
 * `{ _id, email, role }` alone, so the location claims are simply absent for a
 * member who signed in through that branch. Targeting a feed on claims that are
 * `undefined` half the time would show those members the national feed and
 * nothing local, with no error anywhere to explain it.
 *
 * Membership status has the same problem and one worse: it is not in the token
 * at all, and it changes DURING a token's lifetime. A member who pays would
 * otherwise keep an unpaid token — and an unpaid view of the association — until
 * it expired.
 *
 * Returns a context with empty regions rather than throwing when there is no
 * member record, so an admin calling a member endpoint sees the national feed
 * instead of a 500.
 */
const resolveMemberContext = async (req) => {
    const user = req.user || {};
    const id = String(user.userId || user.id || user._id || '');
    const role = String(user.role || '');
    const isAdmin = ADMIN_ROLES.includes(role);

    const member = id
        ? await MemberDetails.findById(id)
            .select('fullName email state district block membershipStatus memberType registrationType')
            .lean()
            .catch(() => null)
        : null;

    return {
        id,
        email: String(member?.email || user.email || '').toLowerCase(),
        fullName: member?.fullName || '',
        state: member?.state || user.state || '',
        district: member?.district || user.district || '',
        block: member?.block || user.block || '',
        // An admin is not a paying member, but must be able to preview what
        // members see; every caller treats `isAdmin` as the wider permission.
        isPaid: isPaidStatus(member?.membershipStatus),
        memberType: String(member?.memberType || member?.registrationType || '').toLowerCase(),
        role,
        isAdmin
    };
};

module.exports = { resolveMemberContext, isPaidStatus, PAID_STATUSES, ADMIN_ROLES };
