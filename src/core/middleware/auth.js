const jwt = require('jsonwebtoken');
const config = require('../../config');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const memberIdentityExists = async (decoded) => {
    if (!['member', 'business', 'student', 'aspirant'].includes(decoded.role)) return true;
    const member = await require('../../modules/members/memberdetails.model')
        .findById(decoded.userId).select('isActive').lean();
    return !!member && member.isActive !== false;
};

const verifyToken = asyncHandler(async(req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return next(ApiError.unauthorized('No token provided'));
    }

    let decoded;
    try {
        decoded = jwt.verify(token, config.jwt.secret);
    } catch (error) {
        throw ApiError.unauthorized('Invalid or expired token');
    }
    // Keep database failures distinct from expired sessions. A temporary outage
    // must not be presented to the client as a reason to erase their sign-in.
    if (!await memberIdentityExists(decoded)) throw ApiError.unauthorized('This account is no longer available. Please register again.');
    req.user = decoded;
    next();
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
        let decoded;
        try {
            decoded = jwt.verify(token, config.jwt.secret);
        } catch (error) {
            // Token invalid, but we don't throw error
            req.user = null;
        }
        if (decoded) req.user = await memberIdentityExists(decoded) ? decoded : null;
    }

    next();
});

module.exports = {
    verifyToken,
    requireRole,
    requireRoles,
    optionalAuth
};
