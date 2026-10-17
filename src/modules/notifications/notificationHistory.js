const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const ApiError = require('../../core/utils/ApiError');
const Batch = require('./notificationHistoryBatch.model');
const Log = require('./notificationLog.model');
const Notification = require('./notification.model');
const { VisitorDelivery } = require('./visitorPush.models');
const { buildLogQuery, matchLegacyRows } = require('./deliveryQuery');
const LIMIT = 500;
const ALL_LIMIT = 10000;
const AUDIENCE = 'activ-notification-history-cleanup';
const CHANNELS = ['email', 'whatsapp', 'push', 'in_app'];
const hexId = value => /^[a-f\d]{24}$/i.test(String(value || ''));
const rowId = value => /^(?:log:[a-f\d]{24}|[a-f\d]{24}:(?:email|whatsapp|push|in_app)|visitor:[a-f\d]{24}:(?:push|in_app))$/i.test(value);
const reasonCount = (reasons, reason) => {
    const found = reasons.find(item => item.reason === reason);
    if (found) found.count++;
    else reasons.push({ reason, count: 1 });
};
const retain = {
    missing: 'This entry is no longer available in admin history.',
    pending: 'This message is waiting or still being sent. Keep it until sending finishes.',
    changed: 'This entry changed after review. Review it again before removing it.',
    duplicate: 'The same delivery was included more than once.',
    unavailable: 'This entry could not be checked. Please try again.',
};
const actorRequired = actor => { if (!actor) throw ApiError.unauthorized('An authenticated administrator is required.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function cleanIds(ids, view, limit = LIMIT) {
    if (!Array.isArray(ids) || !ids.length || ids.length > limit || ids.some(id => typeof id !== 'string')) throw ApiError.badRequest(`Choose between 1 and ${limit} history entries.`);
    const selected = ids.map(id => view === 'logs' && hexId(id) ? `log:${id}` : id);
    if (selected.some(id => !rowId(id) || (view === 'logs' && !/^log:/i.test(id)))) throw ApiError.badRequest('Choose valid history entry IDs.');
    return [...new Set(selected)];
}
function filtersFor(view, input) {
    if (!object(input)) throw ApiError.badRequest('Choose valid history filters.');
    const keys = view === 'reports' ? ['from', 'to', 'campaignKey', 'group', 'channel', 'search', 'status']
        : ['channel', 'status', 'event', 'search', 'delivery', 'group', 'eventId', 'bookingRef', 'from', 'to'];
    if (Object.keys(input).some(key => !keys.includes(key)) || Object.values(input).some(value => typeof value !== 'string')) throw ApiError.badRequest('History filters must use the fields shown in this view.');
    const filter = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.trim()]));
    const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (['from', 'to'].some(key => filter[key] && !validDay(filter[key])) || (filter.from && filter.to && filter.from > filter.to)
        || (filter.channel && !(view === 'logs' ? ['email', 'whatsapp', 'in_app'] : CHANNELS).includes(filter.channel))
        || (filter.search && filter.search.length > 120)
        || (filter.group && !(view === 'reports' ? ['publication', 'automation'] : ['automation', 'booking', 'membership', 'account']).includes(filter.group))
        || (filter.status && !(view === 'reports' ? ['queued', 'accepted', 'sent', 'delivered', 'read', 'marked_read', 'failed', 'skipped', 'mock', 'accepted_any', 'unconfirmed'] : ['queued', 'sent', 'failed']).includes(filter.status))
        || (filter.delivery && !['accepted', 'sent', 'delivered', 'read', 'failed', 'mock', 'resent', 'reached'].includes(filter.delivery))
        || (filter.event && !Log.schema.path('event').enumValues.includes(filter.event))
        || (filter.eventId && !hexId(filter.eventId))
        || (filter.bookingRef && !/^[a-z\d_-]{1,60}$/i.test(filter.bookingRef))
        || (filter.campaignKey && (!/^(publication|automation):/.test(filter.campaignKey) || filter.campaignKey.length > 250))) {
        throw ApiError.badRequest('Choose valid history filters before clearing entries.');
    }
    return filter;
}
const target = (Model, row, channel) => ({ Model, row, channel,
    field: channel ? `adminHistoryHiddenAt.${channel}` : 'adminHistoryHiddenAt',
    batchField: channel ? `adminHistoryHiddenBatch.${channel}` : 'adminHistoryHiddenBatch',
    hidden: channel ? row?.adminHistoryHiddenAt?.[channel] : row?.adminHistoryHiddenAt,
});
const find = (Model, id) => Model.findById(id).lean().maxTimeMS(10000);
function record(id, targets, queue) {
    const primary = targets[0];
    const log = targets.find(item => item.Model === Log)?.row;
    const reason = !primary?.row || targets.some(item => item.hidden) ? retain.missing
        : ['pending', 'sending', 'queued'].includes(queue?.status) || log?.status === 'queued' || log?.retryClaim?.token ? retain.pending : '';
    // 128 bits bind the full selected delivery snapshot while keeping a
    // 500-entry review + IDs below ordinary JSON request-size limits.
    const version = crypto.createHash('sha256').update(JSON.stringify(targets.map(item => ({
        id: item.row?._id, channel: item.channel, updatedAt: item.row?.updatedAt, hidden: item.hidden,
        queue, status: item.Model === Log ? item.row?.status : undefined,
        deliveryStatus: item.Model === Log ? item.row?.deliveryStatus : undefined,
        retryClaim: item.Model === Log ? item.row?.retryClaim : undefined,
    })))).digest('hex').slice(0, 32);
    return { id, targets, reason, version, key: primary ? `${primary.Model.modelName}:${primary.row?._id}:${primary.channel || ''}` : id };
}
async function notificationRecord(id, row, channel, knownLog) {
    if (!row) return record(id, [], null);
    const queue = channel === 'push' ? row.push : channel === 'in_app' ? null : row.updateDelivery?.[channel];
    if (channel !== 'in_app' && !queue) return record(id, [], null);
    const targets = [target(Notification, row, channel)];
    if (['email', 'whatsapp'].includes(channel) && queue.logId) {
        const log = knownLog || await find(Log, queue.logId);
        if (log) {
            if (log.event !== 'ASSOCIATION_UPDATE' || log.channel !== channel || String(log.data?.notificationId) !== String(row._id)) return record(id, [], null);
            targets.push(target(Log, log));
        }
    }
    return record(id, targets, queue);
}
async function resolve(id) {
    let match = /^log:([a-f\d]{24})$/i.exec(id);
    if (match) {
        const row = await find(Log, match[1]);
        if (row?.event === 'ASSOCIATION_UPDATE' && hexId(row.data?.notificationId)) {
            const notice = await find(Notification, row.data.notificationId);
            if (String(notice?.updateDelivery?.[row.channel]?.logId) === String(row._id)) return notificationRecord(id, notice, row.channel, row);
        }
        return record(id, row ? [target(Log, row)] : [], row);
    }
    match = /^([a-f\d]{24}):(email|whatsapp|push|in_app)$/i.exec(id);
    if (match) return notificationRecord(id, await find(Notification, match[1]), match[2].toLowerCase());
    match = /^visitor:([a-f\d]{24}):(push|in_app)$/i.exec(id);
    if (match) {
        const row = await find(VisitorDelivery, match[1]);
        const channel = match[2].toLowerCase();
        return record(id, row ? [target(VisitorDelivery, row, channel)] : [], channel === 'push' ? row : null);
    }
    return record(id, [], null);
}
async function parallel(items, callback) {
    let cursor = 0;
    const results = [];
    await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
        while (cursor < items.length) { const index = cursor++; results[index] = await callback(items[index], index); }
    }));
    return results;
}
async function preview(input = {}, actor) {
    actorRequired(actor);
    if (!object(input) || !['reports', 'logs'].includes(input.view) || Object.keys(input).some(key => !['view', 'ids', 'filters', 'all'].includes(key))
        || (input.all !== undefined && typeof input.all !== 'boolean')
        || (input.ids !== undefined && input.filters !== undefined)) throw ApiError.badRequest('Choose one history view and either entries or filters.');
    const { view } = input;
    const all = input.all === true;
    const selectionLimit = all ? ALL_LIMIT : LIMIT;
    // Read one extra ID to reject an oversized full selection instead of
    // silently clearing only part of it. Never fetch a new page while clearing.
    const readLimit = selectionLimit + (all ? 1 : 0);
    let ids, matched;
    if (input.ids !== undefined) { ids = cleanIds(input.ids, view, selectionLimit); matched = ids.length; }
    else {
        const filters = filtersFor(view, input.filters === undefined ? {} : input.filters);
        if (view === 'reports') {
            const report = await require('./deliveryReport').report({ ...filters, page: 1, limit: readLimit }, { maxRows: readLimit, historySelection: true });
            ids = report.rows.map(row => row._id); matched = report.pagination.total;
        } else {
            let query = { $and: [{ adminHistoryHiddenAt: null }, buildLogQuery(filters)] };
            if (all && filters.bookingRef) {
                const ref = filters.bookingRef.toUpperCase();
                const otherFilters = buildLogQuery({ ...filters, bookingRef: '' });
                // Booking screens also include old rows matched by recipient.
                // Use that same matcher without its normal display-page cap;
                // otherwise clearing a booking would silently miss old logs.
                const legacy = await matchLegacyRows([ref], { limit: readLimit, filter: otherFilters, throwOnReadError: true });
                query = { $and: [{ adminHistoryHiddenAt: null }, otherFilters, { channel: { $in: ['email', 'whatsapp'] } },
                    { $or: [{ bookingRef: ref }, { 'data.bookingRef': ref }, { _id: { $in: (legacy.get(ref) || []).map(row => row._id) } }] }] };
            }
            const [rows, count] = await Promise.all([
                Log.aggregate([
                    { $match: query },
                    { $set: { historyNoticeId: { $cond: [{ $eq: ['$event', 'ASSOCIATION_UPDATE'] },
                        { $convert: { input: '$data.notificationId', to: 'objectId', onError: null, onNull: null } }, null] } } },
                    { $lookup: { from: Notification.collection.name, localField: 'historyNoticeId', foreignField: '_id', as: 'historyNotice' } },
                    { $set: { historyQueue: { $arrayElemAt: [{ $cond: [{ $eq: ['$channel', 'email'] }, '$historyNotice.updateDelivery.email', '$historyNotice.updateDelivery.whatsapp'] }, 0] } } },
                    { $set: { historyRemovable: { $and: [
                        { $ne: ['$status', 'queued'] }, { $eq: [{ $ifNull: ['$retryClaim.token', null] }, null] },
                        { $or: [{ $ne: [{ $ifNull: ['$historyQueue.logId', null] }, '$_id'] },
                            { $not: [{ $in: ['$historyQueue.status', ['pending', 'sending']] }] }] },
                    ] } } },
                    { $sort: { historyRemovable: -1, createdAt: -1, _id: 1 } },
                    { $limit: readLimit }, { $project: { _id: 1 } },
                ]).allowDiskUse(true).option({ maxTimeMS: 20000 }),
                all ? Promise.resolve(null) : Log.countDocuments(query).maxTimeMS(20000),
            ]);
            ids = rows.map(row => `log:${row._id}`); matched = all ? ids.length : count;
        }
    }
    if (all && (matched > ALL_LIMIT || ids.length > ALL_LIMIT)) throw ApiError.badRequest(
        `More than ${ALL_LIMIT.toLocaleString('en-US')} logs match. Narrow the dates or filters, then clear each selection. No logs have been cleared.`);
    const checked = await parallel(ids, async id => { try { return await resolve(id); } catch { return { id, reason: retain.unavailable }; } });
    const reasons = [], eligible = [], versions = [], seen = new Set();
    for (const item of checked) {
        const reason = item.reason || (seen.has(item.key) ? retain.duplicate : '');
        if (reason) reasonCount(reasons, reason);
        else { eligible.push(item.id); versions.push(item.version); seen.add(item.key); }
    }
    const sign = (batchIds, batchVersions) => jwt.sign({ ids: batchIds, versions: batchVersions }, config.jwt.secret, {
        algorithm: 'HS256', audience: AUDIENCE, subject: String(actor), jwtid: crypto.randomUUID(), expiresIn: 600,
    });
    const batches = [];
    if (all) for (let offset = 0; offset < eligible.length; offset += LIMIT) {
        const batchIds = eligible.slice(offset, offset + LIMIT);
        batches.push({ ids: batchIds, token: sign(batchIds, versions.slice(offset, offset + LIMIT)), eligible: batchIds.length });
    }
    // Full clear has one reviewed selection, sent in bounded immutable chunks.
    // An empty top-level token prevents accidentally confirming only one part.
    const token = !all && eligible.length ? sign(eligible, versions) : '';
    return { matched, reviewed: ids.length, eligible: eligible.length, retained: ids.length - eligible.length,
        remaining: matched - ids.length, truncated: matched > ids.length, ids: eligible, token, reasons,
        ...(all ? { batches } : {}) };
}
const guard = item => {
    const row = item.row;
    const query = { _id: row._id, [item.field]: null, updatedAt: row.updatedAt || { $exists: false } };
    // Bind outcome fields as well as timestamps: callbacks and retries can
    // update twice within the same millisecond, or use legacy raw writes.
    if (item.Model === Log) Object.assign(query, { status: row.status, deliveryStatus: row.deliveryStatus ?? null,
        providerMessageId: row.providerMessageId ?? null, attempts: row.attempts ?? { $exists: false },
        'retryClaim.token': { $exists: false }, resentAs: row.resentAs ?? null,
        deliveredAt: row.deliveredAt ?? null, readAt: row.readAt ?? null, failedAt: row.failedAt ?? null,
        data: { $eq: row.data ?? null },
    });
    else if (item.Model === Notification) Object.assign(query, { data: { $eq: row.data ?? null },
        ...(item.channel === 'push' ? { push: { $eq: row.push } }
            : ['email', 'whatsapp'].includes(item.channel) ? { [`updateDelivery.${item.channel}`]: { $eq: row.updateDelivery[item.channel] } }
                : { isRead: row.isRead, openedAt: row.openedAt ?? null, readAt: row.readAt ?? null }),
    });
    else Object.assign(query, item.channel === 'push' ? { status: row.status, attempts: row.attempts,
        sentAt: row.sentAt ?? null, openedAt: row.openedAt ?? null, lastError: row.lastError ?? null }
        : { inAppOpenedAt: row.inAppOpenedAt ?? null });
    return query;
};
async function hide(record, batch) {
    const written = [];
    try {
        // Hide the linked log first. If the queue changes while awaiting it,
        // restore only this batch's visibility marker, leaving delivery data
        // and any newly completed callback untouched.
        for (const item of [...record.targets].reverse()) {
            const result = await item.Model.updateOne(guard(item), { $set: { [item.field]: new Date(), [item.batchField]: batch } }, { timestamps: false, maxTimeMS: 10000 });
            if (!result.modifiedCount) throw Error('changed');
            written.push(item);
        }
        return '';
    } catch (error) {
        for (const item of written) await item.Model.updateOne({ _id: item.row._id, [item.batchField]: batch }, {
            $unset: { [item.field]: 1, [item.batchField]: 1 },
        }, { timestamps: false, maxTimeMS: 10000 });
        return error.message === 'changed' ? retain.changed : retain.unavailable;
    }
}
let indexes;
async function execute(input = {}, actor) {
    actorRequired(actor);
    if (!object(input) || Object.keys(input).some(key => !['ids', 'token'].includes(key))) throw ApiError.badRequest('Confirm the reviewed entries and token.');
    const ids = cleanIds(input.ids);
    let snapshot;
    try {
        if (typeof input.token !== 'string' || input.token.length > 120000) throw Error('invalid token');
        snapshot = jwt.verify(input.token, config.jwt.secret, { algorithms: ['HS256'], audience: AUDIENCE, subject: String(actor) });
        if (!snapshot.jti || !Array.isArray(snapshot.versions) || snapshot.versions.length !== ids.length || JSON.stringify(snapshot.ids) !== JSON.stringify(ids)) throw Error('changed selection');
    } catch { throw ApiError.badRequest('This review expired or changed. Review the entries again.'); }
    indexes ||= Batch.createIndexes().catch(error => { indexes = null; throw error; });
    await indexes;
    const key = crypto.createHash('sha256').update(snapshot.jti).digest('hex');
    const summary = { removed: 0, retained: 0, reasons: [] };
    let batch;
    try { batch = await Batch.create({ key, requestedBy: String(actor), ids, summary }); }
    catch (error) {
        if (error.code !== 11000) throw error;
        const prior = await Batch.findOne({ key }).lean();
        return { ...(prior?.summary || summary), alreadySubmitted: true, processing: prior?.status !== 'done' };
    }
    // Keep each saved checkpoint small. New arrivals are never selected here;
    // only the exact reviewed IDs and matching versions can be hidden.
    for (let offset = 0; offset < ids.length; offset += 8) {
        const results = await parallel(ids.slice(offset, offset + 8), async (id, index) => {
            let reason;
            try {
                const row = await resolve(id);
                reason = row.version !== snapshot.versions[offset + index] ? retain.changed : row.reason;
                if (!reason) reason = await hide(row, key);
            } catch { reason = retain.unavailable; }
            if (reason) { summary.retained++; reasonCount(summary.reasons, reason); }
            else summary.removed++;
            return { id, at: new Date(), removed: !reason, reason: reason || undefined };
        });
        await Batch.updateOne({ _id: batch._id }, { $set: { summary }, $push: { results: { $each: results } } });
    }
    await Batch.updateOne({ _id: batch._id }, { $set: { status: 'done', summary } });
    return summary;
}
module.exports = { preview, execute, LIMIT, ALL_LIMIT };
