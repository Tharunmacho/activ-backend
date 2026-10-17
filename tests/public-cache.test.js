const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

// Isolate the cross-worker invalidation marker from any local running server.
process.env.PORT = `cache-test-${process.pid}`;
process.env.PUBLIC_CACHE = 'true';
process.env.PUBLIC_CACHE_SECONDS = '5';
const loggerPath = require.resolve('../src/config/logger');
require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { info() {} } };
const { publicCache, clearOnWrite, clear, TTL_MS } = require('../src/core/middleware/publicCache');
const stampFile = path.join(os.tmpdir(), `activ-public-cache-${process.env.PORT}.stamp`);

beforeEach(clear);
after(() => { clear(); fs.rmSync(stampFile, { force: true }); });

function appWith(read) {
    const app = express();
    app.use('/api/v1', clearOnWrite);
    app.use((_req, res, next) => { res.vary('Origin'); next(); });
    app.get('/api/v1/cms/home', publicCache, read);
    app.all('/api/v1/*', (req, res) => res.status(req.query.fail ? 500 : 200).json({ success: true }));
    return app;
}
const home = '/api/v1/cms/home';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('cold requests for the same URL share one read and preserve existing Vary headers', async () => {
    let reads = 0;
    const app = appWith((_req, res) => {
        reads += 1;
        setTimeout(() => res.json({ version: 1 }), 40);
    });
    const replies = await Promise.all(Array.from({ length: 12 }, () => request(app).get(home)));
    assert.equal(reads, 1);
    assert.equal(replies.filter(reply => reply.headers['x-public-cache'] === 'MISS').length, 1);
    for (const reply of replies) {
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, { version: 1 });
        assert.equal(reply.headers['cache-control'], 'no-cache');
        assert.match(reply.headers.vary, /Origin/);
        assert.match(reply.headers.vary, /Authorization/);
    }
    await request(app).get(home).expect('X-Public-Cache', 'HIT');
    assert.equal(reads, 1);
});

test('query variants and authenticated readers never share public or private responses', async () => {
    let reads = 0;
    const app = appWith((req, res) => {
        reads += 1;
        setTimeout(() => res.json({ audience: req.headers.authorization || 'public', query: req.query }), 20);
    });
    const [publicReply, firstMember, secondMember, variant] = await Promise.all([
        request(app).get(home),
        request(app).get(home).set('Authorization', 'Bearer first'),
        request(app).get(home).set('Authorization', 'Bearer second'),
        request(app).get(`${home}?view=other`),
    ]);
    assert.equal(reads, 4);
    assert.equal(publicReply.body.audience, 'public');
    assert.equal(firstMember.body.audience, 'Bearer first');
    assert.equal(secondMember.body.audience, 'Bearer second');
    assert.deepEqual(variant.body.query, { view: 'other' });
    assert.equal(firstMember.headers['x-public-cache'], undefined);
    assert.equal(secondMember.headers['x-public-cache'], undefined);
    const cached = await request(app).get(home).expect('X-Public-Cache', 'HIT');
    assert.equal(cached.body.audience, 'public');
});

test('a forged warm-up header cannot bypass a cached response', async () => {
    let reads = 0;
    const app = appWith((_req, res) => res.json({ read: ++reads }));
    await request(app).get(home).expect('X-Public-Cache', 'MISS');
    await request(app).get(home).set('x-public-cache-refresh', '0'.repeat(48)).expect('X-Public-Cache', 'HIT');
    assert.equal(reads, 1);
});

test('notification device registration and read receipts leave public content warm', async () => {
    let reads = 0;
    const app = appWith((_req, res) => res.json({ read: ++reads }));
    const notificationId = '1234567890abcdef12345678';
    await request(app).get(home);
    for (const [method, route] of [
        ['post', '/public-notifications/installations'],
        ['put', '/public-notifications/devices'],
        ['delete', '/public-notifications/devices'],
        ['patch', `/public-notifications/${notificationId}/open`],
        ['post', '/notifications/push/devices'],
        ['delete', '/notifications/push/devices'],
        ['patch', '/notifications/read-all'],
        ['patch', '/notifications/update-preferences'],
        ['patch', `/notifications/${notificationId}/read`],
        ['patch', `/notifications/${notificationId}/open`],
    ]) {
        await request(app)[method](`/api/v1${route}`).expect(200);
        await request(app).get(home).expect('X-Public-Cache', 'HIT');
    }
    assert.equal(reads, 1);
});

test('CMS, event, plan, region and unknown successful writes invalidate immediately', async () => {
    let reads = 0;
    const app = appWith((_req, res) => res.json({ read: ++reads }));
    for (const route of ['/cms/home', '/events/one', '/admin/super/membership/plans/paid', '/regions/state', '/future-content']) {
        await request(app).get(home);
        const beforeWrite = reads;
        await request(app).put(`/api/v1${route}`).expect(200);
        await request(app).get(home).expect('X-Public-Cache', 'MISS');
        assert.equal(reads, beforeWrite + 1, route);
    }
    await request(app).put('/api/v1/cms/home?fail=true').expect(500);
    await request(app).get(home).expect('X-Public-Cache', 'HIT');
});

test('a save during a slow read cannot refill the cache with the old response', async () => {
    const started = deferred();
    const release = deferred();
    let version = 1;
    let reads = 0;
    const app = appWith(async (_req, res) => {
        reads += 1;
        const snapshot = version;
        if (reads === 1) { started.resolve(); await release.promise; }
        res.json({ version: snapshot });
    });
    const first = request(app).get(home).then(reply => reply);
    await started.promise;
    version = 2;
    await request(app).put('/api/v1/cms/home');
    release.resolve();
    assert.equal((await first).body.version, 1);
    const fresh = await request(app).get(home).expect('X-Public-Cache', 'MISS');
    assert.equal(fresh.body.version, 2);
    await request(app).get(home).expect('X-Public-Cache', 'HIT');
    assert.equal(reads, 2);
});

test('a concurrent worker invalidation is observed on the very next request', async () => {
    let reads = 0;
    const app = appWith((_req, res) => res.json({ read: ++reads }));
    await request(app).get(home);
    const changedAt = new Date(fs.statSync(stampFile).mtimeMs + 1000);
    fs.utimesSync(stampFile, changedAt, changedAt);
    await request(app).get(home).expect('X-Public-Cache', 'MISS');
    assert.equal(reads, 2);
});

test('failed and non-JSON leaders release followers without caching their responses', async () => {
    for (const responseType of ['error', 'text']) {
        clear();
        let reads = 0;
        const app = appWith((_req, res) => {
            const number = ++reads;
            setTimeout(() => {
                if (number === 1 && responseType === 'error') return res.status(503).json({ error: true });
                if (number === 1) return res.type('text').send('not JSON');
                res.json({ fresh: true });
            }, 30);
        });
        const replies = await Promise.all([request(app).get(home), request(app).get(home)]);
        assert.equal(reads, 2);
        assert.equal(replies[0].status, responseType === 'error' ? 503 : 200);
        assert.deepEqual(replies[1].body, { fresh: true });
        // The follower fell through independently, so the next request warms
        // the cache again and cannot reuse the failed leader's body.
        const next = await request(app).get(home).expect('X-Public-Cache', 'MISS');
        assert.deepEqual(next.body, { fresh: true });
    }
});

test('an aborted leader releases the next reader', async () => {
    const started = deferred();
    let reads = 0;
    const app = appWith((_req, res) => {
        reads += 1;
        if (reads === 1) return started.resolve();
        res.json({ fresh: true });
    });
    const server = app.listen(0);
    try {
        const leader = request(server).get(home);
        leader.end(() => {});
        await started.promise;
        leader.abort();
        await nextTurn();
        const reply = await request(server).get(home).timeout(1000).expect(200);
        assert.deepEqual(reply.body, { fresh: true });
        assert.equal(reads, 2);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});

test('expired entries are refreshed while disabled caching always reads independently', async () => {
    let reads = 0;
    const app = appWith((_req, res) => res.json({ read: ++reads }));
    await request(app).get(home);
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + TTL_MS + 1;
        await request(app).get(home).expect('X-Public-Cache', 'MISS');
    } finally { Date.now = realNow; }
    assert.equal(reads, 2);
    process.env.PUBLIC_CACHE = 'false';
    try {
        const reply = await request(app).get(home);
        assert.equal(reply.headers['x-public-cache'], undefined);
        assert.equal(reads, 3);
    } finally { process.env.PUBLIC_CACHE = 'true'; }
});
