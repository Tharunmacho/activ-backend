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