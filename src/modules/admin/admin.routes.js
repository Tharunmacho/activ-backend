const express = require('express');
const controller = require('./admin.controller');
const { verifyToken, requireRole } = require('../../core/middleware/auth');
const upload = require('../../core/middleware/upload');

const router = express.Router();

router.use(verifyToken);

// Dashboard routes per role
router.get('/block/dashboard', requireRole('block_admin', 'super_admin'), controller.getBlockDashboard);
router.get('/district/dashboard', requireRole('district_admin', 'super_admin'), controller.getDistrictDashboard);
router.get('/state/dashboard', requireRole('state_admin', 'super_admin'), controller.getStateDashboard);
router.get('/super/dashboard', requireRole('super_admin'), controller.getSuperDashboard);

// Super admin command centre: global (ungeofenced) reads and admin management.
router.get('/super/overview', requireRole('super_admin'), controller.getSuperOverview);
router.post('/super/profile/photo', requireRole('super_admin'), upload.single('photo'), controller.uploadAdminPhoto);
router.get('/super/search', requireRole('super_admin'), controller.superSearch);
router.get('/super/applications', requireRole('super_admin'), controller.getSuperApplications);
router.get('/super/directory', requireRole('super_admin'), controller.getDirectory);
router.get('/super/admins', requireRole('super_admin'), controller.listAdmins);

// Declared before '/super/admins/:id' — Express matches in order, and a literal
// segment registered after a parameterised one is never reached.
router.get('/super/admins/regions', requireRole('super_admin'), controller.suggestAdminRegions);
router.get('/super/admins/bulk/template', requireRole('super_admin'), controller.bulkTemplate);
router.post('/super/admins/bulk/validate', requireRole('super_admin'), controller.bulkValidate);
router.post('/super/admins/bulk', requireRole('super_admin'), controller.bulkCommit);

router.post('/super/admins', requireRole('super_admin'), controller.createAdmin);
router.get('/super/admins/:id/removal-preview', requireRole('super_admin'), controller.previewAdminRemoval);
router.put('/super/admins/:id', requireRole('super_admin'), controller.updateAdmin);
router.delete('/super/admins/:id', requireRole('super_admin'), controller.deleteAdmin);

// Common Stats & User Management
router.get('/stats', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getDashboardStats);
router.get('/users', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getUsers);
router.patch('/users/:id/role', requireRole('super_admin'), controller.updateUserRole);
router.patch('/users/:id/toggle-status', requireRole('super_admin'), controller.toggleUserStatus);

// Analytics and reports, scoped to the caller's geofence
router.get('/analytics', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getAnalytics);
router.post('/reports/generate', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.generateReport);

// UserManagementScreen action buttons (activate | suspend | delete)
router.post('/users/:id/:action', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.userAction);

// The caller's own profile
router.get('/profile', controller.getAdminProfile);
router.put('/profile', controller.updateAdminProfile);

module.exports = router;