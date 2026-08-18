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
            return next(ApiError.badRequest(`Validation error: ${errors.array()[0].msg}`));
        } catch (error) {
            return next(error);
        }
    };
};

const updateMemberValidator = validate([
    body('state').optional().isString(),
    body('district').optional().isString(),
    body('city').optional().isString(),
    body('businessName').optional().isString()
]);

module.exports = { updateMemberValidator };