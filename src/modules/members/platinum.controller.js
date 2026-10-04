const platinumService = require('./platinum.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

/** Super Admin → Membership → Platinum. See `platinum.service` for the rules. */

const overview = asyncHandler(async (req, res) => {
    const [plan, members] = await Promise.all([platinumService.plan(), platinumService.listMembers()]);
    res.json(ApiResponse.success({ plan, members, modes: platinumService.MODES || [] }));
});
const createAccount = asyncHandler(async (req, res) => {
    res.status(201).json(ApiResponse.success(await platinumService.createAccount(req.body, req.user), 'Member account created. Record the payment to admit them.'));
});

const search = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await platinumService.search(req.query.q)));
});

const grant = asyncHandler(async (req, res) => {
    const member = await platinumService.grant(req.params.memberId, req.body || {}, req.user || {});
    res.json(ApiResponse.success(member, 'Platinum lifetime membership granted'));
});

const revoke = asyncHandler(async (req, res) => {
    const member = await platinumService.revoke(req.params.memberId, req.user || {});
    res.json(ApiResponse.success(member, 'Platinum membership removed'));
});

/* ---------------------------------------------- requests (the apply flow) */

const listRequests = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await platinumService.listRequests({ status: req.query.status })));
});

const requestDetail = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await platinumService.requestDetail(req.params.id)));
});

const updateRequest = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await platinumService.updateRequest(req.params.id, req.body || {}, req.user || {}), 'Request updated'));
});

/** The member's own: the token decides who, never the body. */
const memberId = (req) => String((req.user && (req.user.userId || req.user.id || req.user._id)) || '');

const myRequest = asyncHandler(async (req, res) => {
    res.json(ApiResponse.success(await platinumService.myRequest(memberId(req))));
});

const createRequest = asyncHandler(async (req, res) => {
    const result = await platinumService.createRequest(memberId(req), req.body || {});
    res.status(result.existing ? 200 : 201).json(ApiResponse.success(result,
        result.existing ? 'We already have your request' : 'Request received — the ACTIV office will contact you'));
});

module.exports = { overview, createAccount, search, grant, revoke, listRequests, requestDetail, updateRequest, myRequest, createRequest };
