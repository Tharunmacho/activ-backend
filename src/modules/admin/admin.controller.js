const adminService = require('./admin.service');
const superAdminService = require('./superadmin.service');
const adminBulkService = require('./adminBulk.service');
// Membership pricing. Lives beside the plan model rather than here, because the
// payment path reads the same service and neither owns it.
const membershipPlanService = require('../members/membershipplan.service');
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

// --- Super admin: global, ungeofenced views and admin management ---

const getSuperOverview = asyncHandler(async(req, res) => {
    const data = await superAdminService.getOverview();
    res.json(ApiResponse.success(data));
});

const superSearch = asyncHandler(async(req, res) => {
    const data = await superAdminService.search(req.query.q);
    res.json(ApiResponse.success(data));
});

const getSuperApplications = asyncHandler(async(req, res) => {
    const data = await superAdminService.getApplications(req.query || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const listAdmins = asyncHandler(async(req, res) => {
    const data = await superAdminService.listAdmins(req.query || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const createAdmin = asyncHandler(async(req, res) => {
    const data = await superAdminService.createAdmin(req.body || {}, req.user || {});
    res.status(201).json(ApiResponse.created(data, 'Admin created'));
});

const updateAdmin = asyncHandler(async(req, res) => {
    const data = await superAdminService.updateAdmin(req.params.id, req.body || {}, req.user || {});
    res.json(ApiResponse.success(data, 'Admin updated'));
});

const getDirectory = asyncHandler(async(req, res) => {
    const data = await superAdminService.getDirectory(req.query || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const deleteAdmin = asyncHandler(async(req, res) => {
    const data = await superAdminService.deleteAdmin(req.params.id, req.user || {});
    res.json(ApiResponse.success(data, 'Admin permanently deleted'));
});

// --- Region suggestions for the admin form ---

/**
 * Region names that already exist, offered as suggestions.
 *
 * The form's region fields are free text — the Super Admin can type a brand-new
 * block and it becomes selectable for applicants on save. These suggestions
 * exist so joining an *existing* region does not depend on retyping its name
 * identically, which would split one region into two.
 */
const suggestAdminRegions = asyncHandler(async(req, res) => {
    const data = await superAdminService.suggestRegions(req.query || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

/** What deleting or deactivating an admin would do to their pending queue. */
const previewAdminRemoval = asyncHandler(async(req, res) => {
    const data = await superAdminService.previewAdminRemoval(req.params.id, req.user || {});
    res.json(ApiResponse.success(data));
});

// --- Bulk CSV onboarding ---

const bulkTemplate = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success({
        headers: adminBulkService.TEMPLATE_HEADERS,
        csv: await adminBulkService.template(),
        maxRows: adminBulkService.MAX_ROWS
    }));
});

/** Dry run: validate every row and report, without writing anything. */
const bulkValidate = asyncHandler(async(req, res) => {
    const data = await adminBulkService.validate((req.body || {}).csv);
    res.json(ApiResponse.success(data));
});

const bulkCommit = asyncHandler(async(req, res) => {
    const body = req.body || {};
    const data = await adminBulkService.commit(body.csv, req.user || {}, {
        sendEmails: body.sendEmails !== false,
        strict: body.strict === true
    });
    res.status(201).json(ApiResponse.created(data, `${data.createdCount} admin account(s) created`));
});

const getAdminProfile = asyncHandler(async(req, res) => {
    const profile = await adminService.getAdminProfile(req.user || {});
    res.json(ApiResponse.success(profile));
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

/**
 * Activate / suspend / delete a member from a tier admin's Members screen.
 *
 * `req.user` is passed through because the service geofences on it. It used to
 * be omitted, and the service had no scope check at all, so the route was
 * role-gated only: any block admin with an id could delete any member in the
 * country.
 */
const userAction = asyncHandler(async(req, res) => {
    const data = await adminService.memberAction(req.params.id, req.params.action, req.user);
    const verb = { activate: 'activated', suspend: 'suspended', delete: 'deleted' }[req.params.action] || 'updated';
    res.json(ApiResponse.success(data, `Member ${verb} successfully`));
});

const uploadAdminPhoto = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json(ApiResponse.error('No image file uploaded', 400));
    }

    const profilePhotoUrl = `/uploads/${req.file.filename}`;

    const adminHit = await require('./admin.repository').findRawByEmail(req.user.email);
    if (!adminHit) {
        return res.status(404).json(ApiResponse.error('Admin not found', 404));
    }

    await adminHit.source.handle.updateOne(
        { _id: adminHit.objectId },
        { $set: { profilePhoto: profilePhotoUrl } }
    );

    res.json(ApiResponse.success({ profilePhoto: profilePhotoUrl }, 'Profile photo uploaded successfully'));
});


// ============================================================ membership plans

/**
 * What a membership costs, and which commencement-year band earns which plan.
 *
 * These write the collection the payment path reads, so an edit here changes
 * what is taken from the card — not merely what the membership screen
 * advertises. See `membershipplan.service` for why the two must be one lookup.
 *
 * The listing returns RETIRED plans as well as active ones, because an editor
 * has to be able to see the thing they turned off in order to turn it back on.
 * Every other reader of this collection filters to active.
 */
const listMembershipPlans = asyncHandler(async(req, res) => {
    const [plans, settings] = await Promise.all([
        membershipPlanService.listAll(),
        membershipPlanService.getSettings()
    ]);

    res.json(ApiResponse.success({ plans, settings }));
});

const createMembershipPlan = asyncHandler(async(req, res) => {
    const plan = await membershipPlanService.savePlan(req.body.key, req.body, { create: true });
    res.status(201).json(ApiResponse.success(plan, 'Plan created'));
});

const updateMembershipPlan = asyncHandler(async(req, res) => {
    const plan = await membershipPlanService.savePlan(req.params.key, req.body);
    res.json(ApiResponse.success(plan, 'Plan updated'));
});

/** Takes it off every listing, keeping the record a paid membership points at. */
const retireMembershipPlan = asyncHandler(async(req, res) => {
    const plan = await membershipPlanService.retirePlan(req.params.key);
    res.json(ApiResponse.success(plan, 'Plan retired'));
});

/**
 * Delete for real, when nothing references it.
 *
 * Refused with a count when payments do — see `deletePlan`. Separate from
 * retiring rather than a flag on it, because the two have different outcomes
 * and an editor pressing Delete should not silently get a retire instead.
 */
const deleteMembershipPlan = asyncHandler(async(req, res) => {
    const result = await membershipPlanService.deletePlan(req.params.key);
    res.json(ApiResponse.success(result, `"${result.name}" deleted`));
});

const updateMembershipSettings = asyncHandler(async(req, res) => {
    const settings = await membershipPlanService.updateSettings(req.body || {});
    res.json(ApiResponse.success(settings, 'Membership settings updated'));
});

/**
 * Snap the bands into one continuous run — no gaps, no overlaps.
 *
 * Its own endpoint rather than a sequence of plan updates from the browser,
 * because the intermediate states of that sequence are exactly the ones the
 * overlap check rejects. One request, one consistent result.
 */
const alignMembershipBands = asyncHandler(async(req, res) => {
    const result = await membershipPlanService.alignBands();
    res.json(ApiResponse.success(
        result,
        result.changed
            ? `Adjusted ${result.changed} ${result.changed === 1 ? 'plan' : 'plans'}`
            : 'The bands were already continuous'
    ));
});

module.exports = {
    uploadAdminPhoto,
    getDashboardStats,
    getUsers,
    updateUserRole,
    toggleUserStatus,
    getBlockDashboard,
    getDistrictDashboard,
    getStateDashboard,
    getSuperDashboard,
    getSuperOverview,
    superSearch,
    getSuperApplications,
    listAdmins,
    createAdmin,
    updateAdmin,
    deleteAdmin,
    suggestAdminRegions,
    previewAdminRemoval,
    bulkTemplate,
    bulkValidate,
    bulkCommit,
    getDirectory,
    getAdminProfile,
    updateAdminProfile,
    getAnalytics,
    generateReport,
    userAction,
    listMembershipPlans,
    createMembershipPlan,
    updateMembershipPlan,
    retireMembershipPlan,
    updateMembershipSettings,
    alignMembershipBands,
    deleteMembershipPlan
};