const eventService = require('./event.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const asyncHandler = require('../../core/utils/asyncHandler');

const ADMIN_ROLES = ['block_admin', 'district_admin', 'state_admin', 'super_admin'];

/** Drafts are admin-only. The client never gets to ask for them. */
const canSeeDrafts = (req) => ADMIN_ROLES.includes(req.user?.role);

const listEvents = asyncHandler(async(req, res) => {
    const data = await eventService.listEvents(req.query || {}, canSeeDrafts(req));
    res.json(ApiResponse.success(data));
});

const getEvent = asyncHandler(async(req, res) => {
    const data = await eventService.getEvent(req.params.id, canSeeDrafts(req));
    res.json(ApiResponse.success(data));
});

/** Multer puts an uploaded banner on req.file; a plain JSON body may send a URL. */
const bodyWithBanner = (req) => {
    if (req.file?.filename) {
        return { ...req.body, bannerUrl: `/uploads/${req.file.filename}` };
    }
    return req.body || {};
};

const createEvent = asyncHandler(async(req, res) => {
    const data = await eventService.createEvent(bodyWithBanner(req), req.user || {});
    res.status(201).json(ApiResponse.created(data, 'Event created'));
});

const updateEvent = asyncHandler(async(req, res) => {
    const data = await eventService.updateEvent(req.params.id, bodyWithBanner(req));
    res.json(ApiResponse.success(data, 'Event updated'));
});

const setStatus = asyncHandler(async(req, res) => {
    const data = await eventService.setStatus(req.params.id, req.body?.status, req.user || {});
    res.json(ApiResponse.success(data, `Event ${data.status}`));
});

const deleteEvent = asyncHandler(async(req, res) => {
    const data = await eventService.deleteEvent(req.params.id, req.user || {});
    res.json(ApiResponse.success(data, 'Event deleted'));
});

module.exports = {
    listEvents,
    getEvent,
    createEvent,
    updateEvent,
    setStatus,
    deleteEvent
};
