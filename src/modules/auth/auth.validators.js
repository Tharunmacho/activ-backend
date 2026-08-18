const { body, validationResult } = require('express-validator');
const ApiError = require('../../core/utils/ApiError');

/**
 * Express 4 does not await async middleware, so THROWING here escapes as an
 * unhandled promise rejection — and server.js exits the process on those.
 * A user typing a 3-digit phone number would take the whole API down.
 * Errors must be handed to Express via next() instead.
 */
const validate = (validations) => {
    return async(req, res, next) => {
        try {
            await Promise.all(validations.map(validation => validation.run(req)));

            const errors = validationResult(req);
            if (errors.isEmpty()) {
                return next();
            }

            const extractedErrors = errors.array().map(err => ({
                field: err.path,
                message: err.msg
            }));

            return next(ApiError.badRequest(`Validation error: ${extractedErrors[0].message}`));
        } catch (error) {
            return next(error);
        }
    };
};

const registerValidator = validate([
    body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
    body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
    body('fullName')
    .trim()
    .notEmpty()
    .withMessage('Full name is required'),
    body('phoneNumber')
    .trim()
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^[0-9]{10}$/)
    .withMessage('Phone number must be 10 digits')
]);

const loginValidator = validate([
    body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
    body('password')
    .notEmpty()
    .withMessage('Password is required')
]);

const refreshTokenValidator = validate([
    body('refreshToken')
    .notEmpty()
    .withMessage('Refresh token is required')
]);

const changePasswordValidator = validate([
    body('oldPassword')
    .notEmpty()
    .withMessage('Current password is required'),
    body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
]);

module.exports = {
    registerValidator,
    loginValidator,
    refreshTokenValidator,
    changePasswordValidator
};