const jwt = require('jsonwebtoken');
const config = require('../../config');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const verifyToken = asyncHandler(async(req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return next(ApiError.unauthorized('No token provided'));
    }

    try {
        const decoded = jwt.verify(token, config.jwt.secret);

        req.user = decoded;
        next();
    } catch (error) {
        throw ApiError.unauthorized('Invalid or expired token');
    }
});

const requireRole = (...roles) => {
    return asyncHandler(async(req, res, next) => {
        if (!req.user) {
            throw ApiError.unauthorized('Authentication required');
        }

        if (!roles.includes(req.user.role)) {
            throw ApiError.forbidden('Insufficient permissions');
        }

        next();
    });
};

const requireRoles = requireRole;

const optionalAuth = asyncHandler(async(req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
        try {
            const decoded = jwt.verify(token, config.jwt.secret);
            req.user = decoded;
        } catch (error) {
            // Token invalid, but we don't throw error
            req.user = null;
        }
    }

    next();
});

module.exports = {
    verifyToken,
    requireRole,
    requireRoles,
    optionalAuth
};