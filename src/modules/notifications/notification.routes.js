const express = require('express');
const notificationService = require('./notification.service');
const emailService = require('./email.service');
const whatsappTemplate = require('./whatsappTemplate');
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

router.get('/reports', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./deliveryReport').report(req.query)));
}));
router.post('/history/delete-preview', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./notificationHistory').preview(req.body, req.user.userId)));
}));
router.post('/history/delete', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./notificationHistory').execute(req.body, req.user.userId)));
}));
router.post('/reports/retry-preview', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./deliveryRetry').preview(req.body, req.user.userId)));
}));
router.post('/reports/retry', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./deliveryRetry').execute(req.body, req.user.userId)));
}));
router.get('/reports/retry-status', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./deliveryRetry').status(req.get('X-Delivery-Retry-Token'), req.user.userId)));
}));

router.patch('/:id/open', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./deliveryReport').recordOpen(req.user.userId, req.params.id, req.body?.channel)));
}));

router.get('/update-preferences', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./updatePreferences').get(req.user.userId)));
}));
router.patch('/update-preferences', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./updatePreferences').update(req.user.userId, req.body)));
}));

router.post('/push/devices', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./push.service').register(req.user.userId, req.body)));
}));
router.delete('/push/devices', asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./push.service').unregister(req.user.userId, req.body?.token)));
}));
router.get('/push/status', requireRole('super_admin'), asyncHandler(async(req, res) => {
    res.json(ApiResponse.success(await require('./push.service').health()));
}));
router.post('/push/test', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const result = await require('./push.service').queueTest(req.user.userId);
    res.json(ApiResponse.success(result, 'Test queued for your signed-in devices.'));
}));

/* ------------------------------------------------------------ the member's own */

router.get('/', asyncHandler(async(req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const result = await notificationService.getUserNotifications(
        req.user.userId, parseInt(page, 10), parseInt(limit, 10), await require('../common/memberContext').resolveMemberContext(req)
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
        search: String(req.query.search || '').slice(0, 120),
        delivery: req.query.delivery,
        group: req.query.group,
        eventId: req.query.eventId,
        bookingRef: req.query.bookingRef,
        from: req.query.from,
        to: req.query.to
    });
    res.json(ApiResponse.success(result));
}));

/**
 * Every automated message about one booking — booker, participants,
 * documents — with its delivery timeline. The Super Admin bookings page's
 * per-booking panel.
 */
router.get('/logs/booking/:bookingRef', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const result = await notificationService.bookingDelivery(String(req.params.bookingRef || '').slice(0, 60));
    res.json(ApiResponse.success(result));
}));

/** Latest email / WhatsApp status for up to 200 bookings — the bookings table column. */
router.get('/delivery-summary', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const refs = String(req.query.bookingRefs || '').split(',').map((r) => r.trim()).filter(Boolean).slice(0, 200);
    const result = await notificationService.deliverySummary(refs);
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
    const publicUrl = require('../../config/publicUrl');
    const provider = whatsappTemplate.providerName();
    const usingMeta = provider === 'meta';
    const meta = config.metaCloud;
    const botbeeWebhookUrl = `${publicUrl.publicApiBase()}/notifications/botbee/webhook`;
    const metaWebhookUrl = `${publicUrl.publicApiBase()}/notifications/meta/webhook`;
    const metaMessagePath = `/${meta.apiVersion}/${meta.phoneNumberId}/messages`;

    const { accountFor, accountStatus } = require('./emailAccounts');
    const accounts = ['events', 'membership'].map(accountStatus);
    const eventAccount = accountFor('events');
    const emailStatus = {
        configured: accounts.every(account => account.configured),
        accounts,
        host: eventAccount.host || null,
        // Retain the legacy field without exposing an SMTP login name.
        user: null,
        from: eventAccount.defaultFrom,
        regionalFrom: eventAccount.useRegionalFrom,
        supportAddress: eventAccount.supportAddress
    };

    if (String(req.query.verifyEmail || '') === '1') {
        await Promise.all(accounts.map(async account => {
            account.verification = await emailService.verifyConnection(account.category);
        }));
        emailStatus.verification = {
            ok: accounts.every(account => account.verification.ok),
            configured: emailStatus.configured,
            ...(!accounts.every(account => account.verification.ok)
                ? { error: 'One or more email senders could not authenticate. Check the per-sender results.' } : {}),
        };
    }

    res.json(ApiResponse.success({
        email: emailStatus,
        whatsapp: {
            configured: whatsappTemplate.isConfigured(),
            provider,
            providerLabel: usingMeta ? 'Meta WhatsApp Cloud API' : 'BotBee',
            // Keep the existing response keys while describing the provider
            // that actually sends lifecycle messages and signed bot replies.
            baseUrl: usingMeta ? meta.baseUrl : config.botbee.baseUrl,
            templateEndpoint: usingMeta ? metaMessagePath : config.botbee.sendTemplatePath,
            textEndpoint: usingMeta ? metaMessagePath : config.botbee.sendTextPath,
            authStyle: usingMeta ? 'bearer' : config.botbee.authStyle,
            webhookConfigured: usingMeta
                ? !!(meta.webhookVerifyToken && meta.appSecret)
                : !!config.botbee.webhookVerifyToken,
            webhookUrl: usingMeta ? metaWebhookUrl : botbeeWebhookUrl,
            botbeeWebhookUrl,
            botbeeWebhookConfigured: !!config.botbee.webhookVerifyToken,
            // Retained for older callers; verification and signature readiness
            // are separate so a saved verify token cannot imply live delivery.
            metaStatusWebhookUrl: metaWebhookUrl,
            metaStatusWebhookConfigured: !!config.metaCloud.webhookVerifyToken,
            metaSignatureConfigured: !!meta.appSecret,
            instamojoWebhookUrl: publicUrl.instamojoWebhookUrl()
        }
    }));
}));

/**
 * Is email actually going out, and is the automatic retry on? The Automation
 * screens show a red banner when the mail server refuses the login.
 */
router.get('/health', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const guard = require('./deliveryGuard');
    // A fresh check when asked — the banner should not wait 15 minutes to clear.
    if (String(req.query.refresh || '') === '1') await guard.checkEmail();
    res.json(ApiResponse.success(guard.getHealth()));
}));

/**
 * "Retry all failed" — every failed message from the last `sinceHours`
 * (default 7 days, max 30) whose cause can heal, sent again one at a time.
 * Permanent failures (not on WhatsApp, address refused) are reported, not sent.
 */
router.post('/retry-failed', requireRole('super_admin'), asyncHandler(async(req, res) => {
    const guard = require('./deliveryGuard');
    const sinceHours = Math.min(Math.max(parseInt(req.body && req.body.sinceHours, 10) || 168, 1), 720);
    await guard.checkEmail();
    const summary = await guard.retryFailed({ sinceHours, auto: false, limit: 200 });
    res.json(ApiResponse.success({ ...summary, health: guard.getHealth() }));
}));

/** Send one failed row again. */
router.post('/retry/:id', requireRole('super_admin'), asyncHandler(async(req, res) => {
    // The direct row action must enforce the same current-recipient/source
    // checks as the report preview/confirm path, including unknown outcomes.
    const result = await notificationService.retryLog(req.params.id, { strict: true });
    if (!result) throw ApiError.notFound('No such notification log entry');

    const { withEffectiveStatus } = require('./deliveryQuery');
    const plain = (row) => (row && row.toObject ? row.toObject() : row);
    if (result.skipped || result.waiting) {
        return res.json(ApiResponse.success(withEffectiveStatus(plain(result.row) || {}), result.reason));
    }

    res.json(ApiResponse.success(
        withEffectiveStatus(plain(result.row) || {}),
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
        const category = req.body.category === undefined ? 'membership' : req.body.category;
        if (!['events', 'membership'].includes(category)) {
            throw ApiError.badRequest('Email category must be events or membership');
        }
        const html = emailService.buildHtmlTemplate({
            category,
            title: 'ACTIV test message',
            recipientName: 'Super Admin',
            preheader: 'Delivery test from the ACTIV platform.',
            bodyHtml: '<p style="margin:0 0 12px 0;">This is a test message from the ACTIV '
                + 'notification system. If you are reading it, outbound email is working.</p>',
            facts: [{ label: 'Sent at', value: new Date().toLocaleString('en-IN') }]
        });

        const result = await emailService.sendEmail({
            to: target, subject: 'ACTIV test message', html, category
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
            lastError: result.error,
            provider: 'smtp',
            deliveryStatus: result.mock ? undefined : (result.success ? 'accepted' : 'failed'),
            data: { emailCategory: category, ...require('../../core/utils/smtpRecipientResult').smtpLogData(result) }
        });

        return res.json(ApiResponse.success(result, result.success
            ? (result.mock ? 'Email is not configured — nothing was sent' : 'Test email accepted by SMTP. Check the recipient inbox and spam folder.')
            : `Failed: ${result.error}`));
    }

    if (channel === 'whatsapp') {
        const config = require('../../config');
        const template = String(config.botbee.templates.status || '').trim();
        if (!template || template.toLowerCase() === 'none') {
            throw ApiError.badRequest('Configure an approved membership status template before sending a WhatsApp test');
        }
        // An administrator's test may be outside the 24-hour reply window.
        // Use the same configured, approved template/provider as real notices,
        // with an explicit test marker and no claim that an account changed.
        const params = [
            'ACTIV TEST',
            'TEST ONLY - no account change',
            'this is your requested WhatsApp delivery check. No payment or membership action is required. Membership queries: member@activ.org.in. Event queries: events@activ.org.in'
        ];
        const result = await whatsappTemplate.sendTemplateMessage(target, template, params, 'en');

        await notificationService.log({
            user: req.user.userId,
            event: 'CUSTOM',
            channel: 'whatsapp',
            recipient: result.to || target,
            subject: 'ACTIV TEST - WhatsApp delivery check',
            templateId: result.template || template,
            provider: result.provider,
            status: result.success ? 'sent' : 'failed',
            deliveryStatus: result.mock ? undefined : (result.success ? 'accepted' : 'failed'),
            mock: !!result.mock,
            providerMessageId: result.messageId,
            lastError: result.error,
            data: { params, test: true }
        });

        return res.json(ApiResponse.success(result, result.success
            ? (result.mock ? 'WhatsApp is not configured — nothing was sent' : 'Test WhatsApp message sent')
            : `Failed: ${result.error}`));
    }

    throw ApiError.badRequest("channel must be 'email' or 'whatsapp'");
}));

module.exports = router;
