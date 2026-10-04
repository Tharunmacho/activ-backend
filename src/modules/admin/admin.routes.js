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
const membershipDashboard = require('./adminMembershipDashboard.controller');
router.get('/super/membership/registrations', requireRole('super_admin'), membershipDashboard.overview);
router.get('/super/membership/registrations/:memberId', requireRole('super_admin'), membershipDashboard.detail);
router.post('/super/membership/registrations/:memberId/confirm', requireRole('super_admin'), membershipDashboard.confirm);
router.delete('/super/membership/registrations/:memberId', requireRole('super_admin'), membershipDashboard.remove);
router.put('/super/membership/settings', requireRole('super_admin'), controller.updateMembershipSettings);
router.post('/super/membership/plans/align', requireRole('super_admin'), controller.alignMembershipBands);
router.post('/super/membership/plans', requireRole('super_admin'), controller.createMembershipPlan);
router.put('/super/membership/plans/:key', requireRole('super_admin'), controller.updateMembershipPlan);
router.post('/super/membership/plans/:key/retire', requireRole('super_admin'), controller.retireMembershipPlan);
router.delete('/super/membership/plans/:key', requireRole('super_admin'), controller.deleteMembershipPlan);

/*
 * PLATINUM — the lifetime tier, paid at the office and GRANTED here, never
 * bought online. See `members/platinum.service`. `/search` before `/:memberId`.
 */
const platinum = require('../members/platinum.controller');
router.post('/super/membership/platinum/accounts', requireRole('super_admin'), require('../auth/auth.validators').registerValidator, platinum.createAccount);
router.get('/super/membership/platinum', requireRole('super_admin'), platinum.overview);
router.get('/super/membership/platinum/search', requireRole('super_admin'), platinum.search);
router.get('/super/membership/platinum/requests', requireRole('super_admin'), platinum.listRequests);
router.get('/super/membership/platinum/requests/:id', requireRole('super_admin'), platinum.requestDetail);
router.patch('/super/membership/platinum/requests/:id', requireRole('super_admin'), platinum.updateRequest);
router.post('/super/membership/platinum/:memberId', requireRole('super_admin'), platinum.grant);
router.delete('/super/membership/platinum/:memberId', requireRole('super_admin'), platinum.revoke);

// Declared before '/super/admins/:id' — Express matches in order, and a literal
// segment registered after a parameterised one is never reached.
router.get('/super/admins/regions', requireRole('super_admin'), controller.suggestAdminRegions);
router.get('/super/admins/bulk/template', requireRole('super_admin'), controller.bulkTemplate);
router.post('/super/admins/bulk/validate', requireRole('super_admin'), controller.bulkValidate);
router.post('/super/admins/bulk', requireRole('super_admin'), controller.bulkCommit);

// Site-staff credentials (CMS admin, events admin). Super admin only; the
// service refuses super_admin and tier-admin records whatever the id.
router.get('/super/staff-accounts', requireRole('super_admin'), controller.listStaffAccounts);
router.put('/super/staff-accounts/:id', requireRole('super_admin'), controller.updateStaffAccount);

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
// The Hub's top figures, narrowed to the caller's patch (Super Admin: everything).
router.get('/team/overview', requireRole(...TEAM_ROLES), controller.getTeamOverview);

/*
 * STAFFING IS THE SUPER ADMIN'S, AND ONLY THE SUPER ADMIN'S.
 *
 * `/team/admins` used to sit here — six routes letting a state admin appoint
 * the district and block admins of their state, and a district admin the block
 * admins of their district. The association asked for that to come back to one
 * desk, so the screen, its routes and these endpoints were removed together.
 *
 * Removing the endpoints is the half that matters. Taking the page out of the
 * rail hides a capability; a rail is not a permission boundary, and anyone who
 * knew the URL — or kept an old tab open — would still have had it.
 *
 * `/team/directory` and `/team/applications` above are untouched: those are the
 * Hub, which is reading, not staffing.
 */

// Common Stats & User Management
router.get('/stats', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getDashboardStats);
router.get('/users', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getUsers);

/*
 * MEMBERS — paid (Active), lapsed (Expired), approved-not-paid (Awaiting). Every
 * tier reads its own region; the renewal-reminder switch and "send now" are the
 * State Admin's (and the Super Admin's) alone. See `adminMembers.service`.
 * `/remind-expired` before `/:id/...`.
 */
const adminMembers = require('./adminMembers.controller');
router.get('/members', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), adminMembers.list);
router.post('/members/remind-expired', requireRole('state_admin', 'super_admin'), adminMembers.remindAllExpired);
router.patch('/members/:id/reminders', requireRole('state_admin', 'super_admin'), adminMembers.setReminders);
router.post('/members/:id/remind', requireRole('state_admin', 'super_admin'), adminMembers.remindNow);
router.patch('/users/:id/role', requireRole('super_admin'), controller.updateUserRole);
router.patch('/users/:id/toggle-status', requireRole('super_admin'), controller.toggleUserStatus);

// Analytics and reports, scoped to the caller's geofence
router.get('/analytics', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getAnalytics);
router.post('/reports/generate', requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.generateReport);

// UserManagementScreen action buttons (activate | suspend | delete)
/*
 * Block / unblock / delete a member — State and Super only.
 *
 * `adminService.memberAction` re-checks the same thing, and deliberately: this
 * gate is the route table's business and that one travels with the behaviour.
 * Listing members and opening one is unchanged for every tier — see `/users`
 * above, which is a read.
 */
router.post('/users/:id/:action', requireRole('state_admin', 'super_admin'), controller.userAction);

// The caller's own profile
router.get('/profile', controller.getAdminProfile);
router.put('/profile', controller.updateAdminProfile);

module.exports = router;
