const announcementService = require('./announcement.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');
const { resolveMemberContext } = require('../common/memberContext');

/**
 * Multer puts an uploaded banner on `req.file`; a JSON body may send a URL.
 *
 * The upload wins when both are present, because a request that carried a file
 * was a deliberate choice to replace the image and the stale URL in the body is
 * just what the form was rendered with.
 */
const bodyWithBanner = (req) => {
    const body = req.body || {};
    if (req.file && req.file.filename) {
        return { ...body, bannerUrl: '/uploads/' + req.file.filename };
    }
    return body;
};

const listForMember = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await announcementService.listForMember(context, req.query || {});
    res.json(ApiResponse.success(data));
});

const getForMember = asyncHandler(async(req, res) => {
    const context = await resolveMemberContext(req);
    const data = await announcementService.getForMember(req.params.id, context);
    res.json(ApiResponse.success(data));
});

const listForAdmin = asyncHandler(async(req, res) => {
    const data = await announcementService.listForAdmin(req.query || {});
    res.json(ApiResponse.success(data));
});

const create = asyncHandler(async(req, res) => {
    const data = await announcementService.create(bodyWithBanner(req), req.user || {});
    res.status(201).json(ApiResponse.created(data, 'Update created'));
});

const update = asyncHandler(async(req, res) => {
    const data = await announcementService.update(req.params.id, bodyWithBanner(req));
    res.json(ApiResponse.success(data, 'Update saved'));
});

const setStatus = asyncHandler(async(req, res) => {
    const data = await announcementService.setStatus(req.params.id, (req.body || {}).status, req.user || {});
    res.json(ApiResponse.success(data, 'Update ' + data.status));
});

const remove = asyncHandler(async(req, res) => {
    const data = await announcementService.remove(req.params.id, req.user || {});
    res.json(ApiResponse.success(data, 'Update deleted'));
});

module.exports = { listForMember, getForMember, listForAdmin, create, update, setStatus, remove };
