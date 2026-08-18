const express = require('express');
const controller = require('./application.controller');
const validators = require('./application.validators');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

const router = express.Router();

// Member routes
router.post('/', verifyToken, validators.createApplicationValidator, controller.createApplication);
router.post('/submit', verifyToken, validators.createApplicationValidator, controller.createApplication);
router.get('/my-applications', verifyToken, controller.getUserApplications);
router.get('/user/:userId', verifyToken, controller.getUserApplications);
router.get('/:id', verifyToken, controller.getApplication);

// Admin routes
router.get('/', verifyToken, requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), controller.getAllApplications);
router.patch('/:id/status', verifyToken, requireRole('block_admin', 'district_admin', 'state_admin', 'super_admin'), validators.updateStatusValidator, controller.updateStatus);

// Three-tier approval routes
router.post('/:id/block-review', verifyToken, requireRole('block_admin', 'super_admin'), controller.blockAdminReview);
router.post('/:id/district-review', verifyToken, requireRole('district_admin', 'super_admin'), controller.districtAdminReview);
router.post('/:id/state-review', verifyToken, requireRole('state_admin', 'super_admin'), controller.stateAdminReview);

// Tier-agnostic aliases: the caller's role decides which tier acts.
const ADMIN_ROLES = ['block_admin', 'district_admin', 'state_admin', 'super_admin'];
router.post('/:id/approve', verifyToken, requireRole(...ADMIN_ROLES), controller.approveApplication);
router.post('/:id/reject', verifyToken, requireRole(...ADMIN_ROLES), controller.rejectApplication);

// Super admin only
router.delete('/:id', verifyToken, requireRole('super_admin'), controller.deleteApplication);

module.exports = router;