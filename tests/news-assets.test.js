const assert = require('node:assert/strict');
const path = require('node:path');
const { MongoMemoryServer } = require('mongodb-memory-server-core');
const mongoose = require('mongoose');
process.env.NODE_ENV = 'test';
process.env.MONGOMS_RUNTIME_DOWNLOAD = 'false';
process.env.NOTIFICATION_WORKER_ENABLED = 'false';
const assets = require('../src/modules/cms/cms.news.assets');
let mongod, checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS ' + name); };
const rejects = (name, run) => check(name, () => assert.throws(run, error => error.statusCode === 400));
const photo = { url: '/uploads/media/probe/photo.jpg', type: 'image', alt: 'Opening ceremony', fit: 'contain', position: 'center' };
const document = { url: '/uploads/documents/probe/report.pdf', label: 'Read the report', filename: 'report.pdf', mimeType: 'application/pdf', size: 1234 };
const links = [{ url: 'https://chat.whatsapp.com/ExampleInvite', label: 'WhatsApp group' }, { url: 'https://www.youtube.com/watch?v=example&t=10', label: 'Watch the event' }];

async function main() {
    check('multiple photos, documents and WhatsApp/YouTube URLs retain order and metadata', () => {
        assert.equal(assets.cleanPhotos([photo, { ...photo, url: 'https://images.example/second.jpg' }]).length, 2);
        assert.deepEqual(assets.cleanAttachments([document]), [document]);
        assert.deepEqual(assets.cleanLinks(links), links);
    });
    check('uploaded absolute URLs normalize without render-only query data', () => {
        assert.equal(assets.cleanAttachments([{ ...document, url: 'https://api.example/uploads/documents/probe/report.pdf?download=1' }])[0].url, document.url);
        assert.deepEqual(assets.cleanLinks([{ url: 'https://wa.me/919999999999?text=Hello%20ACTIV', label: 'WhatsApp' }])[0].url, 'https://wa.me/919999999999?text=Hello%20ACTIV');
    });
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///report.pdf', '//evil.example/file.pdf', '/api/v1/messages/attachments/private', '/uploads/../private.pdf', '/uploads/%2e%2e/private.pdf', '/uploads/chat-files/id/report.pdf', 'https://user:password@example.test/report.pdf', 'http://example.test/report.pdf']) {
        rejects('reject unsafe/private document URL ' + url.split(':')[0], () => assets.cleanAttachments([{ ...document, url }]));
    }
    for (const url of ['whatsapp://send?text=test', 'javascript:alert(1)', '//example.test', 'https://user:secret@example.test/', 'https://example.test/\nunsafe']) {
        rejects('reject unsafe supporting link ' + url.split(':')[0], () => assets.cleanLinks([{ url }]));
    }
    for (const invalid of [{ filename: 'report.html', mimeType: 'text/html' }, { filename: 'report.svg', mimeType: 'image/svg+xml' }, { filename: 'report.exe', mimeType: 'application/pdf' }, { filename: 'report.pdf', mimeType: 'application/msword' }, { size: -1 }, { size: 1.5 }, { size: assets.DOCUMENT_LIMIT + 1 }]) {
        rejects('reject unsupported or inconsistent document metadata', () => assets.cleanAttachments([{ ...document, ...invalid }]));
    }
    for (const [clean, row, limit] of [[assets.cleanPhotos, photo, 20], [assets.cleanAttachments, document, 10], [assets.cleanLinks, links[0], 10]]) {
        check('exact count boundary accepted', () => assert.equal(clean(Array.from({ length: limit }, () => row)).length, limit));
        rejects('excess entries rejected without truncation', () => clean(Array.from({ length: limit + 1 }, () => row)));
        rejects('malformed list rejected', () => clean({}));
    }
    check('legacy null and malformed rows do not crash or reveal hidden media', () => {
        assert.deepEqual(assets.readPhotos(null), []);
        assert.deepEqual(assets.readPhotos([null, { ...photo, isHidden: true }, { url: 'javascript:bad' }, photo]), [photo]);
        assert.deepEqual(assets.readAttachments([null, { ...document, visible: false }, { ...document, mimeType: 'text/html' }, document]), [document]);
        assert.equal(assets.readPhotos([{ ...photo, url: '/images/news/legacy.jpg' }])[0].url, '/images/news/legacy.jpg');
        assert.equal(assets.cleanPhotos([{ ...photo, url: '/legacy.jpg' }])[0].url, '/legacy.jpg');
    });

    mongod = await MongoMemoryServer.create({ binary: { downloadDir: path.resolve(__dirname, '../node_modules/.cache/mongodb-memory-server') }, instance: { ip: '127.0.0.1' } });
    const uri = mongod.getUri();
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, 'writes require a disposable loopback database');
    process.env.MONGODB_URI = uri;
    await mongoose.connect(uri, { autoIndex: false });
    // Disable publication hooks before model compilation: this fixture must
    // never enqueue deliveries or call a real provider.
    const broadcast = require('../src/modules/notifications/contentBroadcast');
    broadcast.install = () => {};
    const { NewsArticle } = require('../src/modules/cms/cms.models');
    const news = require('../src/modules/cms/cms.news.service');
    const controller = require('../src/modules/cms/cms.controller');
    const payload = { title: 'News asset persistence probe', status: 'published', summary: 'Summary',
        body: '<p><strong>Full story</strong> <em>in detail</em> <span style="font-size: 24px">Highlights</span> <a href="https://example.test/story">Read more</a></p>', image: photo,
        photos: [photo, { ...photo, url: '/uploads/media/probe/second.jpg' }], attachments: [document], links, state: 'Tamil Nadu', district: 'Chennai',
        externalUrl: 'https://source.example/story', extraFields: [{ label: 'Publisher', value: 'ACTIV' }] };
    const saved = await news.saveArticle(null, payload, { email: 'fixture@example.test' });
    const stored = await NewsArticle.findById(saved.id).lean();
    check('real mapped Mongoose persistence retains all new schema paths', () => {
        assert.equal(stored.photos.length, 2); assert.equal(stored.attachments[0].filename, document.filename);
        assert.equal(stored.links[1].url, links[1].url); assert.equal(stored.attachments[0].storageName, undefined);
    });
    const read = await news.getArticle(saved.slug);
    check('rich text survives persistence while share previews and publication notices stay plain', () => {
        assert.equal(stored.body, payload.body); assert.equal(read.body, payload.body);
        const preview = require('../src/modules/share/pageShareContent').newsShareContent(read);
        assert(preview.text.includes('Full story')); assert(preview.text.includes('Highlights')); assert(preview.text.includes('Read more'));
        assert(!/<[^>]+>|font-size|href=/.test(preview.text + preview.description));
        const notice = broadcast.notice({ kind: 'news', _id: 'fixture', key: 'fixture' }, stored, { _id: 'fixture' });
        assert(!/<[^>]+>|font-size|href=/.test(notice.message));
    });
    const byId = await news.getArticle(saved.id);
    check('public article ID aliases resolve the same persisted record', () => assert.equal(byId.slug, saved.slug));
    const legacy = await NewsArticle.collection.insertOne({ title: 'Legacy article without slug', status: 'published', photos: null });
    const legacyRead = await news.getArticle(String(legacy.insertedId));
    check('a persisted legacy article without a slug opens by ID', () => {
        assert.equal(legacyRead.title, 'Legacy article without slug'); assert.deepEqual(legacyRead.photos, []);
    });
    await NewsArticle.deleteOne({ _id: legacy.insertedId });
    const regional = await news.listNews({ state: 'Tamil Nadu', district: 'Chennai' });
    const admin = await news.listForAdmin();
    check('detail, regional filter and admin reads retain metadata and legacy content', () => {
        for (const value of [read, regional[0], admin.news[0]]) {
            assert.deepEqual(value.attachments, [document]); assert.deepEqual(value.links, links);
            assert.equal(value.photos.length, 2); assert.equal(value.body, payload.body); assert.equal(value.externalUrl, payload.externalUrl);
            assert.equal(value.editedBy, undefined);
        }
    });
    await news.saveArticle(saved.id, { summary: 'Updated summary' });
    const partial = await news.getArticle(saved.slug);
    check('legacy partial edit preserves all omitted arrays and stable URL', () => {
        assert.deepEqual(partial.attachments, [document]); assert.deepEqual(partial.links, links); assert.equal(partial.photos.length, 2); assert.equal(partial.slug, saved.slug);
    });
    await assert.rejects(() => news.saveArticle(saved.id, { attachments: Array.from({ length: 11 }, () => document) }), error => error.statusCode === 400);
    const afterRejected = await news.getArticle(saved.slug);
    check('rejected oversize update leaves the database unchanged', () => assert.deepEqual(afterRejected.attachments, [document]));
    const invalid = new NewsArticle({ title: 'Invalid', links: [{ url: 'javascript:bad' }], attachments: [{ ...document, mimeType: 'text/html' }] });
    check('schema rejects unsafe links and unsupported attachment MIME independently', () => assert.ok(invalid.validateSync()));
    const draft = await news.saveArticle(null, { ...payload, title: 'Unpublished asset probe', status: 'draft' });
    const invoke = (handler, role, params = {}) => new Promise((resolve, reject) => handler({ query: {}, params, user: role ? { role } : undefined }, { json: result => resolve(result.data) }, reject));
    for (const role of [undefined, 'member', 'state_admin', 'attendance_admin']) {
        await assert.rejects(() => invoke(controller.getArticle, role, { slug: draft.slug }), error => error.statusCode === 404);
        await assert.rejects(() => invoke(controller.getArticle, role, { slug: draft.id }), error => error.statusCode === 404);
        const list = await invoke(controller.listNews, role);
        check('public/non-editor draft privacy ' + (role || 'guest'), () => assert.equal(list.some(row => row.id === draft.id), false));
    }
    for (const role of ['super_admin', 'cms_admin', 'events_admin']) {
        const value = await invoke(controller.getArticle, role, { slug: draft.slug });
        check('news editor retains draft preview ' + role, () => assert.deepEqual(value.attachments, [document]));
    }
    const cleared = await news.saveArticle(saved.id, { photos: [], attachments: [], links: [] });
    check('empty arrays explicitly clear all supporting content', () => {
        assert.deepEqual(cleared.photos, []); assert.deepEqual(cleared.attachments, []); assert.deepEqual(cleared.links, []);
        assert.equal(cleared.image.url, photo.url); assert.equal(cleared.body, payload.body);
    });
    check('supporting-link edits participate in the existing content revision', () => assert.notEqual(broadcast.sourceKey('news', payload), broadcast.sourceKey('news', { ...payload, links: [] })));
    console.log(`PASS: ${checks} news asset checks; disposable MongoDB only, no uploads or deliveries`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
});
