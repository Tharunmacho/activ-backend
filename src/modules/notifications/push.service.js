const crypto = require('node:crypto');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const Device = require('./pushDevice.model');
const Notification = require('./notification.model');
const Broadcast = require('./contentBroadcast');
let firebase;
let timer;
let running = false;

function isConfigured() {
    return process.env.PUSH_ENABLED === 'true' && !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS);
}
function messaging() {
    if (!firebase) {
        const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
        const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
            ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault();
        const app = initializeApp({ credential, ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {}) }, 'activ-push');
        firebase = require('firebase-admin/messaging').getMessaging(app);
    }
    return firebase;
}
function validToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (token.length < 20 || token.length > 4096 || /\s/.test(token)) throw ApiError.badRequest('A valid device push token is required.');
    return token;
}
async function register(user, body = {}) {
    const token = validToken(body.token);
    if (!['android', 'ios', 'web'].includes(body.platform)) throw ApiError.badRequest('Choose Android, iOS or web.');
    // A shared phone belongs to its currently signed-in account only.
    await Device.findOneAndUpdate({ token }, { $set: { user, token, platform: body.platform, enabled: body.enabled !== false, lastSeenAt: new Date() } }, { upsert: true });
    await require('./visitorPush.models').VisitorDevice.updateMany({ token }, { $set: { enabled: false }, $unset: { token: 1 } });
    const older = await Device.find({ user }).sort({ lastSeenAt: -1 }).skip(20).select('_id').lean();
    if (older.length) await Device.deleteMany({ user, _id: { $in: older.map(d => d._id) } });
    return { registered: true, configured: isConfigured() };
}
async function unregister(user, token) {
    await Device.deleteOne({ user, token: validToken(token) });
    return { removed: true };
}
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
function payload(notification, device) {
    const data = { notificationId: String(notification._id), userId: String(notification.user) };
    for (const key of ['kind', 'event', 'sourceId', 'eventId', 'announcementId', 'conversationId', 'messageId', 'orderId', 'bookingRef', 'slug']) {
        if (notification.data?.[key]) data[key] = String(notification.data[key]).slice(0, 300);
    }
    // Data-only web messages let the worker check the current account before display.
    // A notification payload would be displayed automatically, even after logout.
    if (device.platform === 'web') return { token: device.token, data,
        webpush: { headers: { TTL: '86400', Urgency: 'high' } } };
    return { token: device.token, notification: { title: 'ACTIV', body: 'Dear member, you have an update from ACTIV. Open the app to view it.' }, data,
        android: { priority: 'high', ttl: 86400000, notification: { channelId: 'activ_updates', sound: 'default', icon: 'ic_notification', tag: String(notification._id), visibility: 'private' } },
        apns: { headers: { 'apns-priority': '10', 'apns-collapse-id': String(notification._id), 'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400) },
            payload: { aps: { sound: 'default' } } } };
}
async function stillVisible(row) {
    // Do not use the feed cache: a block, expiry, region change or logout must
    // take effect before a queued alert is handed to Firebase.
    const member = await require('../members/memberdetails.model').findById(row.user).lean();
    if (!member) {
        if (row.data?.sourceId || row.data?.kind === 'message') return false;
        const admin = await require('../admin/admin.repository').findById(String(row.user));
        return !!admin?.active;
    }
    if (member.isActive === false || member.deletedAt) return false;
    const { memberAccess, paidMembership } = require('../common/memberAudience');
    if (!row.data?.sourceId && row.data?.kind !== 'message') {
        const reason = await require('./retryEligibility').reasonToSkip({ ...row, event: row.data?.event }, { throwOnReadError: true });
        return !reason;
    }
    // Match payment reconciliation without mutating membership from this
    // worker. A failed read throws, so the queued push retries instead of
    // treating an unverifiable receipt as paid (or permanently skipping it).
    const ref = String(member.paymentId || '');
    const checkReceipt = ['active', 'completed'].includes(String(member.membershipStatus || '').toLowerCase()) && /^(pay_|OFF-)/.test(ref);
    const missingReceipt = checkReceipt && !await require('../payment/paymentorder.model').exists({
        $or: [{ gatewayPaymentId: ref }, { orderId: ref }], status: 'paid',
    });
    const profile = missingReceipt ? { ...member, membershipStatus: 'pending' } : member;
    const context = { ...member, ...memberAccess({ ...profile, ...await paidMembership(profile) }) };
    if (row.data?.kind === 'message') {
        if (!context.canNetwork || !row.data.conversationId) return false;
        const { Message, Conversation } = require('../messages/message.model');
        if (row.data.messageId && !await Message.exists({ _id: row.data.messageId, deletedAt: null, hiddenFor: { $ne: row.user } })) return false;
        return !!await Conversation.exists({ _id: row.data.conversationId, participants: row.user });
    }
    const model = Broadcast.sourceModel(row.data.kind);
    if (!model) return false;
    const source = await model.findById(row.data.sourceId).lean();
    if (!source || (row.data.broadcastKey && Broadcast.sourceKey(row.data.kind, source) !== row.data.broadcastKey)) return false;
    if (row.data.kind === 'announcement' && !require('../announcements/announcementChannels').enabled(source, 'push')) return false;
    return Broadcast.visibleTo(row.data.kind, source, context);
}
const invalidTokenCodes = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const transientCodes = new Set(['messaging/internal-error', 'messaging/server-unavailable', 'messaging/unknown-error', 'messaging/quota-exceeded', 'messaging/message-rate-exceeded', 'app/network-error', 'app/network-timeout']);
async function deliver(row, devices, client) {
    // Recheck after device lookup as well as in the worker/report eligibility.
    if (row.data?.kind === 'announcement' && !await stillVisible(row)) return { status: 'skipped' };
    const sent = new Set(row.push?.sentTokens || []);
    const targets = devices.filter(d => d.enabled && String(d.user) === String(row.user) && !sent.has(tokenHash(d.token)));
    if (!targets.length) return { status: sent.size ? 'sent' : 'skipped', sentTokens: [...sent] };
    const response = await (client || messaging()).sendEach(targets.map(d => payload(row, d)));
    let retry = false;
    let failed = false;
    let lastError = '';
    for (let i = 0; i < response.responses.length; i++) {
        const result = response.responses[i];
        const device = targets[i];
        if (result.success) sent.add(tokenHash(device.token));
        else {
            const code = result.error?.code || 'messaging/unknown-error';
            if (invalidTokenCodes.has(code)) await Device.deleteOne({ _id: device._id, user: row.user, token: device.token });
            else { retry ||= transientCodes.has(code); failed = true; lastError = code; }
        }
    }
    return { status: retry ? 'pending' : failed ? 'failed' : sent.size ? 'sent' : 'skipped', sentTokens: [...sent], lastError };
}
async function processPushBatch({ client } = {}) {
    if (!isConfigured()) return;
    const now = new Date();
    const worker = crypto.randomUUID();
    const due = { 'push.nextAttemptAt': { $lte: now }, $or: [
        { 'push.status': 'pending' }, { 'push.status': 'sending', 'push.leaseUntil': { $lt: now } },
    ] };
    const ids = await Notification.find(due).sort({ createdAt: 1 }).limit(50).select('_id').lean();
    if (!ids.length) return;
    await Notification.updateMany({ ...due, _id: { $in: ids.map(r => r._id) } }, { $set: {
        'push.status': 'sending', 'push.worker': worker, 'push.leaseUntil': new Date(Date.now() + 600000),
    } });
    const rows = await Notification.find({ 'push.worker': worker, 'push.status': 'sending' }).lean();
    // Bounded concurrency prevents a publication to one lakh members exhausting the API process.
    for (let offset = 0; offset < rows.length; offset += 10) {
        await Promise.all(rows.slice(offset, offset + 10).map(async row => {
            const attempts = (row.push?.attempts || 0) + 1;
            let result;
            try {
                if (row.createdAt < new Date(Date.now() - 86400000) || !(await stillVisible(row))) {
                    result = { status: 'skipped' };
                } else {
                    // A token may be removed or switch accounts while earlier
                    // rows are processed. Resolve its owner at delivery time.
                    const devices = await Device.find({ user: row.user, enabled: true,
                        lastSeenAt: { $gte: new Date(Date.now() - 90 * 86400000) },
                    }).sort({ lastSeenAt: -1 }).limit(20).lean();
                    result = await deliver(row, devices, client);
                }
            } catch (error) {
                result = { status: 'pending', lastError: error.code || 'push/unavailable' };
            }
            if (result.status === 'pending' && attempts >= 5) result.status = 'failed';
            const set = Object.fromEntries(Object.entries({ ...result, attempts, leaseUntil: null,
                nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts) + Math.random() * 10000),
            }).map(([k, v]) => ['push.' + k, v]));
            await Notification.updateOne({ _id: row._id, 'push.worker': worker }, { $set: set });
        }));
    }
}
async function tick() {
    if (running) return;
    running = true;
    try { await Promise.all([Broadcast.processBatch(), processPushBatch(), require('./associationUpdateDelivery').processBatch(), require('./visitorPush.service').processBatch()]); }
    catch (error) { logger.warn('Notification worker failed', { code: error.code || 'worker/unavailable' }); }
    finally { running = false; }
}
function start() {
    if (timer || process.env.NOTIFICATION_WORKER_ENABLED === 'false') return;
    timer = setInterval(() => void tick(), 1000);
    timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
async function health() {
    const { VisitorDevice, VisitorDelivery, PublicNotice } = require('./visitorPush.models');
    const [devices, queued, failed, broadcasts, visitors, visitorQueued, visitorFailed, visitorBroadcasts] = await Promise.all([
        Device.countDocuments({ enabled: true }), Notification.countDocuments({ 'push.status': 'pending' }),
        Notification.countDocuments({ 'push.status': 'failed' }), require('./broadcast.model').countDocuments({ status: { $in: ['pending', 'processing'] } }),
        VisitorDevice.countDocuments({ enabled: true }), VisitorDelivery.countDocuments({ status: 'pending' }),
        VisitorDelivery.countDocuments({ status: 'failed' }), PublicNotice.countDocuments({ status: { $in: ['pending', 'processing'] } }),
    ]);
    return { configured: isConfigured(), provider: 'Firebase Cloud Messaging', devices: devices + visitors, visitors,
        queued: queued + visitorQueued, failed: failed + visitorFailed, broadcasts: broadcasts + visitorBroadcasts,
        workerEnabled: process.env.NOTIFICATION_WORKER_ENABLED !== 'false' };
}

async function queueTest(user) {
    if (!isConfigured()) throw ApiError.badRequest('Firebase push is not configured yet.');
    if (process.env.NOTIFICATION_WORKER_ENABLED === 'false') throw ApiError.badRequest('The notification worker is disabled. Enable it before testing.');
    const registered = await Device.exists({ user, enabled: true, lastSeenAt: { $gte: new Date(Date.now() - 90 * 86400000) } });
    if (!registered) throw ApiError.badRequest('Enable notifications in this browser or sign in to the ACTIV app and allow notifications before testing.');
    await require('./notification.service').createNotification(user, { title: 'ACTIV notification test',
        message: 'Dear administrator, thank you for checking your ACTIV notifications.', data: { kind: 'test' } });
    return { queued: true };
}
module.exports = { messaging, register, unregister, isConfigured, payload, deliver, stillVisible, processPushBatch, start, stop, health, validToken, queueTest };
