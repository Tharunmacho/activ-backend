const service = require('./adminMembershipDashboard.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
exports.overview = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.overview(req.user))));
exports.detail = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.detail(req.params.memberId, req.user))));
exports.confirm = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.confirm(req.params.memberId, req.body || {}, req.user), 'Membership confirmed')));
exports.remove = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.remove(req.params.memberId, req.user), 'Registration deleted; payment records retained')));
