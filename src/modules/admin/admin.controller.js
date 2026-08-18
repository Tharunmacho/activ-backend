const adminService = require('./admin.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

const getDashboardStats = asyncHandler(async(req, res) => {
    const stats = await adminService.getDashboardStats();
    res.json(ApiResponse.success(stats));
});

const getUsers = asyncHandler(async(req, res) => {
    const { page = 1, limit = 20, ...filter } = req.query;
    const result = await adminService.getUsers(filter, parseInt(page), parseInt(limit));
    res.json(ApiResponse.success(result));
});

const updateUserRole = asyncHandler(async(req, res) => {
    const { role } = req.body;
    const user = await adminService.updateUserRole(req.params.id, role);
    res.json(ApiResponse.success(user, 'User role updated'));
});

const toggleUserStatus = asyncHandler(async(req, res) => {
    const user = await adminService.toggleUserStatus(req.params.id);
    res.json(ApiResponse.success(user, 'User status updated'));
});

const getBlockDashboard = asyncHandler(async(req, res) => {
    const data = await adminService.getBlockDashboard(req.user);
    res.json(ApiResponse.success(data));
});

const getDistrictDashboard = asyncHandler(async(req, res) => {
    const data = await adminService.getDistrictDashboard(req.user);
    res.json(ApiResponse.success(data));
});

const getStateDashboard = asyncHandler(async(req, res) => {
    const data = await adminService.getStateDashboard(req.user);
    res.json(ApiResponse.success(data));
});

const getSuperDashboard = asyncHandler(async(req, res) => {
    const data = await adminService.getSuperDashboard();
    res.json(ApiResponse.success(data));
});

const updateAdminProfile = asyncHandler(async(req, res) => {
    const profile = await adminService.updateAdminProfile(req.user, req.body);
    res.json(ApiResponse.success(profile, 'Admin profile updated successfully'));
});

const getAnalytics = asyncHandler(async(req, res) => {
    const data = await adminService.getAnalytics(req.user, req.query.period || 'month');
    res.json(ApiResponse.success(data));
});

const generateReport = asyncHandler(async(req, res) => {
    const data = await adminService.generateReport(req.user, req.body || {});
    res.json(ApiResponse.success(data, 'Report generated'));
});

const userAction = asyncHandler(async(req, res) => {
    const data = await adminService.userAction(req.params.id, req.params.action);
    res.json(ApiResponse.success(data, `User ${req.params.action}d successfully`));
});

module.exports = {
    getDashboardStats,
    getUsers,
    updateUserRole,
    toggleUserStatus,
    getBlockDashboard,
    getDistrictDashboard,
    getStateDashboard,
    getSuperDashboard,
    updateAdminProfile,
    getAnalytics,
    generateReport,
    userAction
};