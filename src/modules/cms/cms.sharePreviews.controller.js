const service = require('./cms.sharePreviews.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

module.exports = {
    resolve: asyncHandler(async(req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(ApiResponse.success(await service.resolve(req.query.path || '/')));
    }),
    editorData: asyncHandler(async(req, res) => res.json(ApiResponse.success(await service.editorData()))),
    save: asyncHandler(async(req, res) => res.json(ApiResponse.success(await service.save(req.body || {}, req.user || {}), 'Social preview saved'))),
    reset: asyncHandler(async(req, res) => res.json(ApiResponse.success(await service.reset(req.query.path), 'Social preview reset'))),
};
