const express = require('express');
const config = require('./config');

// Module routes
const authRoutes = require('./modules/auth/auth.routes');
const memberRoutes = require('./modules/members/member.routes');
const businessRoutes = require('./modules/members/business.routes');
const productRoutes = require('./modules/members/product.routes');
const applicationRoutes = require('./modules/applications/application.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const notificationRoutes = require('./modules/notifications/notification.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');
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
router.use('/members', memberRoutes);
router.use('/', businessRoutes);  // Business profile routes
router.use('/products', productRoutes);  // Products routes
router.use('/applications', applicationRoutes);
router.use('/admin', adminRoutes);
router.use('/notifications', notificationRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/payment', paymentRoutes);
router.use('/webhook', webhookRoutes);

module.exports = router;