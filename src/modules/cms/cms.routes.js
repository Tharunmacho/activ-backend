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

/*
 * ================================================ regions and states
 *
 * LITERALS BEFORE PARAMETERS, as Express matches in declaration order.
 * `/regions/map` must be registered above `/regions/:slug` or the parameter
 * route captures the word "map" and the menu asks for a region that does not
 * exist. The same trap `/membership/settings` documents.
 *
 * `optionalAuth` on every one: a public visitor gets published content, and a
 * signed-in super admin gets drafts too, so Preview is the same URL rather than
 * a second code path that can disagree with the real page.
 */
router.get('/regions/map', publicLimiter, optionalAuth, controller.getRegionMap);
router.get('/regions/gallery', publicLimiter, controller.listRegionGallery);
router.get('/regions/gallery/filters', publicLimiter, controller.getGalleryFilters);
router.get('/regions/:slug/feed/:type', publicLimiter, optionalAuth, controller.getRegionFeed);
router.get('/regions/:slug', publicLimiter, optionalAuth, controller.getRegionPage);
router.get('/states/:slug/feed/:type', publicLimiter, optionalAuth, controller.getStateFeed);
router.get('/states/:slug', publicLimiter, optionalAuth, controller.getStatePage);
router.get('/gallery-settings', publicLimiter, controller.getGallerySettings);

/**
 * `optionalAuth` rather than none: the payload differs by caller. A signed-in
 * super admin may ask for hidden gallery images and draft events; the public
 * gets neither. Without a token these behave exactly as public routes.
 */
router.get('/gallery', publicLimiter, optionalAuth, controller.getGallery);
/**
 * One gallery item, for the page a poster on the landing page links to.
 *
 * Public — it is where a visitor who clicked a poster lands, and requiring a
 * token would 401 the click. The write methods on the same path stay below the
 * guard: Express matches on method as well as path, so a GET here and a
 * PUT/DELETE there do not collide.
 */
router.get('/gallery/:id', publicLimiter, optionalAuth, controller.getGalleryItem);
router.get('/events', publicLimiter, optionalAuth, controller.getEvents);
/**
 * One event, for the page an events card links to.
 *
 * Public for the same reason `/gallery/:id` is: it is where a visitor who
 * clicked a card lands, and the write methods on this path stay below the guard
 * — Express matches on method as well as path.
 */
router.get('/events/:id', publicLimiter, optionalAuth, controller.getEvent);

/**
 * The legal documents — Privacy, Terms, Return, Cancellation.
 *
 * PUBLIC READS, and they have to be: the footer draws these links on every page
 * of the site, including the ones an anonymous visitor lands on first, and the
 * policy pages themselves are what a visitor is sent to before agreeing to
 * anything. Below the admin guard they would 401 and the footer would lose its
 * legal row with nothing on screen to explain it.
 *
 * `optionalAuth` so a signed-in editor sees their own DRAFTS here, while the
 * public sees published documents only. Without it an editor previewing an
 * unpublished policy would get a 404 on the page they had just saved.
 *
 * `/legal/links` is declared ABOVE `/legal/:slug` — Express matches in order,
 * and a literal behind a parameter route is a literal the parameter captures.
 * The same trap `/settings` before `/plans/:key` carries a note about.
 */
router.get('/legal', publicLimiter, optionalAuth, controller.getLegalDocuments);
router.get('/legal/links', publicLimiter, controller.getLegalLinks);
router.get('/legal/:slug', publicLimiter, optionalAuth, controller.getLegalDocument);

/**
 * ----------------------------------------------------------- the newsroom
 *
 * PUBLIC READS. The newsroom is a page on the public site, and most of the
 * people who open it have never signed in.
 *
 * `optionalAuth` so a signed-in editor sees their own DRAFTS here, and the
 * public sees published articles only — the rule the legal documents
 * already follow. Without it, previewing an unpublished article 404s on the
 * page the editor has just saved.
 *
 * `/news/schemes` and `/news/settings` are declared ABOVE `/news/:slug`.
 * Express matches in order, and a literal behind a parameter route is a
 * literal the parameter captures — the same trap `/legal/links` carries a
 * note about, and the one that would make the schemes list resolve as an
 * article called "schemes".
 */
/**
 * The membership prospectus. PUBLIC, like every other page’s copy, and
 * `optionalAuth` so an editor previewing a switched-off section sees it.
 */
router.get('/membership', publicLimiter, optionalAuth, controller.getMembership);

router.get('/news', publicLimiter, optionalAuth, controller.listNews);
router.get('/news/schemes', publicLimiter, optionalAuth, controller.listSchemes);
router.get('/news/settings', publicLimiter, controller.getNewsSettings);
router.get('/news/:slug', publicLimiter, optionalAuth, controller.getArticle);

/*
 * THE SCHEMES PAGE. Public, `optionalAuth` so an editor sees drafts.
 * `/schemes/states` and `/schemes/settings` sit ABOVE `/schemes/:slug` for the
 * reason given over the news routes: a literal behind a parameter route is a
 * literal the parameter captures.
 */
router.get('/schemes', publicLimiter, optionalAuth, controller.listSchemesPublic);
router.get('/schemes/states', publicLimiter, optionalAuth, controller.schemeStateCounts);
router.get('/schemes/settings', publicLimiter, controller.getSchemeSettings);
router.get('/schemes/:slug', publicLimiter, optionalAuth, controller.getSchemePublic);

// ---------------------------------------------------------------- public write

router.post('/contact-messages', contactFormLimiter, controller.createContactMessage);

/*
 * A message addressed to an office-bearer.
 *
 * The SAME limiter as the contact form, on purpose: both are endpoints any
 * stranger can write to, and the leader form is the more attractive of the
 * two to abuse because each message names a real person.
 *
 * The purposes are a public read because the form cannot be drawn without
 * them, and they are the complete list of what can be sent — see the note
 * in `cms.leaderMessages.service`.
 */
router.get('/leader-messages/purposes', publicLimiter, controller.getLeaderMessagePurposes);
router.post('/leader-messages', contactFormLimiter, controller.createLeaderMessage);

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
/*
 * THE EVENT EDITOR, OPEN TO THE EVENTS ADMIN AS WELL — and declared ABOVE the
 * content gate below, which would otherwise refuse that role on every one.
 *
 * The events admin is a separate account whose whole portal is the programme
 * (see `event.routes.js`). It edits events through the same screen and the
 * same endpoints as the super admin and the CMS — one write path, so nothing
 * about an event can differ by who saved it — and reaches no other content.
 * `/media` is here because the event form uploads its banner and speaker
 * photos through it.
 */
const eventEditors = [verifyToken, requireRole('super_admin', 'cms_admin', 'events_admin')];
router.post('/events', ...eventEditors, upload.single('image'), controller.createEvent);
router.put('/events/:id', ...eventEditors, upload.single('image'), controller.updateEvent);
router.delete('/events/:id', ...eventEditors, controller.deleteEvent);
router.put('/events-settings', ...eventEditors, controller.updateEventsSettings);
router.post('/media', ...eventEditors, mediaUpload.single('file'), controller.uploadMedia);
/*
 * An EVENT DOCUMENT — agenda, brochure, slides, form: any common office,
 * PDF, text, image or archive file up to 20 MB (the practical ceiling for an
 * email attachment). Its own uploader so the image-and-video rule above stays
 * as strict as it is for banners.
 */
const DOCUMENT_TYPES = /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-(excel|powerpoint)|vnd\.oasis\.opendocument\.[a-z.]+|zip|x-zip-compressed|rtf)|text\/(plain|csv)|image\/)/i;
const attachmentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadsDir),
        filename: (req, file, cb) => {
            const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
            cb(null, `doc-${unique}${path.extname(file.originalname) || ''}`);
        },
    }),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = DOCUMENT_TYPES.test(file.mimetype || '');
        cb(ok ? null : new Error('That file type cannot be attached. Use PDF, Word, Excel, PowerPoint, text, image or ZIP.'), ok);
    },
});
router.post('/attachments', ...eventEditors, attachmentUpload.single('file'), controller.uploadAttachment);

/*
 * THE GALLERY, THE NEWSROOM AND THE SCHEMES — open to the events admin too,
 * and declared ABOVE the content gate for the same reason the event editor is.
 *
 * The events admin's portal mounts the CMS's own Gallery, News and Schemes
 * screens (see `/events-admin/*` in the website's App.tsx), so a photograph,
 * an article or a scheme is written through ONE path whichever portal saved
 * it. Everything else under the gate — the site settings, home, about,
 * legal, region pages, contact inbox — stays closed to that role.
 */
const contentEditors = [verifyToken, requireRole('super_admin', 'cms_admin', 'events_admin')];

// `upload.single('image')` so the admin can attach a file instead of pasting a
// URL; the controller prefers the upload when both are present.
router.post('/gallery', ...contentEditors, upload.single('image'), controller.addGalleryItem);
router.put('/gallery/:id', ...contentEditors, upload.single('image'), controller.updateGalleryItem);
router.delete('/gallery/:id', ...contentEditors, controller.deleteGalleryItem);
router.put('/gallery-settings', ...contentEditors, controller.updateGallerySettings);

/* The newsroom's own screen. `/news-admin` and not `/news`, so no write
   method here can be shadowed by the public parameter route above. */
router.get('/news-admin', ...contentEditors, controller.listNewsAdmin);
router.post('/news-admin/articles', ...contentEditors, controller.saveArticle);
router.put('/news-admin/articles/:id', ...contentEditors, controller.saveArticle);
router.delete('/news-admin/articles/:id', ...contentEditors, controller.deleteArticle);
router.post('/news-admin/schemes', ...contentEditors, controller.saveScheme);
router.put('/news-admin/schemes/:id', ...contentEditors, controller.saveScheme);
router.delete('/news-admin/schemes/:id', ...contentEditors, controller.deleteScheme);
router.put('/news-admin/settings', ...contentEditors, controller.saveNewsSettings);

/* The Schemes screen. `/schemes-admin`, not `/schemes`, for the same reason
   the newsroom's is `/news-admin`. The `/news-admin/schemes` routes above stay
   for any older client, and write the same shape through the same cleaner. */
router.get('/schemes-admin', ...contentEditors, controller.listSchemesAdmin);
router.post('/schemes-admin/schemes', ...contentEditors, controller.saveSchemeAdmin);
router.put('/schemes-admin/schemes/:id', ...contentEditors, controller.saveSchemeAdmin);
router.delete('/schemes-admin/schemes/:id', ...contentEditors, controller.deleteSchemeAdmin);
router.put('/schemes-admin/settings', ...contentEditors, controller.saveSchemeSettings);

router.use(verifyToken, requireRole('super_admin', 'cms_admin'));

router.get('/overview', controller.getOverview);

router.put('/site', controller.updateSiteSettings);
router.put('/home', controller.updateHome);

/**
 * Media upload for every CMS screen.
 *
 * `upload.single('file')` uses the shared multer config, which stores to
 * `backend/uploads` and rejects anything that is not an image. Video needs a
 * dedicated uploader — see the note in `mediaUpload`.
 */
router.put('/about', controller.updateAbout);
router.put('/contact-info', controller.updateContactInfo);

/*
 * Editing a policy.
 *
 * `PUT /legal/:slug` both creates and replaces — an upsert on the slug, which
 * is the document's identity. A separate POST would need its own slug
 * validation and its own duplicate handling, and the two would drift.
 *
 * The revision routes are read-only except `restore`, which is itself a save:
 * history is written by saving, never edited directly. A history somebody can
 * edit is not a history.
 *
 * `/revisions` sits under the slug, so no literal competes with `:slug` here.
 */
router.get('/legal/:slug/revisions', controller.getLegalRevisions);
router.get('/legal/:slug/revisions/:version', controller.getLegalRevision);
router.post('/legal/:slug/revisions/:version/restore', controller.restoreLegalRevision);
router.put('/legal/:slug', controller.saveLegalDocument);
// Unpublishes. A policy someone agreed to at a URL is never deleted — see
// `retireLegalDocument`.
router.delete('/legal/:slug', controller.retireLegalDocument);

/*
 * The Regions & States editor.
 *
 * `PUT` both creates and replaces, keyed on the region or the state — there are
 * five regions and thirty-six states and all of them are known in advance, so
 * "does a page exist yet" is not a question an editor should be asked. A
 * separate POST would need its own duplicate handling, and the two would drift.
 */
/*
 * A DIFFERENT PREFIX, not `/regions/pages`.
 *
 * The public `GET /regions/:slug` is declared above the auth guard, and Express
 * matches in declaration order across the whole router — so `/regions/pages`
 * would be captured by the parameter route, resolve as the region named
 * "pages", and 404 before it ever reached the guard. The admin half therefore
 * lives on its own nouns, where no parameter can swallow it.
 */
router.get('/region-pages', controller.listRegionPagesAdmin);
/* Declared after the list. Both are literals at different depths, so
   neither captures the other; `:slug` is a region key or `national`. */
router.get('/region-pages/:slug', controller.getRegionPageAdmin);
router.get('/state-pages/:slug', controller.getStatePageAdmin);
router.put('/region-pages/:slug', controller.saveRegionPage);
router.put('/state-pages/:slug', controller.saveStatePage);
router.delete('/state-pages/:slug', controller.deleteStatePage);

router.put('/membership', controller.saveMembership);


router.get('/contact-messages', controller.listContactMessages);
router.patch('/contact-messages/:id/status', controller.setMessageStatus);
router.delete('/contact-messages/:id', controller.deleteContactMessage);

router.get('/leader-messages', controller.listLeaderMessages);
router.patch('/leader-messages/:id', controller.updateLeaderMessage);
router.delete('/leader-messages/:id', controller.deleteLeaderMessage);

module.exports = router;
