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