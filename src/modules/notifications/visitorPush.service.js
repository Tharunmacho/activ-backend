const crypto = require('node:crypto');
const ApiError = require('../../core/utils/ApiError');
const { VisitorDevice, PublicNotice, VisitorDelivery } = require('./visitorPush.models');
const MemberDevice = require('./pushDevice.model');
const Broadcast = require('./contentBroadcast');
const { personalizeUpdate } = require('../common/recipientPersonalization');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const idValid = value => /^[a-f\d]{24}$/i.test(String(value || ''));
function publicEligible(kind, doc) {
    if (!Broadcast.published(kind, doc) || String(doc.audience || 'all') !== 'all') return false;
    if (kind === 'event') return require('../events/onboardingVisibility').isOnboardingContent(doc);
    return kind === 'announcement' && doc.includeVisitors === true
        && ![doc.state, doc.district, doc.block].some(Boolean) && !(doc.targets || []).some(t => t.state || t.district || t.block);
}
async function source(notice) {
    if (!notice) return null;
    const doc = await Broadcast.sourceModel(notice.kind)?.findById(notice.sourceId).lean();
    return publicEligible(notice.kind, doc) && Broadcast.sourceKey(notice.kind, doc) === notice.key ? doc : null;
}
async function install() {
    const key = crypto.randomBytes(32).toString('hex');
    const row = await VisitorDevice.create({ secretHash: digest(key) });
    return { key, id: String(row._id) };
}
async function deviceFor(key) {
    if (!/^[a-f\d]{64}$/.test(String(key || ''))) throw ApiError.unauthorized('Enable visitor notifications on this device first.');
    const row = await VisitorDevice.findOne({ secretHash: digest(key) });
    if (!row || !row.lastSeenAt || row.lastSeenAt < new Date(Date.now() - 90 * 86400000)) throw ApiError.unauthorized('This visitor registration has expired. Please enable notifications again.');
    return row;
}
async function register(key, body = {}) {
    const device = await deviceFor(key);
    const token = require('./push.service').validToken(body.token);
    if (!['android', 'ios', 'web'].includes(body.platform)) throw ApiError.badRequest('Choose Android, iOS or web.');
    if (await MemberDevice.exists({ token })) throw ApiError.conflict('This device is signed in. Use account notifications.');
    try { await VisitorDevice.updateOne({ _id: device._id }, { $set: { token, platform: body.platform, enabled: true, lastSeenAt: new Date() } }); }
    catch (error) { if (error.code === 11000) throw ApiError.conflict('This push registration belongs to another installation.'); throw error; }
    // Account registration can win while this request is awaiting its write.
    // The member path performs the inverse cleanup, so both orderings converge.
    if (await MemberDevice.exists({ token })) {
        await VisitorDevice.updateOne({ _id: device._id, token }, { $set: { enabled: false }, $unset: { token: 1 } });
        throw ApiError.conflict('This device is signed in. Use account notifications.');
    }
    return { registered: true, configured: require('./push.service').isConfigured() };
}
async function unregister(key) {
    const device = await deviceFor(key);
    await VisitorDevice.updateOne({ _id: device._id }, { $set: { enabled: false }, $unset: { token: 1 } });
    return { removed: true };
}
async function enqueue(kind, doc) {
    if (!publicEligible(kind, doc)) return;
    const key = Broadcast.sourceKey(kind, doc);
    await PublicNotice.updateOne({ key }, { $setOnInsert: { key, kind, sourceId: doc._id } }, { upsert: true });
}
const plain = value => require('../cms/richText').sanitizeHtml(value)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:p|h[1-6]|li|blockquote)>/gi, '\n\n').replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[key]))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function toPublic(notice, doc) {
    const value = notice.kind === 'announcement' ? personalizeUpdate(doc, {}) : doc;
    // Explicit safe projection: meeting URLs, attendee details and member fields never leave this endpoint.
    return { id: String(notice._id), kind: notice.kind, sourceId: String(doc._id), title: value.title,
        summary: plain(value.summary || value.description || value.body).slice(0, 300),
        body: plain(value.body || value.description), imageUrl: value.bannerUrl || '', createdAt: notice.createdAt };
}
async function feed(id) {
    if (id && !idValid(id)) throw ApiError.notFound('Notification not found');
    const notices = await PublicNotice.find(id ? { _id: id } : { createdAt: { $gt: new Date(Date.now() - 30 * 86400000) } })
        .sort({ createdAt: -1 }).limit(id ? 1 : 80).lean();
    // Two bounded content reads rather than one round trip for every feed row.
    const documents = new Map();
    await Promise.all(['announcement', 'event'].map(async kind => {
        const ids = notices.filter(notice => notice.kind === kind).map(notice => notice.sourceId);
        if (!ids.length) return;
        const rows = await Broadcast.sourceModel(kind).find({ _id: { $in: ids } }).lean();
        for (const doc of rows) documents.set(`${kind}:${doc._id}`, doc);
    }));
    const seen = new Set(), items = [];
    for (const notice of notices) {
        const key = `${notice.kind}:${notice.sourceId}`;
        if (seen.has(key)) continue;
        const doc = documents.get(key);
        if (publicEligible(notice.kind, doc) && Broadcast.sourceKey(notice.kind, doc) === notice.key) { seen.add(key); items.push(toPublic(notice, doc)); }
    }
    if (id && !items.length) throw ApiError.notFound('Notification not found');
    return id ? items[0] : items;
}
async function opened(key, id, channel) {
    const device = await deviceFor(key);
    if (!idValid(id)) throw ApiError.notFound('Notification not found');
    if (!['push', 'in_app'].includes(channel)) throw ApiError.badRequest('Choose a notification channel.');
    const notice = await PublicNotice.findById(id).lean();
    if (!await source(notice)) throw ApiError.notFound('Notification not found');
    const field = channel === 'push' ? 'openedAt' : 'inAppOpenedAt';
    // Only an installation actually targeted by this publication can report an open.
    const result = await VisitorDelivery.updateOne({ notice: id, device: device._id, [field]: null }, { $set: { [field]: new Date() } });
    return { recorded: !!result.modifiedCount };
}
async function fanout() {
    const now = new Date(), worker = crypto.randomUUID();
    const job = await PublicNotice.findOneAndUpdate({ nextAttemptAt: { $lte: now }, $or: [{ status: 'pending' }, { status: 'processing', leaseUntil: { $lt: now } }] },
        { $set: { status: 'processing', worker, leaseUntil: new Date(Date.now() + 300000) } }, { new: true, sort: { createdAt: 1 } }).lean();
    if (!job) return;
    try {
        if (job.createdAt < new Date(Date.now() - 86400000) || !await source(job)) {
            await PublicNotice.updateOne({ _id: job._id, worker }, { $set: { status: 'done' } }); return;
        }
        const devices = await VisitorDevice.find({ enabled: true, createdAt: { $lte: job.createdAt }, lastSeenAt: { $gte: new Date(Date.now() - 90 * 86400000) },
            ...(job.cursor ? { _id: { $gt: job.cursor } } : {}) }).sort({ _id: 1 }).limit(500).select('_id').lean();
        if (devices.length) await VisitorDelivery.bulkWrite(devices.map(device => ({ updateOne: { filter: { notice: job._id, device: device._id },
            update: { $setOnInsert: { notice: job._id, device: device._id } }, upsert: true } })), { ordered: false });
        await PublicNotice.updateOne({ _id: job._id, worker }, { $set: { status: devices.length < 500 ? 'done' : 'pending', cursor: devices.at(-1)?._id || job.cursor, leaseUntil: null } });
    } catch (error) {
        await PublicNotice.updateOne({ _id: job._id, worker }, { $set: { status: job.attempts >= 4 ? 'failed' : 'pending',
            attempts: job.attempts + 1, lastError: error.code || 'visitor/fanout', nextAttemptAt: new Date(Date.now() + 60000) } });
    }
}
async function processBatch(client) {
    await fanout();
    if (!client && !require('./push.service').isConfigured()) return;
    for (let i = 0; i < 30; i++) {
        const now = new Date(), worker = crypto.randomUUID();
        const row = await VisitorDelivery.findOneAndUpdate({ nextAttemptAt: { $lte: now }, $or: [{ status: 'pending' }, { status: 'sending', leaseUntil: { $lt: now } }] },
            { $set: { status: 'sending', worker, leaseUntil: new Date(Date.now() + 300000) } }, { new: true }).lean();
        if (!row) return;
        let status = 'skipped', lastError = '', sentAt;
        try {
            const device = await VisitorDevice.findById(row.device).select('+token').lean();
            const notice = await PublicNotice.findById(row.notice).lean();
            if (notice && notice.createdAt >= new Date(Date.now() - 86400000) && device?.enabled && device.token
                && device.lastSeenAt >= new Date(Date.now() - 90 * 86400000) && !await MemberDevice.exists({ token: device.token }) && await source(notice)) {
                const data = { audience: 'visitor', publicNotificationId: String(notice._id), visitorId: String(device._id) };
                // A web worker validates the opted-in installation before showing
                // a notification. Firebase must not auto-display after opt-out/login.
                const payload = device.platform === 'web' ? { token: device.token, data,
                    webpush: { headers: { TTL: '86400', Urgency: 'high' } } } : { token: device.token, data,
                    notification: { title: 'ACTIV', body: 'Dear ACTIVian, explore a new public update from ACTIV.' },
                    android: { priority: 'high', ttl: 86400000, notification: { channelId: 'activ_updates', sound: 'default', icon: 'ic_notification', tag: String(notice._id) } },
                    apns: { headers: { 'apns-expiration': String(Math.floor(Date.now() / 1000) + 86400) }, payload: { aps: { sound: 'default' } } } };
                await (client || require('./push.service').messaging()).send(payload);
                status = 'sent'; sentAt = new Date();
            }
        } catch (error) {
            lastError = error.code || 'visitor/unavailable';
            if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error.code)) {
                await VisitorDevice.updateOne({ _id: row.device }, { $set: { enabled: false }, $unset: { token: 1 } }); status = 'failed';
            } else status = row.attempts >= 4 ? 'failed' : 'pending';
        }
        await VisitorDelivery.updateOne({ _id: row._id, worker }, { $set: { status, lastError, ...(sentAt ? { sentAt } : {}), attempts: row.attempts + 1,
            leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** row.attempts)) } });
    }
}
module.exports = { publicEligible, source, install, deviceFor, register, unregister, enqueue, feed, opened, processBatch, fanout };
