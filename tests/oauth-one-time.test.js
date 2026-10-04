const assert = require('node:assert/strict');
let redis = null;
require('../src/config/redis').getRedisClient = () => redis;
const cache = require('../src/core/cache/cacheClient');
(async () => {
    const attempts = await Promise.all([cache.claim('oauth:test', 1, 60), cache.claim('oauth:test', 1, 60)]);
    assert.equal(attempts.filter(Boolean).length, 1);
    cache.memoryCache.set('oauth:test', { value: 1, expiry: Date.now() - 1 });
    assert.equal(await cache.claim('oauth:test', 1, 60), true);
    let held = false;
    redis = { set: async (key, value, options) => {
        assert.deepEqual(options, { NX: true, EX: 60 });
        if (held) return null;
        held = true; return 'OK';
    } };
    assert.equal(await cache.claim('oauth:redis', 1, 60), true);
    assert.equal(await cache.claim('oauth:redis', 1, 60), false);
    redis.set = async () => { throw new Error('Redis unavailable'); };
    await assert.rejects(cache.claim('oauth:redis-failed', 1, 60), /Redis unavailable/);
    console.log('OAuth one-time claims passed: concurrent memory use, expiry, Redis NX and fail-closed Redis outage.');
    process.exit(0);
})().catch(error => { console.error(error.stack); process.exit(1); });
