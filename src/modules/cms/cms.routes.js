const express = require('express');
const controller = require('./cms.controller');
const upload = require('../../core/middleware/upload');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { verifyToken, requireRole, optionalAuth } = require('../../core/middleware/auth');
const { publicLimiter, createRateLimiter } = require('../../core/middleware/rateLimit');

const router = express.Router();

/**
 * Uploader for CMS media.
 *
 * The shared `upload` middleware accepts images only, which is right for a
 * profile photo and wrong here: the hero and About blocks may carry a video.
 * The size limit is higher for the same reason — 5 MB is a generous photo and a
 * very short clip.
 */
const uploadsDir = path.join(__dirname, '../../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const mediaUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
            const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, `cms-${unique}${path.extname(file.originalname) || ''}`);
        },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = (file.mimetype || '').startsWith('image/') || (file.mimetype || '').startsWith('video/');
        cb(ok ? null : new Error('Only images and videos can be uploaded'), ok);
    },
});

/**
 * Content for the public onboarding site.
 *
 * Public reads and one public write (the contact form); everything else is
 * super-admin only, using the platform's existing guards rather than a second
 * auth scheme.
 *
 * MOUNT ORDER MATTERS. In `routes.js` this must be registered ABOVE the
 * business router: that one is mounted at '/' and calls `router.use(verifyToken)`
 * internally, which turns it into a catch-all auth gate for everything after
 * it. Mounted below, every public GET here would answer 401 and the landing
 * page would render empty.
 */

/**
 * Stricter than the general public limiter.
 *
 * This is the only endpoint on the platform that accepts a write from an
 * unauthenticated caller, so it is the only one worth flooding.
 */
const contactFormLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many messages sent. Please try again in a little while.',
});

// ---------------------------------------------------------------- public reads

/**
 * The header and footer render on every public page, so this must be readable
 * without a token — including on the login screen itself.
 */
router.get('/site', publicLimiter, controller.getSiteSettings);

router.get('/home', publicLimiter, controller.getHome);
router.get('/about', publicLimiter, controller.getAbout);
router.get('/contact-info', publicLimiter, controller.getContactInfo);

// The copy around the events grid and the gallery grid; the items themselves
// come from /events and /gallery below.
router.get('/events-settings', publicLimiter, controller.getEventsSettings);
router.get('/gallery-settings', publicLimiter, controller.getGallerySettings);

/**
 * `optionalAuth` rather than none: the payload differs by caller. A signed-in
 * super admin may ask for hidden gallery images and draft events; the public
 * gets neither. Without a token these behave exactly as public routes.
 */
router.get('/gallery', publicLimiter, optionalAuth, controller.getGallery);
router.get('/events', publicLimiter, optionalAuth, controller.getEvents);

// ---------------------------------------------------------------- public write

router.post('/contact-messages', contactFormLimiter, controller.createContactMessage);

// ---------------------------------------------------------------- admin

// Everything below requires a signed-in super admin.
/**
 * Content editing is open to both roles.
 *
 * `cms_admin` exists for people whose job is the public site and nothing else;
 * `super_admin` keeps access because a platform administrator locked out of the
 * content is a support ticket waiting to happen. The reverse does NOT hold —
 * nothing under `/admin` accepts `cms_admin`.
 */
router.use(verifyToken, requireRole('super_admin', 'cms_admin'));

router.get('/overview', controller.getOverview);

router.put('/site', controller.updateSiteSettings);
router.put('/home', controller.updateHome);
router.put('/events-settings', controller.updateEventsSettings);
router.put('/gallery-settings', controller.updateGallerySettings);

/**
 * Media upload for every CMS screen.
 *
 * `upload.single('file')` uses the shared multer config, which stores to
 * `backend/uploads` and rejects anything that is not an image. Video needs a
 * dedicated uploader — see the note in `mediaUpload`.
 */
router.post('/media', mediaUpload.single('file'), controller.uploadMedia);
router.put('/about', controller.updateAbout);
router.put('/contact-info', controller.updateContactInfo);

// `upload.single('image')` so the admin can attach a file instead of pasting a
// URL; the controller prefers the upload when both are present.
router.post('/gallery', upload.single('image'), controller.addGalleryItem);
router.put('/gallery/:id', upload.single('image'), controller.updateGalleryItem);
router.delete('/gallery/:id', controller.deleteGalleryItem);

router.post('/events', upload.single('image'), controller.createEvent);
router.put('/events/:id', upload.single('image'), controller.updateEvent);
router.delete('/events/:id', controller.deleteEvent);

router.get('/contact-messages', controller.listContactMessages);
router.patch('/contact-messages/:id/status', controller.setMessageStatus);
router.delete('/contact-messages/:id', controller.deleteContactMessage);

module.exports = router;
