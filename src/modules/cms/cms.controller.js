const { resolveEventId } = require('../events/eventSlug');
const cmsService = require('./cms.service');
const regionPages = require('./cms.regionPages.service');
const news = require('./cms.news.service');
const schemes = require('./cms.schemes.service');
const membership = require('./cms.membership.service');
const leaderMessages = require('./cms.leaderMessages.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

// ---------------------------------------------------------------- site chrome

/**
 * The header and footer.
 *
 * Public, and public on purpose: the nav and the footer render on every page
 * including the ones a visitor sees before signing in.
 */
const getSiteSettings = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getSiteSettings()));
});

const updateSiteSettings = asyncHandler(async(req, res) => {
    const site = await cmsService.updateSiteSettings(req.body || {}, req.user || {});
    res.json(ApiResponse.success(site, 'Site settings updated'));
});

// ---------------------------------------------------------------- page copy

const getEventsSettings = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getEventsSettings()));
});

const updateEventsSettings = asyncHandler(async(req, res) => {
    const doc = await cmsService.updateEventsSettings(req.body || {}, req.user || {});
    res.json(ApiResponse.success(doc, 'Events page updated'));
});

const getGallerySettings = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getGallerySettings()));
});

const updateGallerySettings = asyncHandler(async(req, res) => {
    const doc = await cmsService.updateGallerySettings(req.body || {}, req.user || {});
    res.json(ApiResponse.success(doc, 'Gallery page updated'));
});

// ---------------------------------------------------------------- home page

const getHome = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getHome()));
});

/**
 * Update one or more of the home page's four blocks.
 *
 * Only the blocks present in the body are touched, so the CMS can save the
 * carousel without disturbing the stats someone edited a moment earlier.
 */
const updateHome = asyncHandler(async(req, res) => {
    const home = await cmsService.updateHome(req.body || {}, req.user || {});
    res.json(ApiResponse.success(home, 'Home page updated'));
});

/**
 * Upload one image or video and return its URL.
 *
 * Separate from the content save so the editor can show a real preview before
 * committing: uploading as part of the save means an admin only finds out the
 * media is wrong after the page is live.
 */
const uploadMedia = asyncHandler(async(req, res) => {
    if (!req.file) return res.status(400).json(ApiResponse.error('No file uploaded', 400));

    const mimetype = req.file.mimetype || '';
    res.status(201).json(ApiResponse.created({
        // Relative on purpose — an absolute URL built from the request host
        // points at whatever network the uploading device was on.
        url: `/uploads/${req.file.filename}`,
        type: mimetype.startsWith('video/') ? 'video' : 'image',
        size: req.file.size,
    }, 'Uploaded'));
});

// ---------------------------------------------------------------- about

const getAbout = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getAbout()));
});

const updateAbout = asyncHandler(async(req, res) => {
    const about = await cmsService.updateAbout(req.body || {}, req.user || {});
    res.json(ApiResponse.success(about, 'About section updated'));
});

/**
 * Whether this caller may see unpublished content.
 *
 * BOTH CONTENT ROLES, matching the write guard on the admin half of the router.
 * The panel signs in as `cms_admin`, so a rule of `super_admin` only meant an
 * editor could save a draft event or hide a photograph and then not see it —
 * their own work answering 404 to them.
 *
 * It is deliberately one predicate for policies, events and the gallery: three
 * inline copies is how one of them ends up a role behind the other two.
 */
const canSeeDrafts = (req) =>
    !!(req.user && ['super_admin', 'cms_admin'].includes(req.user.role));

/**
 * Events and the gallery: the content editors, plus the EVENTS ADMIN, whose
 * portal is the programme, the gallery, the news and the schemes. Kept apart
 * from `canSeeDrafts` so that role never sees a draft policy or region page.
 * (News and schemes need nothing here — they show drafts to any signed-in
 * reader already.)
 */
const canSeeEventDrafts = (req) =>
    canSeeDrafts(req) || !!(req.user && req.user.role === 'events_admin');

// ---------------------------------------------------------------- gallery

const getGallery = asyncHandler(async(req, res) => {
    // Only a signed-in content admin may see hidden images; the public grid
    // must not be able to ask for them.
    const includeHidden = canSeeEventDrafts(req) && String(req.query.includeHidden || '') === 'true';

    // `?home=true` is the landing page's strip: only what an editor flagged for
    // it, newest first, without the long fields no card on that page reads.
    const homeOnly = String(req.query.home || '') === 'true';
    const limit = Number(req.query.limit) || 0;

    res.json(ApiResponse.success(await cmsService.listGallery({ includeHidden, homeOnly, limit })));
});

/**
 * One gallery item, for the page a poster links to.
 *
 * Public, because that page is public. A hidden item answers 404 to everyone
 * but an admin, exactly as it is absent from the public list.
 */
const getGalleryItem = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(
        await cmsService.getGalleryItem(req.params.id, { includeHidden: canSeeEventDrafts(req) }),
    ));
});

const addGalleryItem = asyncHandler(async(req, res) => {
    // An uploaded file wins over a pasted URL: the admin form offers both, and
    // a file that was just uploaded is the more deliberate action.
    const payload = { ...req.body };
    if (req.file && req.file.filename) payload.imageUrl = `/uploads/${req.file.filename}`;

    const item = await cmsService.addGalleryItem(payload, req.user || {});
    res.status(201).json(ApiResponse.created(item, 'Image added to the gallery'));
});

const updateGalleryItem = asyncHandler(async(req, res) => {
    const payload = { ...req.body };
    if (req.file && req.file.filename) payload.imageUrl = `/uploads/${req.file.filename}`;

    const item = await cmsService.updateGalleryItem(req.params.id, payload, req.user || {});
    res.json(ApiResponse.success(item, 'Image updated'));
});

const deleteGalleryItem = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.deleteGalleryItem(req.params.id), 'Image removed'));
});

// ---------------------------------------------------------------- contact details

const getContactInfo = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getContactInfo()));
});

const updateContactInfo = asyncHandler(async(req, res) => {
    const info = await cmsService.updateContactInfo(req.body || {}, req.user || {});
    res.json(ApiResponse.success(info, 'Contact details updated'));
});

// ---------------------------------------------------------------- contact messages

/**
 * The public contact form.
 *
 * The response deliberately carries nothing but an id and a timestamp: this is
 * the one endpoint anyone on the internet can write to, and echoing the stored
 * document back would turn it into a reflector.
 */
const createContactMessage = asyncHandler(async(req, res) => {
    const result = await cmsService.createContactMessage(req.body || {}, {
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
    });

    res.status(201).json(ApiResponse.created(result, 'Thanks — your message has been received.'));
});

const listContactMessages = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.listContactMessages(req.query || {})));
});

const setMessageStatus = asyncHandler(async(req, res) => {
    const doc = await cmsService.setMessageStatus(req.params.id, (req.body || {}).status);
    res.json(ApiResponse.success(doc, 'Message updated'));
});

const deleteContactMessage = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.deleteContactMessage(req.params.id), 'Message deleted'));
});


// ------------------------------------------------- messages to a leader

/**
 * The fixed list of things a visitor can ask an office-bearer.
 *
 * Public, and deliberately so: the form renders it, and it is the whole of
 * what can be sent. `compose` stays on the server — the service strips it.
 */
const getLeaderMessagePurposes = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(leaderMessages.purposeOptions()));
});

const createLeaderMessage = asyncHandler(async(req, res) => {
    const result = await leaderMessages.create(req.body || {}, {
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
    });

    res.status(201).json(ApiResponse.created(
        result,
        'Thanks — your request has been recorded. Somebody will be in touch.',
    ));
});

const listLeaderMessages = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await leaderMessages.list(req.query || {})));
});

const updateLeaderMessage = asyncHandler(async(req, res) => {
    const doc = await leaderMessages.update(req.params.id, req.body || {}, req.user || {});
    res.json(ApiResponse.success(doc, 'Message updated'));
});

const deleteLeaderMessage = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await leaderMessages.remove(req.params.id), 'Message deleted'));
});
// ---------------------------------------------------------------- events

const getEvents = asyncHandler(async(req, res) => {
    /*
     * WHAT THE CMS SCREEN GETS: EVERY EVENT, INCLUDING THE SUPER ADMIN'S.
     *
     * The panel maintains the whole onboarding site, so its events screen has
     * to show what is on those screens however it got there — the programme
     * written here, and anything the super admin posted to onboarding from
     * their own screen. With drafts, because an editor who saves one has to be
     * able to find it again.
     *
     * The public caller is unchanged: no session, no drafts, and the onboarding
     * rule applied — see `listEvents`.
     */
    /*
     * `?scope=public` ASKS THE VISITOR'S QUESTION EVEN WITH A SESSION.
     *
     * The public pages send the admin's token like every other request, so a
     * signed-in super admin browsing the home page was handed the EDITOR list
     * — drafts and members-only events included — and the website's read
     * cache then served that list to the public grid, and the public list to
     * the editor, depending on which screen asked first. The pages that
     * render what a visitor sees now say so explicitly.
     */
    const editor = canSeeEventDrafts(req) && String(req.query.scope || '') !== 'public';
    res.json(ApiResponse.success(await cmsService.listEvents({
        includeDrafts: editor,
        // The join link for an online event, which is not public — see
        // `withJoinLink` in the service. Same predicate as the drafts, because
        // it is the same question: is this an editor or a visitor.
        privileged: editor,
    })));
});

/**
 * One event, for its own public page.
 *
 * Public, because that page is public. A draft or a members-only event is a
 * 404 to everyone but a super admin — exactly as it is absent from the list.
 */
const getEvent = asyncHandler(async(req, res) => {
    const editor = canSeeEventDrafts(req);
    res.json(ApiResponse.success(
        await cmsService.listEvent(await resolveEventId(req.params.id), { includeDrafts: editor, privileged: editor }),
    ));
});

const createEvent = asyncHandler(async(req, res) => {
    const payload = { ...req.body };
    if (req.file && req.file.filename) payload.imageUrl = `/uploads/${req.file.filename}`;

    const event = await cmsService.createEvent(payload, req.user || {});
    res.status(201).json(ApiResponse.created(event, 'Event created'));
});

const updateEvent = asyncHandler(async(req, res) => {
    const payload = { ...req.body };
    if (req.file && req.file.filename) payload.imageUrl = `/uploads/${req.file.filename}`;

    const event = await cmsService.updateEvent(req.params.id, payload);
    res.json(ApiResponse.success(event, 'Event updated'));
});


const deleteEvent = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.deleteEvent(req.params.id), 'Event deleted'));
});

// ---------------------------------------------------------------- legal

const getLegalDocuments = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(
        await cmsService.listLegalDocuments({ includeDrafts: canSeeDrafts(req) }),
    ));
});

/** Label and href only — what the footer draws on every page of the site. */
const getLegalLinks = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.listLegalLinks()));
});

const getLegalDocument = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(
        await cmsService.getLegalDocument(req.params.slug, { includeDrafts: canSeeDrafts(req) }),
    ));
});

const saveLegalDocument = asyncHandler(async(req, res) => {
    const doc = await cmsService.saveLegalDocument(
        req.params.slug || (req.body || {}).slug,
        req.body || {},
        req.user || {},
    );
    res.json(ApiResponse.success(doc, 'Policy saved'));
});

const getLegalRevisions = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.listLegalRevisions(req.params.slug, req.query || {})));
});

const getLegalRevision = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(
        await cmsService.getLegalRevision(req.params.slug, req.params.version),
    ));
});

const restoreLegalRevision = asyncHandler(async(req, res) => {
    const doc = await cmsService.restoreLegalRevision(
        req.params.slug, req.params.version, req.user || {},
    );
    res.json(ApiResponse.success(doc, `Restored version ${req.params.version}`));
});

const retireLegalDocument = asyncHandler(async(req, res) => {
    const doc = await cmsService.retireLegalDocument(req.params.slug, req.user || {});
    res.json(ApiResponse.success(doc, 'Policy unpublished'));
});

// ---------------------------------------------------------------- overview

const getOverview = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await cmsService.getOverview()));
});

/* ==================================================== regions and states */

/* Drafts are gated by `canSeeDrafts` above — one predicate for the whole
   controller, so previewing a policy and previewing a region page can never
   come to mean two different things. */

/** The menu. Small, cacheable, and asked for on every page load. */
const getRegionMap = asyncHandler(async(req, res) => {
    const data = await regionPages.getMap({ includeDrafts: canSeeDrafts(req) });
    res.json(ApiResponse.success(data));
});

const getRegionPage = asyncHandler(async(req, res) => {
    const data = await regionPages.getRegionPage(req.params.slug, {
        includeDrafts: canSeeDrafts(req),
    });
    res.json(ApiResponse.success(data));
});

const getStatePage = asyncHandler(async(req, res) => {
    const data = await regionPages.getStatePage(req.params.slug, {
        includeDrafts: canSeeDrafts(req),
    });
    res.json(ApiResponse.success(data));
});

/** One feed in full — what "Read All" opens. */
const getRegionFeed = asyncHandler(async(req, res) => {
    const data = await regionPages.getFeed({
        scope: 'region',
        slug: req.params.slug,
        type: req.params.type,
        offset: req.query.offset,
        limit: req.query.limit,
        includeDrafts: canSeeDrafts(req),
    });
    res.json(ApiResponse.success(data));
});

const getStateFeed = asyncHandler(async(req, res) => {
    const data = await regionPages.getFeed({
        scope: 'state',
        slug: req.params.slug,
        type: req.params.type,
        offset: req.query.offset,
        limit: req.query.limit,
        includeDrafts: canSeeDrafts(req),
    });
    res.json(ApiResponse.success(data));
});

const listRegionGallery = asyncHandler(async(req, res) => {
    const data = await regionPages.listGallery(req.query || {});
    res.json(ApiResponse.success(data));
});

const getGalleryFilters = asyncHandler(async(req, res) => {
    const data = await regionPages.galleryFilters(req.query || {});
    res.json(ApiResponse.success(data));
});

/* ---------------------------------------------------------------- admin */

/**
 * ONE page, for the editor.
 *
 * The list screen no longer carries whole documents — see `listForAdmin`
 * — so the editor asks for the one it is about to open. `null` is a valid
 * answer and means the page has not been written yet.
 */
const getRegionPageAdmin = asyncHandler(async(req, res) => {
    const data = await regionPages.getRegionPageAdmin(req.params.slug);
    res.json(ApiResponse.success(data));
});

const getStatePageAdmin = asyncHandler(async(req, res) => {
    const data = await regionPages.getStatePageAdmin(req.params.slug);
    res.json(ApiResponse.success(data));
});

/* ----------------------------------------------------------- membership */

/**
 * `includeHidden` for a signed-in editor, so a section switched off can
 * still be previewed on the page it will appear on.
 */
const getMembership = asyncHandler(async(req, res) => {
    const data = await membership.get({ includeHidden: !!req.user });
    res.json(ApiResponse.success(data));
});

const saveMembership = asyncHandler(async(req, res) => {
    const data = await membership.save(req.body || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

/* ------------------------------------------------------------- newsroom */

/**
 * `state` and `district` narrow the list; neither is everything.
 *
 * Taken from the query string rather than from the signed-in user: the
 * newsroom is a public page, most of its readers are not signed in, and the
 * filter has to travel in the URL for a link to a state’s news to mean
 * anything when it is sent to somebody.
 */
const listNews = asyncHandler(async(req, res) => {
    const data = await news.listNews({
        state: req.query.state || '',
        district: req.query.district || '',
        category: req.query.category || '',
        includeDrafts: !!req.user,
    });
    res.json(ApiResponse.success(data));
});

const getArticle = asyncHandler(async(req, res) => {
    const data = await news.getArticle(req.params.slug, { includeDrafts: !!req.user });
    res.json(ApiResponse.success(data));
});

const listSchemes = asyncHandler(async(req, res) => {
    const data = await news.listSchemes({
        state: req.query.state || '',
        district: req.query.district || '',
        includeDrafts: !!req.user,
    });
    res.json(ApiResponse.success(data));
});

const getNewsSettings = asyncHandler(async(req, res) => {
    const data = await news.getSettings();
    res.json(ApiResponse.success(data));
});

const listNewsAdmin = asyncHandler(async(req, res) => {
    const data = await news.listForAdmin();
    res.json(ApiResponse.success(data));
});

const saveArticle = asyncHandler(async(req, res) => {
    const data = await news.saveArticle(req.params.id || null, req.body || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const deleteArticle = asyncHandler(async(req, res) => {
    const data = await news.deleteArticle(req.params.id);
    res.json(ApiResponse.success(data));
});

const saveScheme = asyncHandler(async(req, res) => {
    const data = await news.saveScheme(req.params.id || null, req.body || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const deleteScheme = asyncHandler(async(req, res) => {
    const data = await news.deleteScheme(req.params.id);
    res.json(ApiResponse.success(data));
});

// ------------------------------------------------------------------ schemes

/* `includeDrafts` for a signed-in reader, the rule the newsroom follows: an
   editor previewing an unpublished scheme sees it, the public does not. */
const listSchemesPublic = asyncHandler(async(req, res) => {
    const data = await schemes.listSchemes({
        tier: String(req.query.tier || ''),
        state: String(req.query.state || ''),
        district: String(req.query.district || ''),
        includeDrafts: !!req.user,
    });
    res.json(ApiResponse.success(data));
});

const schemeStateCounts = asyncHandler(async(req, res) => {
    const data = await schemes.stateCounts({ includeDrafts: !!req.user });
    res.json(ApiResponse.success(data));
});

const getSchemeSettings = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await schemes.getSettings()));
});

const getSchemePublic = asyncHandler(async(req, res) => {
    const data = await schemes.getScheme(req.params.slug, { includeDrafts: !!req.user });
    res.json(ApiResponse.success(data));
});

const listSchemesAdmin = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await schemes.listForAdmin()));
});

const saveSchemeAdmin = asyncHandler(async(req, res) => {
    const data = await schemes.saveScheme(req.params.id || null, req.body || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const deleteSchemeAdmin = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await schemes.deleteScheme(req.params.id)));
});

const saveSchemeSettings = asyncHandler(async(req, res) => {
    const data = await schemes.saveSettings(req.body || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const saveNewsSettings = asyncHandler(async(req, res) => {
    const data = await news.saveSettings(req.body || {}, req.user || {});
    res.json(ApiResponse.success(data));
});

const listRegionPagesAdmin = asyncHandler(async(req, res) => {
    const data = await regionPages.listForAdmin();
    res.json(ApiResponse.success(data));
});

const saveRegionPage = asyncHandler(async(req, res) => {
    const data = await regionPages.saveRegionPage(req.params.slug, req.body || {}, req.user || {});
    res.json(ApiResponse.success(data, 'Region page saved'));
});

const saveStatePage = asyncHandler(async(req, res) => {
    const data = await regionPages.saveStatePage(req.params.slug, req.body || {}, req.user || {});
    res.json(ApiResponse.success(data, 'State page saved'));
});

const deleteStatePage = asyncHandler(async(req, res) => {
    const data = await regionPages.deleteStatePage(req.params.slug);
    res.json(ApiResponse.success(data, 'State page removed'));
});

module.exports = {
    getRegionMap,
    getRegionPage,
    getStatePage,
    getRegionFeed,
    getStateFeed,
    listRegionGallery,
    getGalleryFilters,
    getMembership,
    saveMembership,
    listNews,
    getArticle,
    listSchemes,
    getNewsSettings,
    listNewsAdmin,
    saveArticle,
    deleteArticle,
    saveScheme,
    deleteScheme,
    saveNewsSettings,
    listSchemesPublic, schemeStateCounts, getSchemeSettings, getSchemePublic,
    listSchemesAdmin, saveSchemeAdmin, deleteSchemeAdmin, saveSchemeSettings,
    listRegionPagesAdmin,
    getRegionPageAdmin,
    getStatePageAdmin,
    saveRegionPage,
    saveStatePage,
    deleteStatePage,
    getLegalDocuments, getLegalLinks, getLegalDocument, saveLegalDocument,
    getLegalRevisions, getLegalRevision, restoreLegalRevision, retireLegalDocument,
    getSiteSettings, updateSiteSettings,
    getEventsSettings, updateEventsSettings,
    getGallerySettings, updateGallerySettings,
    getHome, updateHome, uploadMedia,
    getAbout, updateAbout,
    getGallery, getGalleryItem, addGalleryItem, updateGalleryItem, deleteGalleryItem,
    getContactInfo, updateContactInfo,
    createContactMessage, listContactMessages, setMessageStatus, deleteContactMessage,
    getLeaderMessagePurposes, createLeaderMessage,
    listLeaderMessages, updateLeaderMessage, deleteLeaderMessage,
    getEvents, getEvent, createEvent, updateEvent, deleteEvent,
    getOverview,
};
