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