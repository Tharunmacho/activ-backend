const express = require('express');
const authController = require('./auth.controller');
const authValidators = require('./auth.validators');
const { verifyToken } = require('../../core/middleware/auth');
const { authLimiter } = require('../../core/middleware/rateLimit');

const router = express.Router();

// Public routes
router.post(
    '/register',
    authLimiter,
    authValidators.registerValidator,
    authController.register
);

router.post(
    '/login',
    authLimiter,
    authValidators.loginValidator,
    authController.login
);

router.post(
    '/refresh',
    authValidators.refreshTokenValidator,
    authController.refreshToken
);

/**
 * Password reset — public by necessity: someone who cannot sign in cannot
 * present a token. All three carry the auth limiter, because they are the only
 * unauthenticated endpoints that touch a credential.
 */
router.post(
    '/forgot-password',
    authLimiter,
    authValidators.forgotPasswordValidator,
    authController.forgotPassword
);

// GET so the reset page can check the link before rendering its form.
router.get('/reset-password/verify', authLimiter, authController.verifyResetToken);

/*
 * POST /auth/check-availability { email, phoneNumber } -> { email: taken?, phoneNumber: taken? }
 *
 * Registration step 1 asks before moving on, so "already registered" appears
 * under the box it belongs to instead of after the region step. Only booleans
 * come back; rate-limited like sign-in.
 */
router.post('/check-availability', authLimiter, async(req, res, next) => {
    try {
        const MemberDetails = require('../members/memberdetails.model');
        const MemberAuth = require('./auth.model');
        const email = String((req.body && req.body.email) || '').toLowerCase().trim();
        const digits = String((req.body && req.body.phoneNumber) || '').replace(/\D/g, '').slice(-10);
        const [inDetails, inAuth, byPhone] = await Promise.all([
            email ? MemberDetails.exists({ email }) : null,
            email ? MemberAuth.exists({ email }) : null,
            digits.length === 10
                ? MemberDetails.exists({ phoneNumber: new RegExp(`${digits.split('').join('\\D*')}$`) })
                : null
        ]);
        res.json({ success: true, data: { email: !!(inDetails || inAuth), phoneNumber: !!byPhone } });
    } catch (error) {
        next(error);
    }
});

router.post(
    '/reset-password',
    authLimiter,
    authValidators.resetPasswordValidator,
    authController.resetPassword
);

/*
 * Sign in with Google / Facebook / LinkedIn — members only. See oauth.service.
 * `/providers` tells the website which buttons to show (only those whose keys
 * are set). `/start` and `/callback` are browser navigations, not XHR.
 */
const oauthService = require('./oauth.service');

router.get('/oauth/providers', (req, res) => {
    res.json({ success: true, data: oauthService.listProviders() });
});

router.get('/oauth/:provider/start', authLimiter, (req, res) => {
    try {
        res.redirect(oauthService.startUrl(String(req.params.provider || '').toLowerCase(), req, res));
    } catch (err) {
        const reason = err && err.statusCode === 404 ? 'unavailable' : 'not_configured';
        // The mobile app (`?client=app`, allowlisted) gets its answer on its own
        // deep link; with no client this branch is skipped and nothing changes.
        const client = oauthService.clientFrom(req.query && req.query.client);
        res.redirect(oauthService.toClient(client, { error: reason, provider: String(req.params.provider || '').toLowerCase() }));
    }
});

router.get('/oauth/:provider/callback', authLimiter, async(req, res) => {
    const target = await oauthService
        .handleCallback(String(req.params.provider || '').toLowerCase(), req, res)
        .catch(() => {
            // Same rule as above: only a state token this server issued for the
            // app sends the failure there; everything else is unchanged.
            const client = oauthService.clientFromState(req.query && req.query.state);
            return oauthService.toClient(client, { error: 'failed', provider: String(req.params.provider || '').toLowerCase() });
        });
    return require('./oauthReturnPage')(req, res, target);
});

router.post('/oauth/exchange', authLimiter, async(req, res, next) => {
    try {
        const result = await oauthService.exchange(req.body && req.body.code);
        res.json({ success: true, message: 'Login successful', data: result });
    } catch (err) {
        next(err);
    }
});

// Protected routes
router.post('/logout', verifyToken, authController.logout);

router.get('/me', verifyToken, authController.getCurrentUser);

router.post(
    '/change-password',
    verifyToken,
    authValidators.changePasswordValidator,
    authController.changePassword
);

module.exports = router;
