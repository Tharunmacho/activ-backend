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
const eventBookingRoutes = require('./modules/events/eventbooking.routes');
const announcementRoutes = require('./modules/announcements/announcement.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const regionRoutes = require('./modules/regions/region.routes');
const cmsRoutes = require('./modules/cms/cms.routes');
const paymentRoutes = require('./modules/payment/payment.routes');
const webhookRoutes = require('./modules/payment/webhook.routes');
const botbeeWebhookRoutes = require('./modules/notifications/botbeeWebhook.routes');
const messageRoutes = require('./modules/messages/message.routes');

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

/**
 * Public event bookings — the "Book Now" flow.
 *
 * Mounted here for the third time for the same reason as `/regions` and `/cms`:
 * a guest books a seat without an account, and `businessRoutes` below applies
 * `verifyToken` to everything registered after it. Below that line every
 * booking request answers 401, and the symptom is a Book Now button that does
 * nothing with no error on the page to say why.
 *
 * Distinct from `/events`, which opens with a blanket `verifyToken` and is the
 * MEMBER's own seat. See the note at the top of `eventbooking.routes.js` for
 * why the two are separate routers rather than one with exceptions in it.
 */
router.use('/event-bookings', eventBookingRoutes);

/**
 * The BotBee inbound WhatsApp webhook.
 *
 * ABOVE `businessRoutes` for exactly the reason `/regions` and `/cms` are:
 * that router is mounted at '/' and calls `verifyToken` inside itself, which
 * makes it a catch-all auth gate for everything registered after it. BotBee
 * holds no ACTIV token and never will, so mounted below this line every inbound
 * message would be answered 401 — the bot would go silent, BotBee's dashboard
 * would show failing deliveries, and nothing here would log anything, because
 * the request would never reach the handler.
 *
 * Mounted at the same prefix the member-facing notification routes use, so the
 * documented URL is one path: /api/v1/notifications/botbee/webhook. The two
 * routers do not collide — this one owns `/botbee/*` and nothing else.
 */
router.use('/notifications/botbee', botbeeWebhookRoutes);

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
// Member-to-member direct messages. Above `businessRoutes` for the same reason
// the three routers before it are — see the note there.
router.use('/messages', messageRoutes);
/**
 * ==========================================================================
 * THE GATEWAY'S WEBHOOK, ABOVE THE AUTH GATE — and it has to be above it
 * ==========================================================================
 *
 * This was mounted below `businessRoutes`, which is mounted at '/' and calls
 * `verifyToken` inside itself, so EVERYTHING registered after it is gated.
 * Instamojo posts server-to-server and carries no token, so the webhook
 * answered 401 before the handler ever ran — verified against the running
 * server with exactly the request Instamojo sends.
 *
 * That is not a cosmetic routing detail. The webhook is the ONLY thing on
 * this flow that activates a membership: the redirect the member comes back
 * on is in their own address bar and is deliberately trusted for nothing. A
 * 401 here means every real payment is taken and no membership is granted,
 * with the money gone and nothing on any screen explaining why.
 *
 * It is not "open" for being here. `processPaymentWebhook` refuses anything
 * whose HMAC-SHA1 does not verify against the account's private salt, which
 * is the check that actually belongs to this endpoint — a bearer token is a
 * check Instamojo cannot satisfy.
 */
router.use('/webhook', webhookRoutes);

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
/* `/webhook` is mounted ABOVE `businessRoutes` — see the note there. */

module.exports = router;