const asyncHandler = require('../../core/utils/asyncHandler');
const ApiError = require('../../core/utils/ApiError');
const { resolveMemberContext } = require('./memberContext');
const { STUDENT_UPGRADE_MESSAGE } = require('./memberAudience');

const requireNetworking = asyncHandler(async(req, res, next) => {
    const context = await resolveMemberContext(req);
    if (context.isAdmin || context.canNetwork) return next();
    throw ApiError.forbidden(context.isStudent ? STUDENT_UPGRADE_MESSAGE
        : 'Dear member, please activate or renew your membership to connect with members.');
});
module.exports = { requireNetworking };
