const express = require('express');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken, requireRole } = require('../../core/middleware/auth');
const { createRateLimiter } = require('../../core/middleware/rateLimit');
const { liveService, CHECKIN_STAFF } = require('./eventcheckin.service');
const pass = require('./eventPass');

/**
 * /api/v1/event-checkin — the door.
 *
 * TWO HALVES, and only one of them is public:
 *
 *   GET  /pass/:token        public  what a stranger's camera may learn: that
 *                                    this is an ACTIV pass, the event, valid or
 *                                    not. No name, no reference. Never writes.
 *   GET  /qr/:token.png      public  the QR image itself, for the pass page
 *                                    (the email embeds its own copy by CID)
 *
 *   GET  /events             staff   events to check in, with counts
 *   POST /lookup             staff   { token | registrationNo | bookingRef [+ participantIndex], eventId? }
 *   POST /admit              staff   same body — lets one seat in (idempotent)
 *   POST /:token/admit       staff   the QR form of the same
 *
 * Staff = `super_admin`, `events_admin` and `attendance_admin` (the mobile
 * app's door account). Mounted ABOVE `businessRoutes` in
 * routes.js: that router is a catch-all `verifyToken` for everything after it,
 * which would put the public pass page behind a sign-in.
 */
const router = express.Router();

const publicLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 300 });
/* A door team scans fast: several hundred passes an hour from one phone is normal. */
const staffLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 3000 });

router.get('/pass/:token', publicLimiter, asyncHandler(async(req, res) => {
    const data = await liveService().publicPass(req.params.token);
    res.set('Cache-Control', 'no-store');
    res.json(ApiResponse.success(data));
}));

router.get('/qr/:file', publicLimiter, asyncHandler(async(req, res) => {
    const token = String(req.params.file || '').replace(/\.png$/i, '');
    // Only a genuine pass is drawn: this must not become a free QR generator.
    if (!pass.verifyPass(token)) throw ApiError.notFound('Not a valid pass');
    const QRCode = require('qrcode');
    const png = await QRCode.toBuffer(pass.passUrl(token), {
        type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' }
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
}));

const staff = [staffLimiter, verifyToken, requireRole(...CHECKIN_STAFF)];

/** The scanning device, as the app describes itself — audit trail only. */
const deviceOf = (req) => String((req.body && req.body.device) || req.headers['user-agent'] || '').slice(0, 120);

router.get('/events', ...staff, asyncHandler(async(req, res) => {
    const scope = req.query.scope === 'past' ? 'past' : 'upcoming';
    res.json(ApiResponse.success(await liveService().listCheckinEvents({ scope })));
}));

router.post('/lookup', ...staff, asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await liveService().lookup(req.body || {})));
}));

const admitHandler = (fromParam) => asyncHandler(async(req, res) => {
    const body = { ...(req.body || {}) };
    if (fromParam) body.token = req.params.token;
    const result = await liveService().admit(body, req.user || {}, {
        device: deviceOf(req),
        method: body.method
    });
    res.json(ApiResponse.success(
        result,
        result.outcome === 'admitted' ? 'Entry allowed' : 'Already checked in'
    ));
});

router.post('/admit', ...staff, admitHandler(false));
router.post('/:token/admit', ...staff, admitHandler(true));

module.exports = router;
