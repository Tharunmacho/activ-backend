const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

// Load the real application and Express request getters without starting any
// database, storage, cache or notification services. The trust configuration
// is taken from src/app.js, so reverting it to one hop fails the bridge cases.
const appPath = require.resolve('../src/app');
const next = (_req, _res, done) => done();
const fixtures = {
    './config': { env: 'test', apiVersion: 'v1' },
    './routes': next,
    './core/middleware/security': () => {},
    './core/middleware/errorHandler': {
        notFound: next,
        errorHandler: (_error, _req, _res, done) => done(),
    },
    './core/middleware/rateLimit': { apiLimiter: next },
    './core/middleware/performance': { performanceMonitor: next },
    './core/middleware/publicCache': { clearOnWrite: next, isWarmRequest: () => false },
    './core/storage/uploadStore': {
        UPLOADS_DIR: path.join(__dirname, '../uploads'),
        serveFromBucket: next,
        serveFromDatabase: next,
        persistUploadsMiddleware: next,
        serveFromLegacy: next,
        serveUnavailable: next,
    },
    './core/storage/imageVariants': { makeVariantMiddleware: () => next },
    './modules/messages/messageAttachments': { blockPublicFiles: next },
};

const originalLoad = Module._load;
const previousApp = require.cache[appPath];
let app;
try {
    delete require.cache[appPath];
    Module._load = function (request, parent, isMain) {
        if (parent && parent.filename === appPath && request.startsWith('./')) {
            assert.ok(Object.hasOwn(fixtures, request), `Add an isolated fixture for ${request}`);
            return fixtures[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    app = require(appPath);
} finally {
    Module._load = originalLoad;
    if (previousApp) require.cache[appPath] = previousApp;
    else delete require.cache[appPath];
}

const bridge = '178.16.137.247';
const socketAddress = '10.0.1.2';
const cases = [
    ['direct client', '198.51.100.10', '198.51.100.10', ['198.51.100.10']],
    ['migration bridge', `203.0.113.42, ${bridge}`, '203.0.113.42', ['203.0.113.42', bridge]],
    ['IPv4-mapped bridge', `203.0.113.42, ::ffff:${bridge}`, '203.0.113.42', ['203.0.113.42', `::ffff:${bridge}`]],
    ['direct forged loopback prefix', '127.0.0.1, 198.51.100.10', '198.51.100.10', ['198.51.100.10']],
    ['bridged forged loopback prefix', `127.0.0.1, 198.51.100.10, ${bridge}`, '198.51.100.10', ['198.51.100.10', bridge]],
    ['unknown second hop', '203.0.113.42, 178.16.137.248', '178.16.137.248', ['178.16.137.248']],
    ['repeated bridge stops after hop 1', `127.0.0.1, ${bridge}, ${bridge}`, bridge, [bridge, bridge]],
    ['bridge at wrong hop', `127.0.0.1, ${bridge}, 198.51.100.11`, '198.51.100.11', ['198.51.100.11']],
    ['no forwarded header', undefined, socketAddress, []],
];

for (const [name, forwardedFor, expectedIp, expectedIps] of cases) {
    const req = Object.create(app.request);
    req.app = app;
    req.socket = { remoteAddress: socketAddress };
    req.headers = forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor };
    assert.equal(req.ip, expectedIp, `${name}: client address`);
    assert.deepEqual(req.ips, expectedIps, `${name}: accepted forwarding chain`);
}

console.log(`Migration proxy trust: ${cases.length} client-address and forwarding-chain cases passed.`);
