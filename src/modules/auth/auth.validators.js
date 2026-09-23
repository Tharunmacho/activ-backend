const { body, validationResult } = require('express-validator');
const ApiError = require('../../core/utils/ApiError');
const { validateMobile } = require('../common/phoneNumber');

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
    /*
     * `validateMobile`, not `/^[0-9]{10}$/`.
     *
     * The old pattern accepted `0000000000` and `1234567890` — ten digits each,
     * neither of them a number anyone can be reached on. It also REJECTED
     * `+91 98765 43210`, which is how a person writes their own number, so the
     * form refused correct input and accepted filler. The shared rule handles
     * both: it normalises the country code and spacing away, then refuses the
     * shapes that cannot be real.
     *
     * It is `validateMobile` and not `validateIndianMobile` so a member outside
     * India can register at all. A bare number — which is every request any
     * client sends today — is still judged by the identical Indian rule; only a
     * '+'-prefixed foreign number takes the other branch. Nothing that was
     * accepted before is refused now.
     */
    body('phoneNumber')
    .trim()
    .custom((value) => {
        const result = validateMobile(value, { label: 'Phone number' });
        if (!result.ok) throw new Error(result.reason);
        return true;
    }),
    /*
     * WhatsApp number — required at registration, optional on the record.
     *
     * The schema leaves it optional because every member registered before this
     * field existed has none, and making it required there would fail their
     * next profile save on a value nobody ever asked them for. The requirement
     * belongs here, at the one moment the applicant is actually in front of the
     * form.
     */
    body('whatsappNumber')
    .trim()
    .custom((value) => {
        const result = validateMobile(value, { label: 'WhatsApp number' });
        if (!result.ok) throw new Error(result.reason);
        return true;
    })
]);

/**
 * Sign-in accepts an *identifier*, not strictly an email.
 *
 * Both clients label this field "Email or Member ID", so validating it with
 * `isEmail()` rejected half of what the form invites the user to type — the
 * request never reached the service and came back as
 * `400 Validation error: Please provide a valid email`, which reads like a
 * server fault rather than like "that is not an account".
 *
 * `normalizeEmail()` is gone for the same reason: it mangles anything that is
 * not an address, so a Member ID would have been rewritten before lookup.
 * Case-folding an address is the service's job (`authService.login`).
 *
 * The shape check below is deliberately loose — it only rejects input that
 * cannot identify any account, so the specific "invalid credentials" answer
 * still comes from the service and this layer never guesses.
 */
const OBJECT_ID = /^[a-f\d]{24}$/i;

const loginValidator = validate([
    body('email')
    .customSanitizer((value) => String(value === null || value === undefined ? '' : value).trim())
    .notEmpty()
    .withMessage('Enter your email address or Member ID')
    .bail()
    .custom((value) => {
        if (value.includes('@')) {
            // Smallest possible address is a@b.co; anything shorter or without
            // a dotted domain cannot be delivered to.
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
                throw new Error('Please provide a valid email address');
            }
            return true;
        }
        if (OBJECT_ID.test(value)) return true;
        throw new Error('Enter a valid email address, or your Member ID');
    }),
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

const forgotPasswordValidator = validate([
    body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email')
]);

const resetPasswordValidator = validate([
    body('token')
    .trim()
    .notEmpty()
    .withMessage('Reset token is required'),
    // Matches the alias the controller accepts, so a client sending either
    // field name is validated rather than slipping through empty.
    body('newPassword')
    .if(body('password').not().exists())
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long'),
    body('password')
    .optional()
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
]);

module.exports = {
    registerValidator,
    loginValidator,
    refreshTokenValidator,
    changePasswordValidator,
    forgotPasswordValidator,
    resetPasswordValidator
};