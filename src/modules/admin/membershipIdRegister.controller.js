const service = require('./membershipIdRegister.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
exports.list = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.list(req.query, req.user))));
exports.detail = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.detail(req.params.memberId, req.user))));
exports.update = asyncHandler(async (req, res) => res.json(ApiResponse.success(await service.update(req.params.memberId, req.body || {}, req.user), 'Membership record updated')));
