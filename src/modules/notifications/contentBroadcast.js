const crypto = require('node:crypto');
const { memberAccess, matchesAudience } = require('../common/memberAudience');
const { targetsMember, multiTargetsViewer } = require('../common/regionMatch');
const { isPastEvent } = require('../events/eventLifecycle');
const logger = require('../../config/logger');
const VISIBILITY_FIELDS = 'slug status visible audience planKeys state district block tier targets reachEveryone expiresAt startAt endAt days archivedAt deletedAt';
const MATERIAL_FIELDS = ['title', 'summary', 'body', 'description', 'caption', 'status', 'visible', 'audience', 'state', 'district', 'block', 'targets',
    'startAt', 'endAt', 'days', 'mode', 'venue', 'venueAddress', 'venueMapUrl', 'onlinePlatform', 'onlineUrl', 'language', 'category', 'topic',
    'content', 'image', 'images', 'media', 'photos', 'attachments', 'bannerUrl', 'bannerAlt', 'attachmentUrl', 'attachmentLabel', 'planKeys', 'expiresAt', 'reachEveryone', 'tier', 'link', 'url', 'location',
    'benefits', 'eligibility', 'howToApply', 'agenda', 'speakers', 'registrationFee', 'memberFee', 'capacity', 'registrationEnabled', 'registrationDeadline', 'registrationNote'];

function published(kind, doc) {
    if (!doc || doc.archivedAt || doc.deletedAt) return false;
    if (kind === 'gallery') return doc.visible !== false;
    if (doc.status !== 'published') return false;
    if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) return false;
    return kind !== 'event' || !isPastEvent(doc);
}
function sourceModel(kind) {
    if (kind === 'announcement') return require('../announcements/announcement.model');
    if (kind === 'event') return require('../events/event.model');
    const cms = require('../cms/cms.models');
    return { news: cms.NewsArticle, gallery: cms.GalleryItem, scheme: cms.Scheme }[kind];
}
function visibleTo(kind, doc, context) {
    if (!published(kind, doc) || !matchesAudience(doc.audience, context, kind === 'announcement' ? doc.planKeys : [])) return false;
    if (kind === 'event') return doc.reachEveryone === true || multiTargetsViewer(doc, context);
    if (kind === 'scheme' && ['central', 'national'].includes(doc.tier)) return true;
    return targetsMember(doc, context);
}
function sourceKey(kind, doc) {
    const value = Object.fromEntries(MATERIAL_FIELDS.map(key => [key, doc[key]]));
    return `${kind}:${doc._id}:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
async function enqueue(kind, doc) {
    if (!published(kind, doc)) return;
    const key = sourceKey(kind, doc);
    await require('./broadcast.model').updateOne({ key }, { $setOnInsert: { key, kind, sourceId: doc._id } }, { upsert: true });
}
// Register before compiling the schema. Covers both CMS and admin write paths.
function install(schema, kind) {
    const notify = async doc => {
        if (!doc) return;
        try { await enqueue(kind, doc.toObject ? doc.toObject() : doc); }
        catch (error) { if (error.code !== 11000) logger.warn('Content notification could not be queued', { kind, error: error.message }); }
    };
    schema.post('save', notify);
    schema.post('findOneAndUpdate', async function(doc) {
        const update = this.getUpdate() || {};
        // Seat counts, reminder claims and other operational writes are not publications.
        const keys = Object.keys(update.$set || update).filter(k => !['updatedAt', 'createdAt'].includes(k));
        if (keys.some(k => MATERIAL_FIELDS.includes(k.split('.')[0]))) await notify(doc);
    });
}
const labels = { announcement: 'association update', event: 'event programme', news: 'news story', gallery: 'gallery update', scheme: 'government scheme' };
function notice(job, doc, user) {
    const kind = job.kind;
    // No private headline/body on a lock screen, including after a membership changes.
    return { user: user._id, deliveryKey: `${job._id}:${user._id}`, title: 'ACTIV · ' + labels[kind],
        message: `Dear member, there is a new or revised ${labels[kind]} for you. Thank you for being part of ACTIV.`,
        type: 'info', isRead: false,
        data: { kind, sourceId: String(doc._id), ...(kind === 'event' ? { eventId: String(doc._id) } : {}),
            ...(kind === 'announcement' ? { announcementId: String(doc._id) } : {}), slug: doc.slug || '' },
        push: { status: 'pending', attempts: 0, nextAttemptAt: new Date() } };
}
async function processBatch() {
    const Job = require('./broadcast.model');
    const Notification = require('./notification.model');
    const Member = require('../members/memberdetails.model');
    const now = new Date();
    const worker = crypto.randomUUID();
    const job = await Job.findOneAndUpdate({ nextAttemptAt: { $lte: now }, $or: [
        { status: 'pending' }, { status: 'processing', leaseUntil: { $lt: now } },
    ] }, { $set: { status: 'processing', worker, leaseUntil: new Date(Date.now() + 300000) } }, { new: true, sort: { createdAt: 1 } }).lean();
    if (!job) return;
    const claim = { _id: job._id, worker };
    try {
        const doc = await sourceModel(job.kind).findById(job.sourceId).select(VISIBILITY_FIELDS).lean();
        if (!published(job.kind, doc) || job.createdAt < new Date(Date.now() - 86400000)) {
            await Job.updateOne(claim, { $set: { status: 'done' } }); return;
        }
        const rows = await Member.find({ ...(job.cursor ? { _id: { $gt: job.cursor } } : {}),
            createdAt: { $lte: job.createdAt }, isActive: { $ne: false }, deletedAt: null,
            role: { $nin: ['super_admin', 'state_admin', 'district_admin', 'block_admin', 'cms_admin', 'events_admin', 'attendance_admin'] },
        }).sort({ _id: 1 }).limit(500).select('state district block membershipStatus membershipType membershipTier memberType registrationType membershipExpiresAt membershipActivatedAt paymentId').lean();
        if (!rows.length) { await Job.updateOne(claim, { $set: { status: 'done' } }); return; }
        // One receipt query per batch, not one query per member at lakh-user scale.
        const orders = await require('../payment/paymentorder.model').aggregate([
            { $match: { memberId: { $in: rows.map(r => r._id) }, orderType: 'membership', status: 'paid' } },
            { $sort: { paidAt: -1, createdAt: -1 } }, { $group: { _id: '$memberId', order: { $first: '$$ROOT' } } },
        ]);
        const paid = new Map(orders.map(o => [String(o._id), o.order]));
        const legacyPlanIds = [...new Set(orders.map(o => o.order).filter(o => !o.upgradeKind && !o.planAudience && o.planId).map(o => o.planId))];
        const plans = legacyPlanIds.length ? await require('../members/membershipplan.model').find({ key: { $in: legacyPlanIds } }).select('key audience').lean() : [];
        const planAudiences = new Map(plans.map(p => [p.key, p.audience]));
        for (const receipt of paid.values()) if (!receipt.upgradeKind && !receipt.planAudience) receipt.planAudience = planAudiences.get(receipt.planId) || '';
        const writes = rows.filter(row => {
            const receipt = paid.get(String(row._id));
            const profile = /^(pay_|OFF-)/.test(row.paymentId || '') && !receipt ? { ...row, membershipStatus: 'pending' } : row;
            return visibleTo(job.kind, doc, { ...row, ...memberAccess(profile, receipt) });
        }).map(row => {
            const n = notice(job, doc, row);
            return { updateOne: { filter: { deliveryKey: n.deliveryKey }, update: { $setOnInsert: n }, upsert: true } };
        });
        if (writes.length) await Notification.bulkWrite(writes, { ordered: false });
        await Job.updateOne(claim, { $set: { cursor: rows[rows.length - 1]._id, status: rows.length < 500 ? 'done' : 'pending', attempts: 0, leaseUntil: null } });
    } catch (error) {
        const attempts = job.attempts + 1;
        await Job.updateOne(claim, { $set: { status: attempts >= 5 ? 'failed' : 'pending', attempts,
            nextAttemptAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)), lastError: String(error.message).slice(0, 250) } });
        logger.warn('Content notification batch failed', { kind: job.kind, jobId: String(job._id) });
    }
}
module.exports = { install, enqueue, processBatch, published, visibleTo, sourceModel, notice, sourceKey, VISIBILITY_FIELDS };
