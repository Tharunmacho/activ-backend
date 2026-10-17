const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const ApiError = require('../../core/utils/ApiError');
const Batch = require('./deliveryRetryBatch.model');
const Notification = require('./notification.model');
const { VisitorDelivery } = require('./visitorPush.models');
const policy = require('./deliveryRetryPolicy');
const LIMIT = 100;
const START_SEND_WINDOW_MS = 20000;
const audience = 'activ-delivery-report-retry';
const addReason = (reasons, reason) => {
    const text = String(reason || 'This delivery cannot be retried.').slice(0, 500);
    const item = reasons.find(item => item.reason === text);
    if (item) item.count++;
    else reasons.push({ reason: text, count: 1 });
};
const cleanIds = ids => {
    if (!Array.isArray(ids) || !ids.length || ids.length > LIMIT || ids.some(id => typeof id !== 'string' || id.length > 80)) {
        throw ApiError.badRequest('Choose between 1 and 100 delivery rows.');
    }
    return [...new Set(ids)];
};
let indexes;
const ensureIndexes = () => indexes ||= Batch.createIndexes().catch(error => { indexes = null; throw error; });
const verifyReview = (token, actor) => {
    if (!actor) throw ApiError.unauthorized('An authenticated administrator is required.');
    try {
        if (typeof token !== 'string' || token.length > 32768) throw Error('Invalid token');
        return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], audience, subject: String(actor) });
    } catch { throw ApiError.badRequest('This retry review has expired or is invalid. Preview the failed deliveries again.'); }
};
const batchKey = snapshot => crypto.createHash('sha256').update(snapshot.jti).digest('hex');
const emptySummary = () => ({ attempted: 0, sent: 0, queued: 0, failed: 0, skipped: 0, reasons: [] });

async function preview(input = {}, actor) {
    if (!actor) throw ApiError.unauthorized('An authenticated administrator is required.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw ApiError.badRequest('Choose delivery report rows or filters.');
    let ids, matched, truncated = false;
    if (input.ids !== undefined) { ids = cleanIds(input.ids); matched = ids.length; }
    else {
        if (input.filters !== undefined && (!input.filters || typeof input.filters !== 'object' || Array.isArray(input.filters))) throw ApiError.badRequest('Choose valid delivery report filters.');
        const filters = input.filters || {};
        // Use exactly the report's date, campaign, audience group, channel and
        // search selection; outcome/page cannot broaden a failed-only review.
        const selected = Object.fromEntries(['from', 'to', 'campaignKey', 'group', 'channel', 'search']
            .filter(key => typeof filters[key] === 'string').map(key => [key, filters[key]]));
        if (['from', 'to', 'campaignKey', 'group', 'channel', 'search'].some(key => filters[key] !== undefined && typeof filters[key] !== 'string')) throw ApiError.badRequest('Delivery report filter values must be text.');
        if (['from', 'to'].some(key => selected[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(selected[key]) || !Number.isFinite(Date.parse(selected[key]))))
            || (selected.from && selected.to && selected.from > selected.to)
            || (selected.channel && !['email', 'whatsapp', 'push', 'in_app'].includes(selected.channel))
            || (selected.group && !['publication', 'automation'].includes(selected.group))
            || (selected.campaignKey && (!/^(publication|automation):/.test(selected.campaignKey) || selected.campaignKey.length > 250))
            || (selected.search && selected.search.length > 120)) throw ApiError.badRequest('Choose valid delivery report filters before reviewing retries.');
        const report = await require('./deliveryReport').report({ ...selected, status: 'failed', page: 1, limit: LIMIT });
        ids = report.rows.map(row => row._id);
        matched = report.pagination.total;
        truncated = matched > ids.length;
    }
    const reasons = [], eligible = [], versions = [], reviewedRows = [];
    const started = Date.now();
    let cursor = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < ids.length && Date.now() - started < START_SEND_WINDOW_MS) {
            const index = cursor++, id = ids[index];
            try {
                const record = await policy.resolve(id);
                reviewedRows[index] = { id, version: record.version, reason: await policy.reason(record) };
            } catch { reviewedRows[index] = { id, reason: 'Current delivery or recipient eligibility could not be verified.' }; }
        }
    }));
    for (const row of reviewedRows) {
        if (!row) continue;
        if (row.reason) addReason(reasons, row.reason);
        else { eligible.push(row.id); versions.push(row.version); }
    }
    const reviewed = reviewedRows.filter(Boolean).length;
    const remaining = matched - reviewed;
    truncated ||= remaining > 0;
    let token = '', statusToken = '';
    if (eligible.length) {
        const iat = Math.floor(Date.now() / 1000);
        const lifetime = { iat, exp: iat + 600 };
        const options = { algorithm: 'HS256', audience, subject: String(actor), jwtid: crypto.randomUUID() };
        token = jwt.sign({ ...lifetime, purpose: 'retry', ids: eligible, versions }, config.jwt.secret, options);
        // A full 100-row review belongs in the request body. Keep status polling
        // comfortably below proxy single-header limits, with the same batch ID.
        statusToken = jwt.sign({ ...lifetime, purpose: 'status' }, config.jwt.secret, options);
    }
    return { matched, reviewed, remaining, eligible: eligible.length, skipped: reviewed - eligible.length, reasons, ids: eligible, token, statusToken, truncated };
}

async function retryRecord(record) {
    if (record.kind === 'log') {
        const result = await require('./notification.service').retryLog(record.row._id, { strict: true });
        if (!result || result.skipped) return { status: 'skipped', reason: result?.reason || 'This delivery is no longer available.' };
        if (result.waiting) return { status: 'queued', reason: result.reason };
        return { status: result.outcome?.success && !result.outcome?.mock ? 'sent' : 'failed',
            reason: result.outcome?.success ? undefined : result.reason || result.outcome?.error || 'The provider did not accept this retry.' };
    }
    const row = record.row;
    const push = record.kind === 'push';
    const Model = push ? Notification : VisitorDelivery;
    const prefix = push ? 'push.' : '';
    const updated = await Model.updateOne({ _id: row._id, updatedAt: row.updatedAt, [`${prefix}status`]: 'failed',
        [`${prefix}openedAt`]: null, ...(push ? { 'push.sentTokens.0': { $exists: false } } : { sentAt: null }) }, {
        $set: { [`${prefix}status`]: 'pending', [`${prefix}nextAttemptAt`]: new Date(), [`${prefix}leaseUntil`]: null },
        $unset: { [`${prefix}worker`]: 1 },
    });
    return updated.matchedCount ? { status: 'queued' } : { status: 'skipped', reason: 'This delivery changed or was already queued.' };
}

async function execute(input = {}, actor) {
    if (!actor) throw ApiError.unauthorized('An authenticated administrator is required.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw ApiError.badRequest('Submit the reviewed delivery rows and token.');
    const ids = cleanIds(input.ids);
    const snapshot = verifyReview(input.token, actor);
    if (snapshot.purpose === 'status' || !snapshot.jti || !Array.isArray(snapshot.versions)
        || snapshot.versions.length !== ids.length || JSON.stringify(ids) !== JSON.stringify(snapshot.ids)) {
        throw ApiError.badRequest('Retry only the exact deliveries in the reviewed selection. A status token cannot authorize retries.');
    }
    await ensureIndexes();
    const key = batchKey(snapshot);
    let batch;
    const summary = emptySummary();
    try { batch = await Batch.create({ key, requestedBy: String(actor), ids, summary }); }
    catch (error) {
        if (error.code !== 11000) throw error;
        const prior = await Batch.findOne({ key }).lean();
        return { ...(prior?.summary || summary), alreadySubmitted: true, processing: prior?.status !== 'done' };
    }
    // A durable batch claim makes duplicate confirmations harmless. Interrupted
    // batches are held for review rather than restarting uncertain sends.
    const started = Date.now();
    for (const [index, id] of ids.entries()) {
        if (Date.now() - started >= START_SEND_WINDOW_MS) {
            const reason = 'The batch time limit was reached. Preview remaining failures again.';
            const remaining = ids.slice(index).map(id => ({ id, at: new Date(), status: 'skipped', reason }));
            summary.skipped += remaining.length;
            summary.reasons.push({ reason, count: remaining.length });
            await Batch.updateOne({ _id: batch._id }, { $set: { summary }, $push: { results: { $each: remaining } } });
            break;
        }
        let record, result;
        try {
            record = await policy.resolve(id);
            const reason = record.version !== snapshot.versions[index] ? 'This delivery changed after review; preview it again.' : await policy.reason(record);
            result = reason ? { status: 'skipped', reason } : await retryRecord(record);
        } catch { result = { status: 'skipped', reason: 'Current delivery or recipient eligibility could not be verified.' }; }
        summary[result.status]++;
        if (result.status !== 'skipped') summary.attempted++;
        if (result.reason) addReason(summary.reasons, result.reason);
        // Keep the actor, exact row, old failure and cumulative attempts in an
        // audit record; queue resets never erase the previous delivery history.
        await Batch.updateOne({ _id: batch._id }, { $set: { summary }, $push: { results: {
            id, at: new Date(), ...result, channel: record?.channel,
            previousAttempts: record?.kind === 'push' ? record.row?.push?.attempts
                : record?.notice?.updateDelivery?.[record.channel]?.attempts ?? record?.row?.attempts,
            previousError: record?.kind === 'push' ? record.row?.push?.lastError : record?.row?.failureReason || record?.row?.lastError,
        } } });
    }
    await Batch.updateOne({ _id: batch._id }, { $set: { status: 'done', summary } });
    return summary;
}

async function status(token, actor) {
    const snapshot = verifyReview(token, actor);
    const batch = await Batch.findOne({ key: batchKey(snapshot), requestedBy: String(actor) }).lean();
    return { ...(batch?.summary || emptySummary()), found: !!batch, processing: batch?.status === 'processing' };
}
module.exports = { preview, execute, status, LIMIT };
