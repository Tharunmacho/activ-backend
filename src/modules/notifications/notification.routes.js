const express = require('express');
const notificationService = require('./notification.service');
const emailService = require('./email.service');
const botbeeService = require('./botbee.service');
const regionalContacts = require('./regionalContacts.service');
const ApiResponse = require('../../core/utils/ApiResponse');
const ApiError = require('../../core/utils/ApiError');
const asyncHandler = require('../../core/utils/asyncHandler');
const { verifyToken, requireRole } = require('../../core/middleware/auth');

/**
 * The member's own notifications, plus the Super Admin's delivery oversight.
 *
 * EVERYTHING IN THIS FILE REQUIRES A TOKEN. The BotBee webhook does not and
 * cannot — it lives in `botbeeWebhook.routes.js`, mounted separately and above
 * the catch-all auth gate. Adding an unauthenticated path here would be
 * unreachable anyway; see the note at the top of that file.
 */
const router = express.Router();

router.use(verifyToken);

/* ------------------------------------------------------------ the member's own */

router.get('/', asyncHandler(async(req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const result = await notificationService.getUserNotifications(
        req.user.userId, parseInt(page, 10), parseInt(limit, 10)
    );
    res.json(ApiResponse.success(result));
}));

/*
 * `read-all` is declared BEFORE `:id/read`.
 *
 * Express matches in declaration order and `/:id/read` would happily capture
 * the literal, so `read-all` would arrive as a notification id — cast to an
 * ObjectId, fail to match anything, and silently mark nothing as read. The same
 * ordering rule the membership routes document for `/settings` before
 * `/plans/:key`.
 */
router.patch('/read-all', asyncHandler(async(req, res) => {
    await notificationService.markAllAsRead(req.user.userId);
    res.json(ApiResponse.success(null, 'All notifications marked as read'));
}));

router.patch('/:id/read', asyncHandler(async(req, res) => {
    const notification = await notificationService.markAsRead(req.user.userId, req.params.id);
    res.json(ApiResponse.success(notification));
}));

/* ---------------------------------------------------- Super Admin oversight */

/**
 * Delivery health, and the log behind it.
 *
 * Super admin only. The log holds every recipient address and phone number the
 * platform has ever messaged, so a geofenced tier admin has no business in it —
 * `requireRole` is the same gate the rest of the super-admin surface uses.
 */
router.get('/logs', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const result = await notificationService.listLogs({
        page: req.query.page,
        limit: req.query.limit,
        channel: req.query.channel,
        status: req.query.status,
        event: req.query.event,
        search: req.query.search
    });
    res.json(ApiResponse.success(result));
}));

/**
 * Is anything actually configured?
 *
 * The single most useful thing this API can tell a Super Admin, and the reason
 * it exists: a deployment with no credentials sends nothing and looks exactly
 * like one that is working, because every send resolves successfully in mock
 * mode. This reports what is wired up, so "no emails are arriving" has an answer
 * on screen instead of in a log file on the server.
 *
 * `verifyEmail=1` performs the real SMTP handshake. Off by default because it
 * costs a network round trip to the mail host on every page load.
 */
router.get('/delivery-status', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const config = require('../../config');

    const emailStatus = {
        configured: emailService.isConfigured(),
        host: config.email.host || null,
        user: config.email.user || null,
        from: config.email.defaultFrom,
        regionalFrom: config.email.useRegionalFrom,
        supportAddress: config.email.supportAddress
    };

    if (String(req.query.verifyEmail || '') === '1') {
        emailStatus.verification = await emailService.verifyConnection();
    }

    res.json(ApiResponse.success({
        email: emailStatus,
        whatsapp: {
            configured: botbeeService.isConfigured(),
            baseUrl: config.botbee.baseUrl,
            templateEndpoint: config.botbee.sendTemplatePath,
            textEndpoint: config.botbee.sendTextPath,
            authStyle: config.botbee.authStyle,
            webhookConfigured: !!config.botbee.webhookVerifyToken,
            webhookUrl: `${config.backendUrl}/api/${config.apiVersion}/notifications/botbee/webhook`
        }
    }));
}));

/** Send one failed row again. */
router.post('/retry/:id', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const result = await notificationService.retryLog(req.params.id);
    if (!result) throw ApiError.notFound('No such notification log entry');

    if (result.skipped) {
        return res.json(ApiResponse.success(result.row, result.reason));
    }

    res.json(ApiResponse.success(
        result.row,
        result.outcome.success ? 'Re-sent' : `Still failing: ${result.outcome.error}`
    ));
}));

/**
 * Who a given region's messages are routed to.
 *
 * The answer to "why did this applicant's reply go to the wrong office" — it
 * shows the resolved chain and, crucially, whether each rung is a real staffed
 * account or the derived `block.<name>@activ.org.in` fallback. A region showing
 * an unstaffed fallback is a region whose replies are going to a mailbox that
 * may not exist, and that is a staffing problem rather than a mail problem.
 */
router.get('/routing-preview', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const contact = await regionalContacts.resolveForRegion({
        state: req.query.state,
        district: req.query.district,
        block: req.query.block
    });
    res.json(ApiResponse.success(contact));
}));

/**
 * Send a real test message to a chosen address or number.
 *
 * Super admin only, and deliberately limited to email and WhatsApp — there is
 * no "test" in-app notification worth writing to somebody's bell. This is what
 * turns "I pasted the credentials" into "I watched it arrive".
 */
router.post('/test-send', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const { channel, to } = req.body || {};
    const target = String(to || '').trim();

    if (!target) throw ApiError.badRequest('A recipient (email address or phone number) is required');

    if (channel === 'email') {
        const html = emailService.buildHtmlTemplate({
            title: 'ACTIV test message',
            recipientName: 'Super Admin',
            preheader: 'Delivery test from the ACTIV platform.',
            bodyHtml: '<p style="margin:0 0 12px 0;">This is a test message from the ACTIV '
                + 'notification system. If you are reading it, outbound email is working.</p>',
            facts: [{ label: 'Sent at', value: new Date().toLocaleString('en-IN') }]
        });

        const result = await emailService.sendEmail({
            to: target, subject: 'ACTIV test message', html
        });

        await notificationService.log({
            user: req.user.userId,
            event: 'CUSTOM',
            channel: 'email',
            recipient: target,
            sender: result.sender,
            replyTo: result.replyTo,
            subject: 'ACTIV test message',
            status: result.success ? 'sent' : 'failed',
            mock: !!result.mock,
            providerMessageId: result.messageId,
            lastError: result.error
        });

        return res.json(ApiResponse.success(result, result.success
            ? (result.mock ? 'Email is not configured — nothing was sent' : 'Test email sent')
            : `Failed: ${result.error}`));
    }

    if (channel === 'whatsapp') {
        const result = await botbeeService.sendTextMessage(
            target,
            'ACTIV test message. If you are reading this, outbound WhatsApp is working.'
        );

        await notificationService.log({
            user: req.user.userId,
            event: 'CUSTOM',
            channel: 'whatsapp',
            recipient: result.to || target,
            subject: 'test-send',
            status: result.success ? 'sent' : 'failed',
            mock: !!result.mock,
            providerMessageId: result.messageId,
            lastError: result.error
        });

        return res.json(ApiResponse.success(result, result.success
            ? (result.mock ? 'WhatsApp is not configured — nothing was sent' : 'Test WhatsApp message sent')
            : `Failed: ${result.error}`));
    }

    throw ApiError.badRequest("channel must be 'email' or 'whatsapp'");
}));

module.exports = router;
