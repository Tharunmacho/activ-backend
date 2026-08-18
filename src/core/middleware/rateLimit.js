const rateLimit = require('express-rate-limit');
const config = require('../../config');
const logger = require('../../config/logger');

const createRateLimiter = (options = {}) => {
    return rateLimit({
        windowMs: options.windowMs || config.rateLimit.windowMs,
        max: options.max || config.rateLimit.maxRequests,
        message: options.message || 'Too many requests, please try again later',
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            logger.warn(`Rate limit exceeded for IP: ${req.ip}`);
            res.status(429).json({
                success: false,
                message: 'Too many requests, please try again later'
            });
        }
    });
};

// General API rate limiter
const apiLimiter = createRateLimiter();

// Strict limiter for auth endpoints
const authLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: 'Too many login attempts, please try again after 15 minutes'
});

// Lenient limiter for public endpoints
const publicLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 200
});

module.exports = {
    apiLimiter,
    authLimiter,
    publicLimiter,
    createRateLimiter
};