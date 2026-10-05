const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const multer = require('multer');
const request = require('supertest');
const sharp = require('sharp');
const { readableFilename, mediaFilename } = require('../src/core/storage/mediaFilename');
const { makeVariantMiddleware } = require('../src/core/storage/imageVariants');

async function run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activ-media-test-'));
    try {
        const app = express();
        for (const category of ['media', 'business', 'products']) {
            const upload = multer({ storage: multer.diskStorage({ destination: root, filename: mediaFilename(root, category) }) });
            app.post(`/${category}`, upload.single('image'), (req, res) => res.json({ url: `/uploads/${req.file.filename}` }));
        }
        app.use('/uploads', makeVariantMiddleware({ uploadsDir: root }), express.static(root));
        const png = await sharp({ create: { width: 1600, height: 800, channels: 4, background: '#224488' } }).png().toBuffer();
        const urls = new Set();
        for (const category of ['media', 'business', 'products', 'media']) {
            const uploaded = await request(app).post(`/${category}`).attach('image', png, 'South Zone Banner.PNG').expect(200);
            const url = uploaded.body.url;
            assert.match(url, new RegExp(`^/uploads/${category}/[a-f0-9-]+/south-zone-banner.png$`));
            assert.ok(!urls.has(url), 'Uploading the same name never overwrites another file');
            urls.add(url);
            const original = await request(app).get(url).expect(200);
            assert.deepEqual(original.body, png);
            const thumbnail = await request(app).get(`${url}?w=320`).set('Accept', 'image/webp').expect(200);
            const dimensions = await sharp(thumbnail.body).metadata();
            assert.equal(dimensions.width, 320);
            assert.equal(dimensions.height, 160);
            assert.equal(dimensions.format, 'webp');
        }
        for (const originalname of ['../../hello.png', 'C:\\fakepath\\Hello.png', '<script>.png', 'தமிழ்.png']) {
            const name = readableFilename({ originalname, mimetype: 'image/png' });
            assert.match(name, /^[a-z0-9-]+\.png$/);
        }
        const photoStorage = require('../src/core/middleware/upload').memberPhoto.storage;
        const photoName = () => new Promise((resolve, reject) => photoStorage.getFilename(
            { memberPhotoDirectory: root }, { mimetype: 'image/png' }, (error, name) => error ? reject(error) : resolve(name)));
        const firstPhoto = await photoName();
        const secondPhoto = await photoName();
        assert.match(firstPhoto, /^[a-f0-9-]+\/profile\.png$/);
        assert.notEqual(firstPhoto, secondPhoto, 'Member photo replacements keep their own version');
        console.log('PASS: readable upload names, safe paths, same-name isolation, original delivery and sized thumbnails for all shared upload stores');
    } finally {
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'activ-media-test-'));
        await fs.rm(root, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
