// Real image bytes and loopback HTTP; all provider calls are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

process.env.PUBLIC_MEDIA_URL = 'https://api.activ.example';
process.env.WHATSAPP_OWN_NUMBER = '919999999999';
const { whatsappImageUrl } = require('../src/modules/notifications/whatsappMedia');
const { makeVariantMiddleware } = require('../src/core/storage/imageVariants');
const meta = require('../src/modules/notifications/metaCloud.service');
const template = require('../src/modules/notifications/whatsappTemplate');
const legacyUploads = require('../src/core/storage/legacyUploads');

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activ-whatsapp-media-'));
    const originalConfigured = meta.isConfigured, originalSend = meta.sendTemplateMessage;
    try {
        const webp = await sharp({ create: { width: 1900, height: 950, channels: 4, background: '#22448880' } }).webp().toBuffer();
        await fs.writeFile(path.join(root, 'poster.webp'), webp);
        await fs.writeFile(path.join(root, 'broken.webp'), 'incomplete image');
        await fs.writeFile(path.join(root, 'space poster.webp'), webp);
        const app = express();
        app.use('/uploads', makeVariantMiddleware({ uploadsDir: root }), express.static(root));
        const normalized = whatsappImageUrl('https://retired.activ.example/uploads/poster.webp?w=320');
        assert.equal(normalized, 'https://api.activ.example/uploads/poster.webp?w=1600&format=jpeg');
        assert.equal(whatsappImageUrl(normalized), normalized, 'retry normalization is stable');
        assert.equal(whatsappImageUrl('/uploads/poster.png'), 'https://api.activ.example/uploads/poster.png?w=1600&format=jpeg');
        assert.equal(whatsappImageUrl('https://external.example/poster.jpg'), 'https://external.example/poster.jpg', 'external images are not fetched/proxied');
        const target = new URL(normalized);
        const response = await request(app).get(target.pathname + target.search).set('Accept', 'image/avif,image/webp,*/*').expect(200).expect('Content-Type', /image\/jpeg/);
        const info = await sharp(response.body).metadata();
        assert.equal(info.format, 'jpeg', 'actual encoded bytes must be JPEG, not just MIME/extension');
        assert.equal(info.width, 1600);
        assert.equal(info.height, 800);
        assert.ok(response.body.length < 5 * 1024 * 1024);
        const cached = await request(app).get(target.pathname + target.search).set('Accept', 'image/webp').expect(200);
        assert.deepEqual(cached.body, response.body);
        await request(app).head(target.pathname + target.search).set('Accept', 'image/webp').expect(200).expect('Content-Type', /image\/jpeg/);
        const browser = await request(app).get('/uploads/poster.webp?w=1600').set('Accept', 'image/webp').expect(200);
        assert.equal((await sharp(browser.body).metadata()).format, 'webp', 'browser optimization remains enabled');
        assert.deepEqual((await request(app).get('/uploads/poster.webp').expect(200)).body, webp, 'source preserved');
        await request(app).get('/uploads/broken.webp?w=1600&format=jpeg').expect(503).expect('Cache-Control', 'no-store');
        await request(app).get('/uploads/missing.webp?w=1600&format=jpeg').expect(503).expect('Cache-Control', 'no-store');
        await request(app).get('/uploads/space%20poster.webp?format=jpeg').expect(503).expect('Cache-Control', 'no-store');
        await request(app).get('/uploads/%E0%A4%A.webp?format=jpeg').expect(503).expect('Cache-Control', 'no-store');
        await request(app).get('/uploads/unsupported.svg?format=jpeg').expect(503).expect('Cache-Control', 'no-store');
        assert.deepEqual((await request(app).get('/uploads/space%20poster.webp').expect(200)).body, webp, 'ordinary legacy filenames still serve normally');

        let recoveries = 0;
        const recoveredApp = express();
        recoveredApp.use('/uploads', makeVariantMiddleware({ uploadsDir: root, legacyRead: async name => {
            recoveries++;
            assert.equal(name, 'legacy.webp');
            await new Promise(resolve => setTimeout(resolve, 25));
            return webp;
        } }), express.static(root));
        const recoveredImages = await Promise.all([320, 640].map(width => request(recoveredApp)
            .get(`/uploads/legacy.webp?w=${width}&format=jpeg`).expect(200).expect('Content-Type', /image\/jpeg/)));
        assert.equal(recoveries, 1, 'concurrent JPEG widths share one legacy recovery');
        for (const item of recoveredImages) assert.equal((await sharp(item.body).metadata()).format, 'jpeg');
        assert.deepEqual(await fs.readFile(path.join(root, 'legacy.webp')), webp, 'recovered original is cached for future variants');
        await request(recoveredApp).get('/uploads/legacy.webp?w=1600&format=jpeg').expect(200);
        assert.equal(recoveries, 1);
        await request(recoveredApp).get('/uploads/loop.webp?format=jpeg').set(legacyUploads.LOOP_HEADER, '1').expect(503);
        assert.equal(recoveries, 1, 'a legacy recovery request is never forwarded again');

        // The recovery helper contacts configured origins only, with an explicit
        // per-origin deadline, size ceiling and finite number of attempts.
        const axios = require('axios'), config = require('../src/config');
        const originalGet = axios.get, originalOrigins = config.objectStorage.legacyOrigins;
        const legacyCalls = [];
        config.objectStorage.legacyOrigins = ['https://old1.example', 'https://old2.example', 'https://old3.example'];
        try {
            axios.get = async (url, options) => { legacyCalls.push({ url, options }); return { status: 404, headers: {}, data: Buffer.alloc(0) }; };
            assert.equal(await legacyUploads.fetchLegacy('events/poster.webp', { timeoutMs: 5000, maxBytes: 25 * 1024 * 1024, maxOrigins: 2 }), null);
            assert.equal(legacyCalls.length, 2);
            assert.equal(legacyCalls[0].url, 'https://old1.example/uploads/events/poster.webp');
            assert.equal(legacyCalls[0].options.timeout, 5000);
            assert.equal(legacyCalls[0].options.maxContentLength, 25 * 1024 * 1024);
            assert.equal(legacyCalls[0].options.headers[legacyUploads.LOOP_HEADER], '1');
            axios.get = async () => ({ status: 200, headers: { 'content-type': 'image/webp' }, data: Buffer.alloc(65) });
            assert.equal(await legacyUploads.fetchLegacy('poster.webp', { maxBytes: 64, maxOrigins: 1 }), null, 'oversized legacy responses cannot be rendered');
            axios.get = async () => ({ status: 200, headers: { 'content-type': 'image/webp' }, data: webp });
            assert.deepEqual((await legacyUploads.fetchLegacy('poster.webp', { maxBytes: webp.length, maxOrigins: 1 })).buffer, webp);
        } finally { axios.get = originalGet; config.objectStorage.legacyOrigins = originalOrigins; }

        const calls = [];
        meta.isConfigured = () => true;
        meta.sendTemplateMessage = async (...args) => { calls.push(args); return { success: true, messageId: 'mock-provider-id' }; };
        const options = { headerImage: 'https://old.example/uploads/poster.webp', marker: 'preserved' };
        for (const eventTemplate of ['booking_confirmation', 'membership_notice', 'association_update']) {
            const result = await template.sendTemplateMessage('918888888888', eventTemplate, ['Member'], 'en', '', options);
            assert.equal(calls.at(-1)[5].headerImage, normalized, 'all template contexts use compatible image headers');
            assert.equal(calls.at(-1)[5].marker, 'preserved');
            assert.equal(result.headerImage, normalized, 'store the actual sent media URL in delivery logs');
        }
        assert.equal(options.headerImage, 'https://old.example/uploads/poster.webp', 'caller inputs preserved');
        const document = { headerDocument: { link: 'https://external.example/file.pdf', filename: 'agenda.pdf' } };
        await template.sendTemplateMessage('918888888888', 'document_notice', [], 'en', '', document);
        assert.deepEqual(calls.at(-1)[5], document, 'document headers are unchanged');
        await template.sendTemplateMessage('918888888888', 'plain_notice', [], 'en', '', {});
        assert.deepEqual(calls.at(-1)[5], {}, 'plain templates never acquire an image header');
        const logs = require('../src/modules/notifications/notificationLog.model');
        const eligibility = require('../src/modules/notifications/retryEligibility');
        const originalFind = logs.findById, originalSkip = eligibility.reasonToSkip;
        let saved = 0;
        const modified = [];
        const retryRow = { channel: 'whatsapp', event: 'CUSTOM', recipient: '918888888888', templateId: 'saved_header_notice',
            status: 'failed', data: { headerImage: options.headerImage, params: ['Member'], unrelated: 'preserved' },
            save: async () => { saved++; }, markModified: value => modified.push(value) };
        try {
            logs.findById = async () => retryRow;
            eligibility.reasonToSkip = async () => '';
            const retried = await require('../src/modules/notifications/notification.service')._retryLog('fixture');
            assert.equal(retried.outcome.headerImage, normalized);
            assert.equal(retryRow.data.headerImage, normalized, 'generic retries retain the actual normalized URL that was sent');
            assert.equal(retryRow.data.unrelated, 'preserved');
            assert.equal(saved, 1); assert(modified.includes('data'));
        } finally { logs.findById = originalFind; eligibility.reasonToSkip = originalSkip; }
        console.log('PASS: real WebP converts to JPEG despite WebP Accept; cached/HEAD variants; forced JPEG fails closed; bounded configured legacy recovery and loop protection; source/browser formats preserved; template and retry normalization plus saved URL; documents/plain headers preserved. No messages sent.');
    } finally {
        meta.isConfigured = originalConfigured; meta.sendTemplateMessage = originalSend;
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'activ-whatsapp-media-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
