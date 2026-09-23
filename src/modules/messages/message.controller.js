const asyncHandler = require('../../core/utils/asyncHandler');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const messageService = require('./message.service');

/**
 * Direct messages, HTTP edge.
 *
 * Every handler resolves the caller from the TOKEN and never from the body or
 * the query. A `senderId` a client could supply is a client that can send as
 * somebody else, and this is the one feature in the product where that would
 * put words in another member's mouth.
 */

const callerId = (req) => String((req.user || {}).userId || (req.user || {}).id || '');

const requireCaller = (req) => {
    const id = callerId(req);
    if (!id) throw ApiError.unauthorized('No member on this token');
    return id;
};

const listConversations = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await messageService.listConversations(requireCaller(req))));
});

/** Open (or start) the thread with one member. */
const openWith = asyncHandler(async(req, res) => {
    const conversation = await messageService.openWith(requireCaller(req), req.params.memberId);
    res.json(ApiResponse.success(conversation));
});

const listMessages = asyncHandler(async(req, res) => {
    const { before, limit } = req.query;
    res.json(ApiResponse.success(
        await messageService.listMessages(req.params.id, requireCaller(req), { before, limit }),
    ));
});

const send = asyncHandler(async(req, res) => {
    const message = await messageService.send(
        req.params.id,
        requireCaller(req),
        req.body?.body,
        req.body?.attachmentUrl,
    );
    res.status(201).json(ApiResponse.success(message, 'Message sent'));
});

/**
 * Store a picture and hand back its url. IT SENDS NOTHING.
 *
 * Two calls rather than one multipart send, which is how every other picture in
 * this product is written. It also keeps the send atomic: a multipart send that
 * failed its membership check AFTER the file had landed would leave the upload
 * orphaned on disk with no message pointing at it.
 *
 * The file is guarded by the shared `upload` middleware — images only, five
 * megabytes, and a filename the client does not choose.
 */
const uploadAttachment = asyncHandler(async(req, res) => {
    requireCaller(req);
    if (!req.file) throw ApiError.badRequest('No picture was uploaded');
    res.status(201).json(ApiResponse.success(
        { url: `/uploads/${req.file.filename}` },
        'Picture uploaded',
    ));
});

const markRead = asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await messageService.markRead(req.params.id, requireCaller(req))));
});

const unreadCount = asyncHandler(async(req, res) => {
    const count = await messageService.unreadCount(requireCaller(req));
    res.json(ApiResponse.success({ unread: count }));
});

module.exports = {
    listConversations,
    openWith,
    listMessages,
    send,
    uploadAttachment,
    markRead,
    unreadCount,
};
