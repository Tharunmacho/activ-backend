const auditService = require('./audit.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

const listAudit = asyncHandler(async(req, res) => {
    const data = await auditService.list(req.query || {});
    res.json(ApiResponse.success(data));
});

const auditCounts = asyncHandler(async(req, res) => {
    const data = await auditService.counts();
    res.json(ApiResponse.success(data));
});

module.exports = { listAudit, auditCounts };
