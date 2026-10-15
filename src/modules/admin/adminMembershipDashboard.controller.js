const service = require('./adminMembershipDashboard.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { membershipWorkbook } = require('./membershipReports');
const { sendWorkbook } = require('../../core/utils/spreadsheet');
exports.exportReport = asyncHandler(async (req, res) => {
    const overview = await service.overview(req.user);
    return sendWorkbook(req, res, await membershipWorkbook(overview, req.query));
});
exports.overview = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.overview(req.user))));
exports.detail = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.detail(req.params.memberId, req.user))));
exports.confirm = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.confirm(req.params.memberId, req.body || {}, req.user), 'Membership confirmed')));
exports.remove = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.remove(req.params.memberId, req.user), 'Member account and registration permanently deleted')));
exports.removeArchivedPayment = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.removeArchivedPayment(req.params.paymentId, req.body || {}, req.user), 'Archived membership payment permanently deleted')));
