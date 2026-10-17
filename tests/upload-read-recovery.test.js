// Loopback HTTP, fake S3/GridFS and a temporary variant cache only.
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { Readable, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

const realLoad = Module._load;
const realTimeout = global.setTimeout;
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
let mode = 'good', gridFile = null, aborted = 0;
const commands = [], streamTimeouts = [];
const pngPromise = sharp({ create: { width: 640, height: 320, channels: 3, background: '#224488' } }).png().toBuffer();
const storage = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'image/png');
    if (req.url === '/idle') { res.setHeader('Content-Length', '9000'); res.flushHeaders(); return; }
    if (req.url === '/progress') {
        res.flushHeaders();
        for (let i = 0; i < 8; i++) { res.write('part'); await new Promise(resolve => realTimeout(resolve, 25)); }
        return res.end();
    }
    res.end(await pngPromise);
});
const bucket = {
    find() { return { sort() { return this; }, limit() { return this; }, async toArray() { return gridFile ? [{ _id: 'fixture', length: gridFile.length, metadata: { contentType: 'image/png' } }] : []; } }; },
    openDownloadStream() { return Readable.from(gridFile); },
};
class GetObjectCommand { constructor(input) { this.input = input; } }
class PutObjectCommand { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
class HeadObjectCommand { constructor(input) { this.input = input; } }
class S3Client {
    constructor(options) { assert.equal(options.maxAttempts, 3, 'write retry policy retained'); }
    send(command, options) {
        commands.push({ kind: command.constructor.name, options, input: command.input });
        if (!(command instanceof GetObjectCommand)) return Promise.resolve({});
        if (mode === 'missing') return Promise.reject(Object.assign(Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }));
        if (mode === 'range') return Promise.reject(Object.assign(Error('range'), { $metadata: { httpStatusCode: 416 } }));
        if (mode === 'unavailable') return Promise.reject(Error('unreachable bucket'));
        if (mode === 'headers') return new Promise((resolve, reject) => options.abortSignal.addEventListener('abort', () => { aborted++; reject(Object.assign(Error('aborted'), { name: 'AbortError' })); }, { once: true }));
        return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${storage.address().port}/${mode}`, res => {
            const original = res.setTimeout.bind(res);
            res.setTimeout = (ms, callback) => { streamTimeouts.push(ms); return original(ms === 10000 ? 80 : ms, callback); };
            resolve({ Body: res, ContentType: 'image/png', ContentLength: Number(res.headers['content-length'] || 0) });
        }).on('error', reject));
    }
}
const fakeFs = { ...fs, mkdirSync() {}, rename(_from, _to, done) { done(); }, unlink(_file, done) { done(); }, createWriteStream() { return new Writable({ write(_chunk, _encoding, done) { done(); } }); } };
Module._load = function(specifier, parent, ...args) {
    const owner = parent?.filename || '';
    if (owner.endsWith(path.join('storage', 'objectStore.js'))) {
        if (specifier === '../../config') return { objectStorage: { isConfigured: true, bucket: 'test', legacyOrigins: [] } };
        if (specifier === '@aws-sdk/client-s3') return { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand };
    }
    if (owner.endsWith(path.join('storage', 'uploadStore.js'))) {
        if (specifier === 'fs') return fakeFs;
        if (specifier === 'mongoose') return { connection: { readyState: 1 }, mongo: { GridFSBucket: function() { return bucket; } } };
        if (specifier === '../../config/dataLayout') return { UPLOADS: { bucket: 'test', area: 'test' }, nativeDb: () => ({}) };
    }
    if (owner.endsWith(path.join('storage', 'legacyUploads.js')) && specifier === '../../config') return { objectStorage: { legacyOrigins: [] } };
    if (owner.includes(path.sep + 'storage' + path.sep) && specifier === '../../config/logger') return { warn() {}, info() {} };
    return realLoad.call(this, specifier, parent, ...args);
};
const objectStore = require('../src/core/storage/objectStore');
const uploadStore = require('../src/core/storage/uploadStore');
const { makeVariantMiddleware, readOriginal } = require('../src/core/storage/imageVariants');
// Accelerate only this module's five-second GET deadline, not HTTP/stream timers.
global.setTimeout = (fn, delay, ...args) => realTimeout(fn, delay === 5000 ? 40 : delay, ...args);

const read = async body => { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks); };
async function run() {
    await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'activ-read-recovery-'));
    try {
        const png = await pngPromise;
        let object = await objectStore.getObject('fixture.png');
        assert.deepEqual(await read(object.body), png);
        assert(streamTimeouts.includes(10000), 'idle timeout enabled');
        mode = 'headers';
        assert.deepEqual(await objectStore.getObject('fixture.png'), { unavailable: true });
        assert.equal(aborted, 1, 'a stalled GET is actually aborted');
        const afterTimeout = commands.length;
        assert.deepEqual(await objectStore.getObject('another.png'), { unavailable: true });
        assert.equal(commands.length, afterTimeout, 'a brief cooldown skips repeated stalled bucket reads');
        clockOffset += 15001;
        mode = 'missing';
        assert.equal(await objectStore.getObject('fixture.png'), null);
        mode = 'range';
        assert.deepEqual(await objectStore.getObject('fixture.png', 'bytes=99-'), { unsatisfiable: true });
        mode = 'idle';
        object = await objectStore.getObject('fixture.png');
        await assert.rejects(read(object.body), /stalled/);
        mode = 'progress';
        object = await objectStore.getObject('fixture.png');
        assert.equal((await read(object.body)).toString(), 'part'.repeat(8), 'active streams may exceed the idle deadline');

        const app = express();
        app.use('/uploads', uploadStore.serveFromBucket, uploadStore.serveFromDatabase, uploadStore.serveFromLegacy, uploadStore.serveUnavailable);
        app.use((_req, res) => res.status(404).end());
        mode = 'headers'; gridFile = png;
        let result = await request(app).get('/uploads/fixture.png').expect(200);
        assert.deepEqual(result.body, png, 'aborted header read reaches GridFS');
        clockOffset += 15001;
        mode = 'idle';
        result = await request(app).get('/uploads/fixture.png').expect(200);
        assert.deepEqual(result.body, png, 'stalled body before any bytes reaches GridFS with correct headers');
        assert.equal(Number(result.headers['content-length']), png.length);
        mode = 'unavailable'; gridFile = null;
        result = await request(app).get('/uploads/fixture.png').expect(503);
        assert.equal(result.headers['cache-control'], 'no-store');
        assert.equal(result.headers['retry-after'], '30');
        mode = 'missing';
        await request(app).get('/uploads/fixture.png').expect(404);

        mode = 'unavailable'; gridFile = png;
        assert.deepEqual(await readOriginal(directory, 'fixture.png', { objectStore, bucket: () => bucket }), png);
        const variants = express();
        variants.use('/uploads', makeVariantMiddleware({ uploadsDir: directory, objectStore, bucket: () => bucket }));
        result = await request(variants).get('/uploads/fixture.png?w=320').set('Accept', 'image/webp').expect(200);
        assert.equal((await sharp(result.body).metadata()).width, 320, 'variants recover through GridFS too');
        const fullChain = express();
        fullChain.use('/uploads', makeVariantMiddleware({ uploadsDir: directory, objectStore, bucket: () => bucket }),
            uploadStore.serveFromBucket, uploadStore.serveFromDatabase, uploadStore.serveFromLegacy, uploadStore.serveUnavailable);
        mode = 'headers'; gridFile = null;
        const beforeVariantFailure = commands.length;
        await Promise.all([request(fullChain).get('/uploads/absent.png?w=320').expect(503), request(fullChain).get('/uploads/absent.png?w=320').expect(503)]);
        assert.equal(commands.length - beforeVariantFailure, 1, 'shared variants and original fallback do not repeat the failed bucket read');
        await objectStore.putBuffer(png, 'fixture.png');
        const put = commands.find(item => item.kind === 'PutObjectCommand');
        assert.equal(put.options, undefined, 'read abort budget is never applied to writes');
        assert.equal(commands.some(item => item.kind === 'DeleteObjectCommand'), false, 'read recovery never deletes objects');
        console.log('PASS: bounded S3 GET headers and idle bodies; active streaming; original/variant GridFS fallback; temporary 503 versus real 404; unchanged writes and no deletion.');
    } finally {
        Module._load = realLoad;
        Date.now = realNow;
        global.setTimeout = realTimeout;
        storage.closeAllConnections();
        await new Promise(resolve => storage.close(resolve));
        if (path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'activ-read-recovery-')) await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
