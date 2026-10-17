// Loopback HTTP, fake remote stores and a disposable disk cache only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { Readable } = require('node:stream');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activ-media-performance-'));
const uploadsDir = path.resolve(__dirname, '../uploads');
const cachePath = file => path.join(directory, path.relative(uploadsDir, file));
const fakeFs = { ...fs,
    mkdirSync: (file, options) => fs.mkdirSync(cachePath(file), options),
    createWriteStream: file => fs.createWriteStream(cachePath(file)),
    rename: (from, to, done) => fs.rename(cachePath(from), cachePath(to), done),
    unlink: (file, done) => fs.unlink(cachePath(file), done),
};
let png, mode = 'good', objectReads = 0, gridReads = 0;
const objectStore = {
    isEnabled: () => true,
    async getObject(name, range) {
        objectReads++;
        await new Promise(resolve => setTimeout(resolve, 15));
        if (mode === 'unavailable') return { unavailable: true };
        if (mode === 'grid') return null;
        const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
        const body = mode === 'truncated'
            ? Readable.from((async function* () { yield png.subarray(0, 10); throw Error('Interrupted storage read'); })())
            : Readable.from(match ? png.subarray(Number(match[1]), Number(match[2]) + 1) : png);
        return { body, contentType: 'image/png', contentLength: match ? Number(match[2]) - Number(match[1]) + 1 : png.length,
            contentRange: match ? `bytes ${match[1]}-${match[2]}/${png.length}` : '' };
    },
};
const bucket = {
    find() { return { sort() { return this; }, limit() { return this; }, async toArray() {
        return mode === 'grid' ? [{ _id: 'fixture', length: png.length, metadata: { contentType: 'image/png' } }] : [];
    } }; },
    openDownloadStream() { gridReads++; return Readable.from(png); },
};
const realLoad = Module._load;
Module._load = function(specifier, parent, ...args) {
    const owner = parent?.filename || '';
    if (owner.endsWith(path.join('storage', 'uploadStore.js'))) {
        if (specifier === 'fs') return fakeFs;
        if (specifier === './objectStore') return objectStore;
        if (specifier === 'mongoose') return { connection: { readyState: 1 }, mongo: { GridFSBucket: function() { return bucket; } } };
        if (specifier === '../../config/dataLayout') return { UPLOADS: { bucket: 'test', area: 'test' }, nativeDb: () => ({}) };
    }
    if (owner.endsWith(path.join('storage', 'legacyUploads.js')) && specifier === '../../config') return { objectStorage: { legacyOrigins: [] } };
    if (owner.includes(path.sep + 'storage' + path.sep) && specifier === '../../config/logger') return { warn() {}, info() {} };
    return realLoad.call(this, specifier, parent, ...args);
};
const uploads = require('../src/core/storage/uploadStore');
const { makeVariantMiddleware } = require('../src/core/storage/imageVariants');
const { blockPublicFiles } = require('../src/modules/messages/messageAttachments');
const settle = async check => {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Disk cache did not settle');
};

(async () => {
    try {
        png = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#224488' } }).png().toBuffer();
        const app = express();
        app.use('/uploads', blockPublicFiles,
            makeVariantMiddleware({ uploadsDir: directory, objectStore, bucket: () => bucket }), express.static(directory),
            uploads.serveFromBucket, uploads.serveFromDatabase, uploads.serveFromLegacy, uploads.serveUnavailable);
        app.use((_req, res) => res.status(404).end());

        const variants = await Promise.all([
            request(app).get('/uploads/banner.png?w=320').set('Accept', 'image/webp').expect(200),
            request(app).get('/uploads/banner.png?w=640').set('Accept', 'image/webp').expect(200),
            request(app).get('/uploads/banner.png?w=320').set('Accept', 'image/jpeg').expect(200),
        ]);
        assert.equal(objectReads, 1, 'concurrent sizes and formats share one source download');
        assert.equal((await sharp(variants[0].body).metadata()).width, 320);
        assert.equal((await sharp(variants[1].body).metadata()).width, 640);
        assert.equal((await sharp(variants[2].body).metadata()).format, 'jpeg');
        assert.deepEqual(await fs.promises.readFile(path.join(directory, 'banner.png')), png);
        await request(app).get('/uploads/banner.png?w=1024').set('Accept', 'image/webp').expect(200);
        assert.deepEqual((await request(app).get('/uploads/banner.png').expect(200)).body, png);
        assert.equal(objectReads, 1, 'later widths and original delivery use the restored disk source');
        assert.ok(variants[0].headers.etag);
        await request(app).get('/uploads/banner.png?w=320').set('Accept', 'image/webp')
            .set('If-None-Match', variants[0].headers.etag).expect(304);
        await request(app).head('/uploads/banner.png?w=320').set('Accept', 'image/webp').expect(200)
            .expect('Content-Length', String(variants[0].body.length));

        let before = objectReads;
        assert.deepEqual((await request(app).get('/uploads/original.png').expect(200)).body, png);
        await settle(() => fs.existsSync(path.join(directory, 'original.png')));
        assert.equal(objectReads - before, 1, 'original S3 response and disk restore use the same stream');
        assert.deepEqual(await fs.promises.readFile(path.join(directory, 'original.png')), png);

        mode = 'grid';
        assert.deepEqual((await request(app).get('/uploads/database.png').expect(200)).body, png);
        await settle(() => fs.existsSync(path.join(directory, 'database.png')));
        assert.equal(gridReads, 1, 'original GridFS response and disk restore use the same stream');
        assert.deepEqual(await fs.promises.readFile(path.join(directory, 'database.png')), png);

        mode = 'good';
        await request(app).get('/uploads/range.png').set('Range', 'bytes=0-9').expect(206).expect('Content-Length', '10');
        await request(app).head('/uploads/head.png').expect(200);
        assert.equal(fs.existsSync(path.join(directory, 'range.png')), false, 'partial responses never become complete cache entries');
        assert.equal(fs.existsSync(path.join(directory, 'head.png')), false, 'HEAD does not consume/cache an original body');

        mode = 'truncated';
        await assert.rejects(request(app).get('/uploads/truncated.png'));
        await settle(async () => !(await fs.promises.readdir(directory)).some(name => name.includes('truncated')));

        mode = 'unavailable';
        await request(app).get('/uploads/retry.png?w=320').expect(503).expect('Cache-Control', 'no-store');
        assert.equal(fs.existsSync(path.join(directory, 'retry.png')), false);
        mode = 'good';
        await request(app).get('/uploads/retry.png?w=320').expect(200);

        before = objectReads;
        await request(app).get('/uploads/chat-files/private/photo.png?w=320').expect(404);
        await request(app).get('/uploads/chat-audio/private/photo.png?w=320').expect(404);
        assert.equal(objectReads, before, 'private chat guard runs before every cache/store');
        assert.equal((await fs.promises.readdir(path.join(directory, '.variants'))).some(name => name.endsWith('.tmp')), false);
        console.log('PASS: one download across concurrent image sizes; reusable original cache; conditional 304/HEAD; one original S3/GridFS stream; safe ranges, interrupted reads and recovery; private chat guard.');
    } finally {
        Module._load = realLoad;
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'activ-media-performance-'));
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
