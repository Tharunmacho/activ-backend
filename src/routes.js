const express = require('express');
const config = require('./config');

// Module routes
const authRoutes = require('./modules/auth/auth.routes');
const memberRoutes = require('./modules/members/member.routes');
const businessRoutes = require('./modules/members/business.routes');
const { browseRouter, companyRouter, membershipRouter } = require('./modules/members/memberExtras.routes');
const productRoutes = require('./modules/members/product.routes');
const applicationRoutes = require('./modules/applications/application.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const notificationRoutes = require('./modules/notifications/notification.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');
const eventRoutes = require('./modules/events/event.routes');
const announcementRoutes = require('./modules/announcements/announcement.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const regionRoutes = require('./modules/regions/region.routes');
const cmsRoutes = require('./modules/cms/cms.routes');
const paymentRoutes = require('./modules/payment/payment.routes');
const webhookRoutes = require('./modules/payment/webhook.routes');

const router = express.Router();

// Health check
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        environment: config.env
    });
});

// API routes
router.use('/auth', authRoutes);

// Public region discovery — unauthenticated, because the registration screen
// calls these before an applicant has an account.
//
// This MUST stay above the `businessRoutes` mount below. That router is mounted
// at '/' and calls `router.use(verifyToken)` internally, which turns it into a
// catch-all auth gate for every route registered after it. Mounted lower down,
// these endpoints answer 401 and the registration dropdowns come back empty.
router.use('/regions', regionRoutes);

/**
 * Public site content (hero, about, gallery, events, contact).
 *
 * Mounted here for the same reason as `/regions`: the landing page and the
 * contact form are read and submitted by visitors who have no token, and the
 * `businessRoutes` mount below applies `verifyToken` to everything registered
 * after it. Below that line these would all answer 401 and the public site
 * would render empty.
 */
router.use('/cms', cmsRoutes);

router.use('/members', memberRoutes);

/**
 * The endpoints the mobile app already ships against.
 *
 * All three sit ABOVE `businessRoutes` for the reason given above it:
 * that router gates everything registered after it, and `/membership/plans`
 * must stay readable by someone who has not signed up yet.
 */
router.use('/browse-members', browseRouter);
router.use('/companies', companyRouter);
router.use('/membership', membershipRouter);
router.use('/', businessRoutes);  // Business profile routes
router.use('/products', productRoutes);  // Products routes
router.use('/applications', applicationRoutes);
router.use('/admin', adminRoutes);
router.use('/notifications', notificationRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/events', eventRoutes);

/**
 * Association Updates (MEM-001).
 *
 * Below `businessRoutes` deliberately: unlike `/regions` and `/cms`, every one
 * of these endpoints requires a signed-in member, so the catch-all auth gate
 * that mount applies is not a hazard here. The router applies `verifyToken`
 * itself as well, so it does not depend on that ordering to be safe.
 */
router.use('/announcements', announcementRoutes);
router.use('/audit', auditRoutes);
router.use('/payment', paymentRoutes);
router.use('/webhook', webhookRoutes);

module.exports = router;