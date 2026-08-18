const express = require('express');
const compression = require('compression');
const morgan = require('morgan');
const config = require('./config');
const routes = require('./routes');
const setupSecurity = require('./core/middleware/security');
const { errorHandler, notFound } = require('./core/middleware/errorHandler');
const { apiLimiter } = require('./core/middleware/rateLimit');
const { performanceMonitor } = require('./core/middleware/performance');

const path = require('path');

const app = express();

// Serve uploaded images statically from /uploads folder
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Security middleware
setupSecurity(app);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// HTTP request logger
if (config.env === 'development') {
    app.use(morgan('dev'));
}

// Performance monitoring
app.use(performanceMonitor);

// Rate limiting. Auth routes are skipped here because they carry their own
// dedicated limiter - otherwise a user who simply browsed a lot could exhaust
// the shared bucket and then be unable to log in at all.
app.use('/api', (req, res, next) => {
    if (req.path.includes('/auth/')) return next();
    return apiLimiter(req, res, next);
});

// API routes
app.use(`/api/${config.apiVersion}`, routes);

// 404 handler
app.use(notFound);

// Error handler
app.use(errorHandler);

module.exports = app;