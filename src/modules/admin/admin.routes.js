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

/*
 * MEMBERSHIP PRICING.
 *
 * The Super Admin owns what a membership costs and which commencement-year band
 * earns which plan. These write the collection that `paymentOrder.createOrder`
 * reads, so an edit here changes what is charged — see
 * `membershipplan.service.getPlanForPayment`.
 *
 * `/settings` is declared BEFORE `/:key` for the reason the admins block above
 * gives: Express matches in order, and a literal that arrives second is a
 * literal captured by the parameter route in front of it.
 */
router.get('/super/membership/plans', requireRole('super_admin'), controller.listMembershipPlans);
router.put('/super/membership/settings', requireRole('super_admin'), controller.updateMembershipSettings);
router.post('/super/membership/plans/align', requireRole('super_admin'), controller.alignMembershipBands);
router.post('/super/membership/plans', requireRole('super_admin'), controller.createMembershipPlan);
router.put('/super/membership/plans/:key', requireRole('super_admin'), controller.updateMembershipPlan);
router.post('/super/membership/plans/:key/retire', requireRole('super_admin'), controller.retireMembershipPlan);
router.delete('/super/membership/plans/:key', requireRole('super_admin'), controller.deleteMembershipPlan);

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

// ---------------------------------------------------------------- team hub
/**
 * The Hub, for the tiers that have a patch of their own.
 *
 * The super admin drills tiers -> regions -> applications to find where the
 * work is; a district admin needs exactly that view of their own blocks and a
 * state admin of their districts and blocks. Same handlers, same shapes — the
 * service forces the acting token's region, so there is one implementation of
 * the drill-down and one of the geofence rather than a second pair that can
 * disagree with the first.
 *
 * Everything under `/super/` above is untouched and stays super-admin only.
 */
const TEAM_ROLES = ['super_admin', 'state_admin', 'district_admin'];

router.get('/team/directory', requireRole(...TEAM_ROLES), controller.getDirectory);
router.get('/team/applications', requireRole(...TEAM_ROLES), controller.getSuperApplications);

/**
 * Staffing the regions beneath you.
 *
 * A state admin appoints the district and block admins of their state; a
 * district admin the block admins of their district. Both already carry those
 * regions' application queues, so being unable to see — let alone replace — the
 * people working them meant every staffing change went through the super admin.
 *
 * The same handlers again. `superadmin.service` answers "who may manage whom"
 * and "which region" once, from the acting token: the tier a caller may create
 * is checked on the way in (an escalation bug here would mint an account with
 * more authority than the one that made it), and the region is FORCED rather
 * than validated, so a value outside their patch cannot be expressed at all.
 *
 * Literal before parameterised, exactly as on the `/super` block above.
 */
router.get('/team/admins', requireRole(...TEAM_ROLES), controller.listAdmins);
router.get('/team/admins/regions', requireRole(...TEAM_ROLES), controller.suggestAdminRegions);
router.post('/team/admins', requireRole(...TEAM_ROLES), controller.createAdmin);
router.get('/team/admins/:id/removal-preview', requireRole(...TEAM_ROLES), controller.previewAdminRemoval);
router.put('/team/admins/:id', requireRole(...TEAM_ROLES), controller.updateAdmin);
router.delete('/team/admins/:id', requireRole(...TEAM_ROLES), controller.deleteAdmin);

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