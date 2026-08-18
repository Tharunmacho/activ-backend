const express = require('express');
const controller = require('./admin.controller');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

router.use(verifyToken);

// Dashboard routes per role
router.get('/block/dashboard', requireRole('block_admin', 'super_admin'), controller.getBlockDashboard);
router.get('/district/dashboard', requireRole('district_admin', 'super_admin'), controller.getDistrictDashboard);
router.get('/state/dashboard', requireRole('state_admin', 'super_admin'), controller.getStateDashboard);
router.get('/super/dashboard', requireRole('super_admin'), controller.getSuperDashboard);

// Common Stats & User Management
router.get('/stats', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getDashboardStats);
router.get('/users', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getUsers);
router.patch('/users/:id/role', requireRole('super_admin'), controller.updateUserRole);
router.patch('/users/:id/toggle-status', requireRole('super_admin'), controller.toggleUserStatus);

// Analytics and reports, scoped to the caller's geofence
router.get('/analytics', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getAnalytics);
router.post('/reports/generate', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.generateReport);

// UserManagementScreen action buttons (activate | suspend | delete)
router.post('/users/:id/:action', requireRole('super_admin'), controller.userAction);

// Profile update
router.put('/profile', controller.updateAdminProfile);

module.exports = router;