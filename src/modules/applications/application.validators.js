const { body } = require('express-validator');
const ApiError = require('../../core/utils/ApiError');
const { validationResult } = require('express-validator');

/**
 * Errors go to next(), never throw: Express 4 does not await async middleware,
 * so a throw here becomes an unhandled rejection and kills the process.
 */
const validate = (validations) => {
    return async(req, res, next) => {
        try {
            await Promise.all(validations.map(validation => validation.run(req)));
            const errors = validationResult(req);
            if (errors.isEmpty()) return next();

            const extractedErrors = errors.array().map(err => ({ field: err.path, message: err.msg }));
            return next(ApiError.badRequest(`Validation error: ${extractedErrors[0].message}`));
        } catch (error) {
            return next(error);
        }
    };
};

const createApplicationValidator = validate([
    body('applicationType').optional().isIn(['membership', 'business_profile', 'udyam_registration']),
    body('data').optional()
]);

const updateStatusValidator = validate([
    body('status').isIn(['pending_block', 'pending_district', 'pending_state', 'approved', 'rejected']),
    body('comment').optional().isString()
]);

module.exports = {
    createApplicationValidator,
    updateStatusValidator
};