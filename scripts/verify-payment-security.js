/**
 * Attacks the payment flow, and asserts every attack fails.
 *
 * `POST /payment/complete` used to take the client's word for everything. It
 * accepted `{ paymentId, paymentMethod, transactionId, status }`, checked none
 * of it against anything — there was nothing to check it against — and set
 * `membershipStatus` to `approved`. An authenticated request with an **empty
 * body** bought a membership. Any member who could sign in could grant
 * themselves one, with no card and no money.
 *
 * Each case below is a way somebody would actually try it. They are written as
 * attacks rather than as feature tests because a feature test passes just as
 * happily against an endpoint that verifies nothing.
 *
 * Everything it creates is synthetic and removed at the end, including on
 * failure, and it asserts the real member count is unchanged before exiting.
 *
 *   PORT=5077 node src/server.js
 *   BASE_URL=http://localhost:5077 node scripts/verify-payment-security.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = (process.env.BASE_URL || 'http://localhost:5077').replace(/\/$/, '') + '/api/v1';
const RUN = 'PAYSEC' + Date.now().toString(36).toUpperCase();

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
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
    const PaymentOrder = require('../src/modules/payment/paymentorder.model');

    const realBefore = await Member.countDocuments({ email: { $not: /@parity\.local$/i } });
    const created = [];

    const seed = async (label) => {
        const member = await Member.create({
            fullName: RUN + ' ' + label,
            email: (RUN + '.' + label + '@parity.local').toLowerCase(),
            phoneNumber: '9000000000',
            state: 'PS Test State',
            district: 'PS Test District',
            block: 'PS Test Block',
            role: 'member',
            isActive: true,
            membershipStatus: 'pending',
        });
        created.push(member._id);
        const token = jwt.sign(
            { userId: member._id.toString(), email: member.email, role: 'member' },
            process.env.JWT_SECRET,
            { expiresIn: '10m' },
        );
        return { member, token };
    };

    /** Still unpaid in the database? */
    const stillUnpaid = async (id) => {
        const row = await Member.findById(id).lean();
        return row && row.membershipStatus === 'pending';
    };

    try {
        const attacker = await seed('attacker');
        const victim = await seed('victim');

        // ---- the original exploit --------------------------------------
        console.log('\nThe exploit that prompted this');

        const empty = await call('/payment/complete', {
            method: 'POST', token: attacker.token, body: {},
        });
        check('an empty body no longer buys a membership', empty.status >= 400,
            'answered ' + empty.status);
        check('  ...and the member is still unpaid', await stillUnpaid(attacker.member._id));

        const madeUp = await call('/payment/complete', {
            method: 'POST',
            token: attacker.token,
            body: {
                paymentId: 'PAY_' + Date.now(),
                paymentMethod: 'card',
                transactionId: 'TXN_' + Date.now(),
                status: 'completed',
            },
        });
        check('the old body shape is rejected', madeUp.status >= 400, 'answered ' + madeUp.status);
        check('  ...and the member is still unpaid', await stillUnpaid(attacker.member._id));

        const noAuth = await call('/payment/complete', { method: 'POST', body: {} });
        check('an unauthenticated attempt is rejected', noAuth.status === 401,
            'answered ' + noAuth.status);

        // ---- the amount is the server's --------------------------------
        console.log('\nThe price is not the client\'s to choose');

        const inflated = await call('/payment/order', {
            method: 'POST',
            token: attacker.token,
            // The Enterprise plan, with a rupee-one price attached.
            body: { planId: 'ideal', amount: 1, totalAmount: 1, price: 1 },
        });
        check('an order is created for a valid plan', inflated.status === 201,
            'answered ' + inflated.status);
        check('the amount sent by the client is ignored',
            inflated.data && inflated.data.amount === 20000,
            'server priced it at ' + (inflated.data && inflated.data.amount));

        const unknownPlan = await call('/payment/order', {
            method: 'POST', token: attacker.token, body: { planId: 'free' },
        });
        check('an unknown plan is rejected', unknownPlan.status === 400,
            'answered ' + unknownPlan.status);

        const order = inflated.data;

        // ---- forging a signature ---------------------------------------
        console.log('\nA signature has to be the server\'s');

        const forged = await call('/payment/complete', {
            method: 'POST',
            token: attacker.token,
            body: {
                orderId: order.orderId,
                gatewayPaymentId: 'pay_forged',
                signature: crypto.randomBytes(32).toString('hex'),
            },
        });
        check('a random signature is rejected', forged.status === 401,
            'answered ' + forged.status);

        const wrongKey = await call('/payment/complete', {
            method: 'POST',
            token: attacker.token,
            body: {
                orderId: order.orderId,
                gatewayPaymentId: 'pay_wrongkey',
                // Correctly constructed, signed with a key the attacker chose.
                signature: crypto.createHmac('sha256', 'not-the-server-secret')
                    .update(order.orderId + '|pay_wrongkey').digest('hex'),
            },
        });
        check('a signature signed with the wrong key is rejected', wrongKey.status === 401,
            'answered ' + wrongKey.status);

        const noSig = await call('/payment/complete', {
            method: 'POST',
            token: attacker.token,
            body: { orderId: order.orderId, gatewayPaymentId: 'pay_nosig' },
        });
        check('a missing signature is rejected', noSig.status >= 400, 'answered ' + noSig.status);
        check('  ...and the member is still unpaid', await stillUnpaid(attacker.member._id));

        // ---- somebody else's order -------------------------------------
        console.log('\nAn order belongs to one member');

        const stolen = await call('/payment/complete', {
            method: 'POST',
            token: victim.token,
            body: {
                orderId: order.orderId,
                gatewayPaymentId: 'pay_stolen',
                signature: crypto.randomBytes(32).toString('hex'),
            },
        });
        check('another member cannot complete this order', stolen.status === 403,
            'answered ' + stolen.status);
        check('  ...and that member is still unpaid', await stillUnpaid(victim.member._id));

        const peek = await call('/payment/order/' + order.orderId, { token: victim.token });
        check('another member cannot even read it', peek.status === 403, 'answered ' + peek.status);

        const authorizeOthers = await call('/payment/mock-authorize', {
            method: 'POST', token: victim.token, body: { orderId: order.orderId },
        });
        check('another member cannot authorise it', authorizeOthers.status === 403,
            'answered ' + authorizeOthers.status);

        // ---- the legitimate path ---------------------------------------
        console.log('\nThe legitimate path still works');

        const auth = await call('/payment/mock-authorize', {
            method: 'POST', token: attacker.token, body: { orderId: order.orderId },
        });
        check('the owner can authorise their own order', auth.status === 200,
            'answered ' + auth.status);
        check('the authorisation is marked as mock', auth.data && auth.data.mockMode === true);

        const paid = await call('/payment/complete', {
            method: 'POST',
            token: attacker.token,
            body: {
                orderId: order.orderId,
                gatewayPaymentId: auth.data.gatewayPaymentId,
                signature: auth.data.signature,
                paymentMethod: 'card',
            },
        });
        check('a verified payment activates the membership', paid.status === 200,
            'answered ' + paid.status);

        const activated = await Member.findById(attacker.member._id).lean();
        check('membershipStatus is approved', activated.membershipStatus === 'approved',
            activated.membershipStatus);
        check('the amount recorded is the server\'s, not the client\'s',
            activated.paymentAmount === 20000, String(activated.paymentAmount));
        check('the gateway payment id is recorded',
            activated.paymentId === auth.data.gatewayPaymentId, activated.paymentId);
        check('an expiry is set', !!activated.membershipExpiresAt);

        // ---- replay -----------------------------------------------------
        console.log('\nA completed payment cannot be replayed');

        const replay = await call('/payment/complete', {
            method: 'POST',
            token: attacker.token,
            body: {
                orderId: order.orderId,
                gatewayPaymentId: auth.data.gatewayPaymentId,
                signature: auth.data.signature,
            },
        });
        check('the same verified request a second time is rejected', replay.status >= 400,
            'answered ' + replay.status);

        const reauth = await call('/payment/mock-authorize', {
            method: 'POST', token: attacker.token, body: { orderId: order.orderId },
        });
        check('a paid order cannot be re-authorised', reauth.status >= 400,
            'answered ' + reauth.status);

        const secondOrder = await call('/payment/order', {
            method: 'POST', token: attacker.token, body: { planId: 'basic' },
        });
        check('an already-active member cannot open another order',
            secondOrder.status === 400, 'answered ' + secondOrder.status);

        // ---- the admin-only route ---------------------------------------
        console.log('\nManual renewal is administrators only');

        const renew = await call('/payment/renew', {
            method: 'POST',
            token: victim.token,
            body: { memberId: String(victim.member._id), amount: 2500 },
        });
        check('a member cannot renew their own membership for free',
            renew.status === 403, 'answered ' + renew.status);
        check('  ...and that member is still unpaid', await stillUnpaid(victim.member._id));
    } catch (error) {
        failed += 1;
        console.log('\n  FAIL  the run threw: ' + (error && error.message));
    } finally {
        await PaymentOrder.deleteMany({ memberId: { $in: created } }).catch(() => {});
        await Member.deleteMany({ _id: { $in: created } }).catch(() => {});
        await Member.deleteMany({ email: new RegExp('^' + RUN, 'i') }).catch(() => {});

        const realAfter = await Member.countDocuments({ email: { $not: /@parity\.local$/i } });
        console.log('\n  teardown: real members before=' + realBefore + ' after=' + realAfter +
            (realBefore === realAfter ? ' (untouched)' : '  *** MISMATCH ***'));
        if (realBefore !== realAfter) failed += 1;

        await mongoose.disconnect();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed === 0) {
        console.log('\n  A MEMBERSHIP CANNOT BE ACTIVATED WITHOUT A SERVER-VERIFIED PAYMENT\n');
    }
    process.exit(failed > 0 ? 1 : 0);
})();
