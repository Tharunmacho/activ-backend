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
const uploadStore = require('./core/storage/uploadStore');
const { serveFromBucket, serveFromDatabase, persistUploadsMiddleware } = uploadStore;
const { makeVariantMiddleware } = require('./core/storage/imageVariants');

const app = express();

// Trust reverse proxy for X-Forwarded-For (Caddy/Nginx)
app.set('trust proxy', 1);

// Serve uploaded images statically from /uploads folder — then from the S3
// bucket, then from the database, when the disk copy is gone, which on the
// deployed container is after every deploy. See `core/storage/uploadStore.js`.
// `?w=800` asks for a resized WebP of the same upload — see `imageVariants`.
// First, so a sized request never downloads the full original.
app.use('/uploads', makeVariantMiddleware({
    uploadsDir: uploadStore.UPLOADS_DIR,
    objectStore: uploadStore.objectStore,
    bucket: uploadStore.bucket
}));
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
    // Unique names, never reused: a month, and no re-check on every visit.
    maxAge: '30d',
    immutable: true
}));
app.use('/uploads', serveFromBucket);
app.use('/uploads', serveFromDatabase);
// Last: the retired server that still holds files uploaded to it. A hit is
// written to the bucket on the way through — see core/storage/legacyUploads.js.
app.use('/uploads', uploadStore.serveFromLegacy);

// Every successful upload is copied into the S3 bucket (GridFS if the bucket
// refuses it), whichever router's multer received it.
app.use(persistUploadsMiddleware);

// Security middleware
setupSecurity(app);

// Body parsing middleware
app.use(express.json({
    limit: '10mb',
    /*
     * Meta signs its webhook over the RAW bytes (X-Hub-Signature-256), which a
     * parsed-and-restringified body does not reproduce. Kept for that one path
     * only, so no other request carries a second copy of its body.
     */
    verify: (req, res, buf) => {
        if (String(req.originalUrl || '').includes('/notifications/meta/webhook')) req.rawBody = buf;
    }
}));
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
    // The server's own cache warm-up (a per-process secret, see publicCache)
    // is not a visitor and must not spend the loopback address's quota.
    if (require('./core/middleware/publicCache').isWarmRequest(req)) return next();
    return apiLimiter(req, res, next);
});

// A successful write anywhere empties the public read cache, so an editor's
// save is on the next read. See `core/middleware/publicCache.js`.
app.use(`/api/${config.apiVersion}`, require('./core/middleware/publicCache').clearOnWrite);

// API routes
app.use(`/api/${config.apiVersion}`, routes);

// 404 handler
app.use(notFound);

// Error handler
app.use(errorHandler);

module.exports = app;