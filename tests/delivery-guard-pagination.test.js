// Retry selection fixtures only: no database, scheduler, email or WhatsApp.
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);
const NotificationLog = require('../src/modules/notifications/notificationLog.model');
const service = require('../src/modules/notifications/notification.service');
const eligibility = require('../src/modules/notifications/retryEligibility');
const guard = require('../src/modules/notifications/deliveryGuard');
require('../src/config/logger').silent = true;
const clone = value => structuredClone(value);
const baseTime = new Date(Date.now() - 60 * 60 * 1000);
let rows = [], queries = [], claims = [], providerAttempts = [], nextId = 0;
const field = (row, name) => name.split('.').reduce((value, key) => value?.[key], row);
const scalar = value => value instanceof Date ? value.getTime() : value;
const matches = (row, filter) => !!row && Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(clause => matches(row, clause));
    if (key === '$and') return expected.every(clause => matches(row, clause));
    const actual = field(row, key);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        return Object.entries(expected).every(([op, operand]) => {
            if (op === '$exists') return (actual !== undefined) === operand;
            if (op === '$in') return operand.includes(actual);
            if (op === '$nin') return !operand.includes(actual);
            if (op === '$ne') return actual !== operand;
            if (op === '$gt') return scalar(actual) > scalar(operand);
            if (op === '$gte') return scalar(actual) >= scalar(operand);
            if (op === '$lte') return scalar(actual) <= scalar(operand);
            throw Error(`Unsupported fixture operator ${op}`);
        });
    }
    return scalar(actual) === scalar(expected);
});
const makeRow = extra => ({ _id: (++nextId).toString(16).padStart(24, '0'),
    event: 'EVENT_REGISTERED', channel: 'whatsapp', provider: 'meta', recipient: '919999999999',
    status: 'failed', deliveryStatus: 'failed', lastError: 'ETIMEDOUT', createdAt: clone(baseTime), ...extra });
const reset = () => { rows = []; queries = []; claims = []; providerAttempts = []; nextId = 0; };
const add = (count, extra) => {
    const batch = Array.from({ length: count }, () => makeRow(extra)); rows.push(...batch); return batch;
};
NotificationLog.find = filter => {
    const request = { filter: clone(filter) }; queries.push(request);
    return {
        sort(order) { request.sort = clone(order); return this; },
        limit(value) { request.limit = value; return this; },
        async lean() {
            const found = rows.filter(row => matches(row, filter)).sort((a, b) => {
                for (const [key, direction] of Object.entries(request.sort)) {
                    const av = scalar(field(a, key)), bv = scalar(field(b, key));
                    if (av !== bv) return (av < bv ? -1 : 1) * direction;
                }
                return 0;
            }).slice(0, request.limit);
            request.returned = found.length;
            return clone(found);
        }
    };
};
NotificationLog.findById = id => ({ lean: async () => clone(rows.find(row => row._id === String(id)) || null) });
NotificationLog.updateOne = async (filter, update) => {
    const row = rows.find(value => matches(value, filter));
    if (!row) return { matchedCount: 0 };
    claims.push(row._id);
    row.autoRetry = { count: Number(row.autoRetry?.count || 0) + update.$inc['autoRetry.count'],
        lastAt: update.$set['autoRetry.lastAt'] };
    return { matchedCount: 1 };
};
eligibility.reasonToSkip = async row => row.data?.replyDeferred ? 'An earlier reply part is still waiting.' : '';
service.retryLog = async id => {
    const row = rows.find(value => value._id === id);
    if (row.data?.stateStale) return { skipped: true, reason: 'The underlying membership state has changed.' };
    providerAttempts.push(id);
    row.status = 'sent'; row.deliveryStatus = 'accepted';
    return { outcome: { success: true } };
};
const checkPages = () => {
    assert(queries.length > 1, 'The scan must continue beyond its first page');
    for (const query of queries) {
        assert.equal(query.limit, 50, 'Candidate reads stay bounded to a fixed-size page');
        assert.deepEqual(query.sort, { createdAt: 1, _id: 1 }, 'Equal timestamps must use a stable ID tie-breaker');
        assert.deepEqual(query.filter.createdAt, queries[0].filter.createdAt, 'Time boundaries remain fixed across pages');
    }
    assert(queries.slice(1).every(query => query.filter.$and?.[0].$or?.length === 2), 'Later pages use a keyset cursor');
};

async function main() {
    reset();
    const permanent = add(55, { lastError: 'Invalid phone number' });
    const exhausted = add(55, { autoRetry: { count: 3, lastAt: new Date() } });
    const deferred = add(55, { event: 'BOT_REPLY', data: { replyDeferred: true },
        lastError: 'Earlier reply part temporarily failed; this part has not been sent.' });
    const stateStale = add(55, { event: 'PAYMENT_REQUIRED', data: { stateStale: true } });
    const [eligible] = add(1, {});
    const excluded = [
        ...add(1, { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }),
        ...add(1, { createdAt: new Date(Date.now() + 60 * 60 * 1000) }),
        ...add(1, { data: { autoRetryDisabled: true } }),
        ...add(1, { mock: true }),
        ...add(1, { event: 'PASSWORD_RESET' }),
    ];
    const result = await guard.retryFailed({ auto: true, limit: 1 });
    assert.equal(result.checked, 221, 'Every category of skipped failure is traversed before the eligible row');
    assert.equal(result.retried, 1);
    assert.equal(result.sent, 1);
    assert.equal(result.permanent, 55);
    assert.equal(result.skipped, 165);
    assert.deepEqual(providerAttempts, [eligible._id]);
    assert(![...permanent, ...exhausted, ...deferred, ...excluded].some(row => claims.includes(row._id)));
    assert(deferred.every(row => !row.autoRetry), 'Waiting reply parts spend no retry budget');
    assert(stateStale.every(row => row.autoRetry.count === 1), 'State skips do not consume the run provider-attempt limit');
    checkPages();
    assert.equal(queries.length, 5);
    assert.equal(+queries[0].filter.createdAt.$lte - +queries[0].filter.createdAt.$gte, 24 * 60 * 60 * 1000);

    reset();
    add(150, { lastError: 'Invalid phone number' });
    const eligibleBatch = add(3, {});
    const bounded = await guard.retryFailed({ auto: true, limit: 2 });
    assert.equal(bounded.sent, 2, 'The attempt limit applies to provider calls, after skipped pages');
    assert.equal(bounded.checked, 152);
    assert.deepEqual(providerAttempts, eligibleBatch.slice(0, 2).map(row => row._id));
    checkPages();
    queries = [];
    const remainder = await guard.retryFailed({ auto: true, limit: 2 });
    assert.equal(remainder.sent, 1, 'Successful rows leaving the candidate set cannot skip the remaining failure');
    assert.equal(remainder.checked, 151);
    assert.deepEqual(providerAttempts, eligibleBatch.map(row => row._id));
    checkPages();

    reset();
    const [old] = add(1, { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });
    assert.equal((await guard.retryFailed({ auto: true })).checked, 0, 'Automatic scans do not widen their 24-hour window');
    assert.equal(providerAttempts.length, 0);
    assert.equal((await guard.retryFailed({ auto: false, sinceHours: 168, limit: 1 })).sent, 1,
        'An explicitly requested manual window remains supported');
    assert.deepEqual(providerAttempts, [old._id]);
    console.log('PASS retry pagination: permanent/exhausted/deferred/stale pages, equal timestamps, attempt limits, changing failed set and unchanged history windows.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
