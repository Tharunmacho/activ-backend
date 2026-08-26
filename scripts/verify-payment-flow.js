/**
 * Verifies the payment flow the website now uses, end to end against the API.
 *
 * The website was calling `POST /payment/initiate`, `POST /payment/verify` and
 * `GET /payment/history` — none of which the backend declares — so the Pay
 * button answered 404 and no membership could ever be activated from the
 * website. Mobile posts `POST /payment/complete`, and that is the route this
 * exercises, with the exact body `PaymentGatewayScreen.tsx:76` sends.
 *
 * What it asserts, in order:
 *
 *   1. the routes the website used to call really do not exist, so a
 *      reintroduction fails here rather than in front of a member;
 *   2. a fresh member reads as unpaid, and is refused a certificate;
 *   3. `POST /payment/complete` flips `membershipStatus` to `approved` and
 *      stamps `membershipActivatedAt`, `paymentId` and `lastPaymentDate`;
 *   4. `/members/my-profile` then reports the membership identity the paid
 *      dashboard renders — and the Member ID matches the one on the
 *      certificate, which is the point of deriving both the same way;
 *   5. the certificate is issued once the membership is active.
 *
 * Everything it creates is synthetic and removed at the end, including on
 * failure, and it asserts the real member count is unchanged before exiting.
 *
 *   PORT=5077 node src/server.js
 *   BASE_URL=http://localhost:5077 node scripts/verify-payment-flow.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = (process.env.BASE_URL || 'http://localhost:5077').replace(/\/$/, '') + '/api/v1';
const RUN = 'PAYFLOW' + Date.now().toString(36).toUpperCase();

let passed = 0;
let failed = 0;

const check = (name, condition, detail) => {
    if (condition) {
        passed += 1;
        console.log('  PASS  ' + name);
    } else {
        failed += 1;
        console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
    }
};

const call = async (path, options = {}) => {
    const res = await fetch(BASE + path, {
        method: options.method || 'GET',
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            options.token ? { Authorization: 'Bearer ' + options.token } : {},
        ),
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    const data = body && Object.prototype.hasOwnProperty.call(body, 'data') && body.data != null
        ? body.data
        : body;
    return { status: res.status, body, data };
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const Member = require('../src/modules/members/memberdetails.model');
    const realBefore = await Member.countDocuments({ email: { $not: /@parity\.local$/i } });

    let member = null;

    try {
        member = await Member.create({
            fullName: RUN + ' Payer',
            email: (RUN + '@parity.local').toLowerCase(),
            phoneNumber: '9000000000',
            state: 'PF Test State',
            district: 'PF Test District',
            block: 'PF Test Block',
            role: 'member',
            isActive: true,
            membershipStatus: 'pending',
        });

        // Signed the way authService.login signs a member: the MemberDetails id.
        const token = jwt.sign(
            { userId: member._id.toString(), email: member.email, role: 'member' },
            process.env.JWT_SECRET,
            { expiresIn: '10m' },
        );

        // ---- 1. the routes the website used to call --------------------
        console.log('\nThe endpoints the website used to call do not exist');

        for (const [method, path] of [
            ['POST', '/payment/initiate'],
            ['POST', '/payment/verify'],
            ['GET', '/payment/history'],
        ]) {
            const res = await call(path, { method, token, body: method === 'POST' ? {} : undefined });
            check(method + ' ' + path + ' is not a route', res.status === 404,
                'answered ' + res.status);
        }

        // Probed WITHOUT a token: an authenticated empty POST to this route
        // activates the membership, which would have made the "before payment"
        // assertions below pass against an account this probe had already paid
        // for. A 401 proves the route is mounted just as well as a 200 does.
        const real = await call('/payment/complete', { method: 'POST', body: {} });
        check('POST /payment/complete IS a route', real.status === 401,
            'expected 401 from an unauthenticated probe, answered ' + real.status);

        // ---- 2. before paying ------------------------------------------
        console.log('\nBefore payment');

        let profile = await call('/members/my-profile', { token });
        check('the profile reads membershipStatus pending',
            profile.data && profile.data.membershipStatus === 'pending',
            profile.data && profile.data.membershipStatus);

        const earlyCert = await call('/members/certificate/membership', { token });
        check('a certificate is refused before payment', earlyCert.status === 403,
            'answered ' + earlyCert.status);

        // ---- 3. the payment --------------------------------------------
        console.log('\nOrder, authorise, complete — the flow both clients now use');

        const orderRes = await call('/payment/order', {
            method: 'POST', token, body: { planId: 'intermediate' },
        });
        check('an order is created', orderRes.status === 201, 'answered ' + orderRes.status);
        check('the server priced it, not the client',
            orderRes.data && orderRes.data.amount === 10000,
            'amount=' + (orderRes.data && orderRes.data.amount));

        const auth = await call('/payment/mock-authorize', {
            method: 'POST', token, body: { orderId: orderRes.data.orderId },
        });
        check('the order is authorised', auth.status === 200, 'answered ' + auth.status);
        check('a signature is issued', !!(auth.data && auth.data.signature));

        const paid = await call('/payment/complete', {
            method: 'POST',
            token,
            body: {
                orderId: orderRes.data.orderId,
                gatewayPaymentId: auth.data.gatewayPaymentId,
                signature: auth.data.signature,
                paymentMethod: 'card',
            },
        });
        check('the verified payment is accepted', paid.status === 200, 'answered ' + paid.status);

        const stored = await Member.findById(member._id).lean();
        check('membershipStatus is approved', stored.membershipStatus === 'approved', stored.membershipStatus);
        check('membershipType is stored', stored.membershipType === 'annual', stored.membershipType);
        check('membershipActivatedAt is stamped', !!stored.membershipActivatedAt);
        check('paymentId is the gateway id', stored.paymentId === auth.data.gatewayPaymentId, stored.paymentId);
        check('paymentAmount is the order amount', stored.paymentAmount === 10000, String(stored.paymentAmount));
        check('lastPaymentDate is stamped', !!stored.lastPaymentDate);
        check('membershipExpiresAt is stamped', !!stored.membershipExpiresAt);

        // ---- 4. what the paid dashboard renders -------------------------
        console.log('\nThe paid dashboard has real values to show');

        profile = await call('/members/my-profile', { token });
        const p = profile.data || {};

        check('the profile now reads approved', p.membershipStatus === 'approved', p.membershipStatus);
        check('getPaymentStatus() would return completed',
            ['approved', 'active'].includes(String(p.membershipStatus).toLowerCase()));
        check('membershipActivatedAt is returned — "Member since"',
            !!p.membershipActivatedAt,
            'mobile prints a hardcoded "January 15, 2020" because this was never returned');
        check('membershipNumber is returned — the Member ID', !!p.membershipNumber, p.membershipNumber);

        const again = await call('/members/my-profile', { token });
        check('the Member ID is stable across reads',
            again.data && again.data.membershipNumber === p.membershipNumber,
            'mobile regenerates it with Math.random() on every screen load');

        // ---- 5. the certificate ----------------------------------------
        console.log('\nDocuments, once the membership is active');

        const cert = await call('/members/certificate/membership', { token });
        check('the membership certificate is issued', cert.status === 200, 'answered ' + cert.status);
        check('the certificate Member ID matches the dashboard',
            cert.data && cert.data.member && cert.data.member.membershipNumber === p.membershipNumber,
            'certificate=' + (cert.data && cert.data.member && cert.data.member.membershipNumber) +
            '  dashboard=' + p.membershipNumber);

        const tax = await call('/members/certificate/tax-exemption', { token });
        check('the tax exemption certificate is issued', tax.status === 200, 'answered ' + tax.status);
    } catch (error) {
        failed += 1;
        console.log('\n  FAIL  the run threw: ' + (error && error.message));
    } finally {
        if (member) {
            const PaymentOrder = require('../src/modules/payment/paymentorder.model');
            await PaymentOrder.deleteMany({ memberId: member._id }).catch(() => {});
            await Member.deleteOne({ _id: member._id }).catch(() => {});
        }
        await Member.deleteMany({ email: new RegExp('^' + RUN, 'i') }).catch(() => {});

        const realAfter = await Member.countDocuments({ email: { $not: /@parity\.local$/i } });
        console.log('\n  teardown: real members before=' + realBefore + ' after=' + realAfter +
            (realBefore === realAfter ? ' (untouched)' : '  *** MISMATCH ***'));
        if (realBefore !== realAfter) failed += 1;

        const leftover = await Member.countDocuments({ email: new RegExp('^' + RUN, 'i') });
        console.log('  synthetic rows left behind: ' + leftover);
        if (leftover > 0) failed += 1;

        await mongoose.disconnect();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed === 0) console.log('\n  THE WEBSITE PAYMENT FLOW ACTIVATES A MEMBERSHIP, EXACTLY AS MOBILE DOES\n');
    process.exit(failed > 0 ? 1 : 0);
})();
