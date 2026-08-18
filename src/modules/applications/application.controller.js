const applicationService = require('./application.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

const createApplication = asyncHandler(async(req, res) => {
    const payload = {
        applicationType: req.body.applicationType || 'membership',
        data: req.body.data || req.body,
        ...req.body
    };
    const application = await applicationService.createApplication(req.user.userId, payload);
    res.status(201).json(ApiResponse.created(application, 'Application submitted'));
});

const getApplication = asyncHandler(async(req, res) => {
    const application = await applicationService.getApplicationById(req.params.id);
    res.json(ApiResponse.success(application));
});

const getUserApplications = asyncHandler(async(req, res) => {
    const targetUserId = req.params.userId || req.user.userId;
    const applications = await applicationService.getUserApplications(targetUserId);
    res.json(ApiResponse.success(applications));
});

const getAllApplications = asyncHandler(async(req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = status ? { status } : {};

    const result = await applicationService.getApplications(filter, parseInt(page), parseInt(limit));
    res.json(ApiResponse.success(result));
});

const updateStatus = asyncHandler(async(req, res) => {
    const { status, comment } = req.body;
    const application = await applicationService.updateApplicationStatus(
        req.params.id,
        status,
        comment,
        req.user.userId
    );
    res.json(ApiResponse.success(application, 'Application status updated'));
});

const deleteApplication = asyncHandler(async(req, res) => {
    await applicationService.deleteApplication(req.params.id);
    res.json(ApiResponse.success(null, 'Application deleted'));
});

const blockAdminReview = asyncHandler(async(req, res) => {
    const { action, rejectionReason } = req.body;
    const result = await applicationService.blockAdminReview(
        req.params.id,
        action,
        req.user.userId,
        rejectionReason,
        req.user
    );
    res.json(ApiResponse.success(result, result.message));
});

const districtAdminReview = asyncHandler(async(req, res) => {
    const { action, rejectionReason } = req.body;
    const result = await applicationService.districtAdminReview(
        req.params.id,
        action,
        req.user.userId,
        rejectionReason,
        req.user
    );
    res.json(ApiResponse.success(result, result.message));
});

const stateAdminReview = asyncHandler(async(req, res) => {
    const { action, rejectionReason } = req.body;
    const result = await applicationService.stateAdminReview(
        req.params.id,
        action,
        req.user.userId,
        rejectionReason,
        req.user
    );
    res.json(ApiResponse.success(result, result.message));
});

/**
 * Tier-agnostic approve/reject. The caller's role selects the tier, so the same
 * button works on every admin dashboard without the client needing to know which
 * stage the application currently sits at.
 */
const approveApplication = asyncHandler(async(req, res) => {
    const result = await applicationService.reviewApplication(
        req.params.id,
        'approve',
        req.user,
        null
    );
    res.json(ApiResponse.success(result, result.message));
});

const rejectApplication = asyncHandler(async(req, res) => {
    const { rejectionReason, reason } = req.body || {};
    const result = await applicationService.reviewApplication(
        req.params.id,
        'reject',
        req.user,
        rejectionReason || reason || null
    );
    res.json(ApiResponse.success(result, result.message));
});

module.exports = {
    createApplication,
    getApplication,
    getUserApplications,
    getAllApplications,
    updateStatus,
    deleteApplication,
    blockAdminReview,
    districtAdminReview,
    stateAdminReview,
    approveApplication,
    rejectApplication
};