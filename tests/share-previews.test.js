// Persist and serve each CMS route independently, with model/HTTP fixtures.
// No real members, CMS content, live mail or external provider calls are used.
const assert = require('node:assert/strict');
Object.assign(process.env, { JWT_SECRET: 'isolated-cms-preview-test', FRONTEND_URL: 'https://activ.org.in' });
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const { SharePreview } = require('../src/modules/cms/cms.models');
const { STATIC_PAGES, EDITOR_PAGES, normalizePath, cleanPreview, defaultImage } = require('../src/modules/cms/sharePreviews');
const cms = require('../src/modules/cms/cms.service');
const news = require('../src/modules/cms/cms.news.service');
const schemes = require('../src/modules/cms/cms.schemes.service');
const regions = require('../src/modules/cms/cms.regionPages.service');

const copy = value => value ? JSON.parse(JSON.stringify(value)) : value;
const records = new Map([['/about', { path: '/about', title: 'Existing client title', description: '', image: { ...defaultImage('/about'), alt: 'Existing alt' } }]]);
let seedCount = 0;
SharePreview.bulkWrite = async operations => {
    seedCount++;
    for (const { updateOne: operation } of operations) if (!records.has(operation.filter.path)) records.set(operation.filter.path, copy(operation.update.$setOnInsert));
};
SharePreview.find = () => ({ lean: async() => Array.from(records.values()).map(copy) });
SharePreview.findOne = ({ path }) => ({ lean: async() => copy(records.get(path)) || null });
SharePreview.findOneAndUpdate = async({ path }, update, options) => {
    assert.equal(options.runValidators, true);
    const result = { ...(records.get(path) || update.$setOnInsert), ...copy(update.$set), updatedAt: new Date().toISOString() };
    records.set(path, result);
    return result;
};
SharePreview.deleteOne = async({ path }) => { records.delete(path); };

const event = { id: 'public-event', slug: 'public-event', title: 'ACTIV Conference', startAt: '2026-10-10T04:30:00Z', venue: 'Conference hall', description: 'Community event', imageUrl: '/uploads/event.png' };
require('../src/modules/events/eventSlug').resolveEventId = async slug => slug;
cms.listEvents = async() => [event];
cms.getAbout = async() => ({ heading: 'About ACTIV', body: 'Our community mission', media: { url: '/uploads/about.png' } });
cms.getEventsSettings = async() => ({ heading: 'ACTIV Events', lede: 'Our public programmes', heroMedia: { url: '/uploads/events-index.png' } });
cms.getGallerySettings = async() => ({ heading: 'ACTIV Gallery', description: 'Our community photographs' });
require('../src/modules/cms/cms.membership.service').get = async() => ({ title: 'ACTIV Membership', body: ['Membership benefits'] });
schemes.getSettings = async() => ({ heading: 'Government schemes', description: 'Enterprise opportunities', heroImage: { url: '/uploads/schemes-index.png' } });
cms.listEvent = async slug => { if (slug !== 'public-event') throw Object.assign(new Error('Not public'), { statusCode: 404 }); return event; };
const album = { id: 'album', slug: 'album', title: 'Community album', caption: 'Album description', media: { url: '/uploads/cover.png', type: 'image' }, photos: [{ url: '/uploads/photo.png', title: 'Community photo' }] };
cms.listGallery = async() => [album];
cms.getGalleryItem = async slug => slug === 'album' ? album : null;
cms.listLegalDocuments = async() => [{ slug: 'privacy-policy', title: 'Privacy Policy' }];
cms.getLegalDocument = async() => ({ slug: 'privacy-policy', title: 'Privacy Policy' });
const article = { slug: 'article', title: 'Community news', summary: 'Published summary', body: '<p>Complete article &amp; programme details</p>', publishedAt: '2026-10-03T10:00:00Z', state: 'Tamil Nadu', district: 'Chennai', category: 'Chapter news', sourceName: 'ACTIV newsroom', extraFields: [{ label: 'Organiser', value: 'ACTIV Council' }], image: { url: '/uploads/news.png' } };
news.listNews = async() => [article];
news.getArticle = async slug => slug === 'article' ? article : null;
news.getSettings = async() => ({ heading: 'ACTIV', headingHighlight: 'Newsroom', description: 'Published newsroom introduction', heroImage: { url: '/uploads/news-index.png' } });
schemes.listSchemes = async() => [{ slug: 'opportunity', title: 'Business opportunity' }];
schemes.getScheme = async() => ({ slug: 'opportunity', title: 'Business opportunity', summary: 'Published scheme' });
let northPublished = false;
regions.getMap = async() => ({ regions: [
    { slug: 'national', label: 'National', national: true, hasPage: true, states: [] },
    { slug: 'south', label: 'South', hasPage: true, states: [{ slug: 'tamil-nadu', name: 'Tamil Nadu', hasPage: true }] },
    { slug: 'north', label: 'North', hasPage: northPublished, states: [] },
    { slug: 'east', label: 'East', hasPage: false, states: [] },
] });
const chapter = { seo: {}, shortDescription: 'Published chapter introduction', fullDescription: 'Full chapter history', hero: { backgroundUrl: '/uploads/chapter-banner.png', tagline: 'Supporting entrepreneurs' }, leaders: [{ name: 'Chapter President', designation: 'President', bio: 'Leadership biography', photoUrl: '/uploads/leader.png' }, { name: 'Hidden leader', isHidden: true }], stateRegions: [{ name: 'Chennai', leaders: [{ name: 'District Secretary', designation: 'Secretary' }] }], events: [{ title: 'Chapter trade meet', summary: 'Open registration', date: '12 October 2026', location: 'Chennai' }], customSections: [{ key: 'business-support', title: 'Business Support', intro: 'Local advisory team', items: [{ title: 'Enterprise desk', summary: 'Help with applications' }] }] };
regions.getStatePage = async slug => slug === 'tamil-nadu' ? { ...chapter, slug, stateName: 'Tamil Nadu' } : null;
regions.getRegionPage = async slug => ['south', 'national', ...(northPublished ? ['north'] : [])].includes(slug) ? { ...chapter, slug, regionName: { south: 'South', national: 'National', north: 'North' }[slug] } : null;
regions.listAllStates = () => [{ slug: 'tamil-nadu', name: 'Tamil Nadu' }];
const service = require('../src/modules/cms/cms.sharePreviews.service');

const run = async() => {
    for (const path of ['/', '/about/', '/membership?ref=social', '/gallery/album/photo/1', '/events/public-event/book', '/states/tamil-nadu/newsUpdates', '/states/tamil-nadu/leaders', '/regions/south/about', '/states/tamil-nadu/keyAchievements', '/regions/south/section-business-support']) assert.ok(normalizePath(path));
    for (const path of ['https://elsewhere/about', '//elsewhere/about', '/admin/login', '/cms', '/payment/member-dashboard', '/reset-password?token=x', '/donate/receipt/token', '/events/../login', '/events/%2e%2e/login', '/events/__proto__', '/events/a%2f..', '/events/a\\b']) assert.equal(normalizePath(path), null, path);
    assert.throws(() => cleanPreview({ path: '/about', image: { url: 'javascript:alert(1)' } }));
    assert.throws(() => cleanPreview({ path: '/about', image: { url: 'data:image/png;base64,x' } }));
    assert.throws(() => cleanPreview({ path: '/about', image: { url: '/uploads/clip.mp4', type: 'video' } }));
    assert.equal(cleanPreview({ path: '/about/', title: '<b>About</b>', description: 'One\nline' }).title, 'About');
    for (const key of ['path', 'title', 'description', 'image.url', 'image.alt', 'updatedBy.email']) assert.ok(SharePreview.schema.path(key), key);

    const editor = await service.editorData();
    assert.deepEqual(editor.routes.filter(row => row.group === 'Main pages').map(row => row.path), ['/', '/about', '/membership', '/events', '/gallery', '/news', '/schemes', '/schemes/central', '/schemes/state']);
    assert.deepEqual(editor.routes.map(row => row.path), [...EDITOR_PAGES.map(row => row.path), '/regions/national', '/regions/south', '/states/tamil-nadu']);
    assert.deepEqual(editor.routes.filter(row => row.group === 'Zones').map(row => row.label), ['National', 'South']);
    assert.ok(!editor.routes.some(row => ['/login', '/events/public-event', '/regions/north', '/regions/east', '/states/hidden'].includes(row.path)), 'The selector adds only published zone and state pages');
    assert.equal(records.size, STATIC_PAGES.length);
    assert.equal(records.get('/about').title, 'Existing client title', 'Seeding preserves existing CMS values');
    assert.ok((await service.resolve('/')).image.url.includes('activ-conference'));
    assert.ok((await service.resolve('/membership')).image.url.includes('activ-conference'));
    for (const [main, aliases] of [['/', ['/onboarding']]]) {
        await service.save({ path: main, title: 'Shared main page title', image: { url: '/uploads/shared-main.png', type: 'image' } });
        for (const alias of aliases) {
            const card = await service.resolve(alias);
            assert.equal(card.path, main);
            assert.equal(card.canonicalPath, main);
            assert.equal(card.title, 'Shared main page title');
            assert.equal(card.imageSource.url, '/uploads/shared-main.png', 'Old links use the image saved for the general page');
        }
        await service.reset(main);
    }
    for (const path of ['/schemes/central', '/schemes/state', '/states/tamil-nadu']) {
        const saved = await service.save({ path, title: `Unique ${path}`, image: { url: '/uploads/separate-preview.png', type: 'image' } });
        assert.equal(saved.path, path);
        assert.equal(saved.canonicalPath, path);
        assert.equal((await service.resolve(path)).title, `Unique ${path}`);
        assert.notEqual((await service.resolve('/schemes')).title, saved.title);
        assert.notEqual((await service.resolve('/regions/south')).imageSource.url, saved.imageSource.url);
        await service.reset(path);
    }
    northPublished = true;
    assert.ok((await service.editorData()).routes.some(row => row.path === '/regions/north'), 'Newly published zones appear without a code change');
    northPublished = false;
    assert.ok(!(await service.editorData()).routes.some(row => row.path === '/regions/north'), 'Unpublished zones leave the selector');
    const south = await service.resolve('/regions/south');
    assert.equal(south.group, 'Zones', 'Selecting or saving a zone keeps it in its original group');
    assert.equal(south.label, 'South');
    assert.equal(south.imageSource.url, '/uploads/chapter-banner.png');
    const customZone = await service.save({ path: '/regions/south', title: 'South zone community', description: 'Meet the South zone council', image: { url: '/uploads/zone-custom.png', type: 'image' } });
    assert.equal(customZone.imageSource.url, '/uploads/zone-custom.png');
    assert.equal(customZone.title, 'South zone community');
    assert.equal((await service.resolve('/regions/national')).imageSource.url, '/uploads/chapter-banner.png', 'A zone image does not replace another zone or the national preview');
    assert.equal((await service.resolve('/regions/south/leaders')).imageSource.url, '/uploads/chapter-banner.png', 'Zone section cards keep their own automatic previews');
    const newZoneImage = await service.save({ path: '/regions/south', image: { url: '/uploads/zone-replaced.png', type: 'image' } });
    assert.notEqual(newZoneImage.image.url, customZone.image.url, 'Replacing a zone image produces a new crawler image URL');
    assert.equal(newZoneImage.title, customZone.title, 'Image-only changes preserve the zone text');
    assert.equal((await service.resolve('/about')).imageSource.url, '/uploads/about.png');
    assert.equal((await service.resolve('/events')).imageSource.url, '/uploads/events-index.png');
    assert.equal((await service.resolve('/gallery')).imageSource.url, '/uploads/cover.png');
    assert.equal((await service.resolve('/schemes/state')).imageSource.url, '/uploads/schemes-index.png');
    const newsroom = await service.resolve('/news');
    assert.equal(newsroom.title, 'ACTIV Newsroom');
    assert.equal(newsroom.imageSource.url, '/uploads/news-index.png', 'Seeded placeholder does not hide a published newsroom banner');
    const newsCard = await service.resolve('/news/article');
    assert.ok(newsCard.description.includes('3 October 2026') && newsCard.description.includes('Chennai, Tamil Nadu'));
    for (const value of ['Complete article & programme details', 'ACTIV newsroom', 'Chapter news', 'Organiser · ACTIV Council']) assert.ok(newsCard.shareText.includes(value), value);
    assert.match(newsCard.image.url, /\/page-image\/[a-f0-9]{20}\.jpg\?path=/);
    assert.equal(newsCard.imageSource.url, '/uploads/news.png');
    assert.deepEqual(newsCard.imageMeta, { type: 'image/jpeg', width: 1200, height: 630 });
    const chapterCard = await service.resolve('/states/tamil-nadu');
    assert.equal(chapterCard.imageSource.url, '/uploads/chapter-banner.png', 'Use the banner the published chapter actually renders');
    const leadership = await service.resolve('/regions/south/leaders');
    assert.equal(leadership.canonicalPath, '/regions/south/leaders');
    assert.equal(leadership.title, 'Leadership | ACTIV South');
    assert.ok(leadership.description.includes('Chapter President') && leadership.shareText.includes('Leadership biography') && leadership.shareText.includes('District Secretary'));
    assert.ok(!leadership.shareText.includes('Hidden leader'));
    assert.ok((await service.resolve('/states/tamil-nadu/about')).description.includes('Full chapter history'));
    assert.ok((await service.resolve('/states/tamil-nadu/events')).description.includes('Chapter trade meet'));
    assert.ok((await service.resolve('/regions/south/section-business-support')).description.includes('Enterprise desk'));
    await assert.rejects(service.resolve('/regions/south/section-missing'), error => error.statusCode === 404);
    await assert.rejects(service.resolve('/states/hidden/leaders'), error => error.statusCode === 404);
    await assert.rejects(service.resolve('/news/draft'), error => error.statusCode === 404);
    await service.save({ path: '/news/article', title: 'CMS news headline' });
    assert.equal((await service.resolve('/news/article')).image.url, newsCard.image.url, 'Saving text alone does not pin the page banner');
    article.image.url = '/uploads/news-replaced.png';
    const replaced = await service.resolve('/news/article');
    assert.notEqual(replaced.image.url, newsCard.image.url, 'A banner replacement produces a fresh preview URL');
    assert.ok(replaced.shareText.startsWith('CMS news headline'));
    await service.save({ path: '/news/article', image: { url: '/uploads/custom-news.png', type: 'image' } });
    assert.equal((await service.resolve('/news/article')).imageSource.url, '/uploads/custom-news.png', 'Explicit CMS social images take priority');
    await service.reset('/news/article');
    const title = 'New & updated About <b>page</b>';
    const result = await service.save({ path: '/about', title, description: 'About our community', image: { url: '/uploads/new-about.jpg', type: 'image', alt: 'About photograph', fit: 'contain' }, unrelated: 'discard' }, { email: 'cms@example.test' });
    assert.equal(result.title, 'New & updated About page');
    assert.equal(result.imageSource.url, '/uploads/new-about.jpg');
    assert.equal(records.get('/about').unrelated, undefined);
    assert.equal(records.get('/about').updatedBy.email, 'cms@example.test');
    assert.ok((await service.resolve('/membership')).image.url.includes('activ-conference'), 'Saving About must not modify Membership');
    await service.save({ path: '/about', description: 'Partial text save' });
    assert.equal((await service.resolve('/about')).imageSource.url, '/uploads/new-about.jpg', 'Partial save preserves uploaded image');
    assert.equal((await service.resolve('/about')).title, 'New & updated About page');
    await service.ensureDefaults();
    assert.equal(seedCount, 1);
    assert.equal((await service.resolve('/gallery/album/photo/1')).imageSource.url, '/uploads/photo.png');
    const booking = await service.resolve('/events/public-event/book');
    assert.equal(booking.canonicalPath, '/events/public-event');
    assert.ok(booking.title.includes('10 October 2026'));
    assert.match(booking.image.url, /\/preview\/[a-f0-9]{20}\.jpg$/);
    assert.ok(booking.image.url.startsWith('/api/v1/'), 'Generated image records must not pin previews to a local API host');
    const customBooking = await service.save({ path: '/events/public-event/book', title: 'Book this conference', image: { url: '/uploads/booking-card.jpg', type: 'image' } });
    assert.equal(customBooking.canonicalPath, '/events/public-event/book', 'A separate booking preview retains its own URL');
    assert.equal((await service.resolve('/events/public-event')).image.url, booking.image.url);
    records.set('/events/hidden', { path: '/events/hidden', title: 'Must remain hidden', image: defaultImage('/') });
    await assert.rejects(service.resolve('/events/hidden'), error => error.statusCode === 404);
    await assert.rejects(service.save({ path: '/events/hidden', title: 'Cannot publish via share card' }), error => error.statusCode === 404);
    await service.reset('/about');
    assert.equal((await service.resolve('/about')).imageSource.url, '/uploads/about.png');

    const app = express();
    app.use(express.json());
    app.use('/api/v1/cms', require('../src/modules/cms/cms.routes'));
    app.use('/api/v1/share', require('../src/modules/share/share.routes'));
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
    const token = role => jwt.sign({ email: 'cms@example.test', role }, config.jwt.secret);
    await request(app).get('/api/v1/cms/share-previews').expect(401);
    const menu = await request(app).get('/api/v1/cms/share-previews').set('Authorization', `Bearer ${token('cms_admin')}`).expect(200);
    assert.ok(menu.body.data.routes.some(row => row.path === '/regions/south' && row.group === 'Zones'));
    await request(app).put('/api/v1/cms/share-previews').set('Authorization', `Bearer ${token('member')}`).send({ path: '/about', title: 'No' }).expect(403);
    await request(app).put('/api/v1/cms/share-previews').set('Authorization', `Bearer ${token('cms_admin')}`).send({ path: '/about', title: 'CMS saved title' }).expect(200);
    const publicCard = await request(app).get('/api/v1/cms/share-previews/resolve').query({ path: '/about' }).expect(200);
    assert.equal(publicCard.body.data.title, 'CMS saved title');
    assert.equal(publicCard.headers['cache-control'], 'no-store');
    await request(app).get('/api/v1/cms/share-previews/resolve').query({ path: '/payment/member-dashboard' }).expect(404);

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    process.env.PUBLIC_MEDIA_URL = `http://127.0.0.1:${server.address().port}`;
    const variants = require('../src/core/storage/imageVariants');
    const originalRead = variants.readOriginal;
    const sharp = require('sharp');
    const sourceImage = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#224480' } }).png().toBuffer();
    variants.readOriginal = async(dir, name) => {
        assert.match(name, /^(?:news(?:-index|-replaced)?|chapter-banner|zone-replaced|about|events-index|schemes-index|cover)\.png$/);
        return sourceImage;
    };
    try {
        for (const path of ['/about', '/events', '/gallery', '/schemes', '/news', '/news/article', '/states/tamil-nadu', '/states/tamil-nadu/leaders', '/regions/national', '/regions/south', '/regions/south/leaders', '/regions/south/events']) {
            const response = await fetch(`${process.env.PUBLIC_MEDIA_URL}/api/v1/share/page?path=${encodeURIComponent(path)}`);
            const html = await response.text();
            assert.equal(response.status, 200, path);
            assert.ok(html.includes('property="og:image:width" content="1200"'));
            assert.ok(html.includes('property="og:image:height" content="630"'));
            assert.ok(html.includes(`content="https://activ.org.in${path}"`));
            if (path === '/regions/south') {
                assert.ok(html.includes('content="South zone community"'));
                assert.ok(html.includes('content="Meet the South zone council"'));
            }
            const imageUrl = html.match(/property="og:image" content="([^"]+)"/)[1].replace(/&amp;/g, '&');
            const imageResponse = await fetch(imageUrl);
            assert.equal(imageResponse.status, 200, path);
            assert.equal(imageResponse.headers.get('content-type'), 'image/jpeg');
            const bytes = Buffer.from(await imageResponse.arrayBuffer());
            assert.ok(bytes.length < 300000);
            const metadata = await sharp(bytes).metadata();
            assert.equal(metadata.width, 1200);
            assert.equal(metadata.height, 630);
            // A portrait source retains its whole picture with white side padding.
            const pixel = await sharp(bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
            assert.ok(pixel.every(channel => channel >= 250), 'Fit banners without cropping');
        }
        await request(app).get(newsCard.image.url).expect(404);
        await request(app).get('/api/v1/share/page-image/wrong.jpg').query({ path: '/news/article' }).expect(404);
        await request(app).get('/api/v1/share/page-image/wrong.jpg').query({ path: '/news/draft' }).expect(404);
        await request(app).get('/api/v1/share/page-image/wrong.jpg').query({ path: '/payment/member-dashboard' }).expect(404);
        for (const path of ['/news/article', '/states/tamil-nadu/leaders', '/regions/south/events']) {
            const legacy = await request(app).get(`/api/v1/share${path}`).expect(200);
            const resolved = await service.resolve(path);
            assert.ok(legacy.text.includes(`content="${resolved.title}"`), 'Legacy share links use the same card');
            assert.ok(legacy.text.includes('/page-image/'));
            assert.ok(legacy.text.includes(`content="https://activ.org.in${path}"`));
        }
        const response = await fetch(`${process.env.PUBLIC_MEDIA_URL}/api/v1/share/page?path=%2Fabout`);
        const html = await response.text();
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(html.includes('property="og:title" content="CMS saved title"'));
        assert.ok(html.includes('content="https://activ.org.in/about"'));
        assert.ok(html.includes('property="og:image:type" content="image/jpeg"'));
        assert.ok(html.includes('property="og:image:width" content="1200"'));
        const imageUrl = html.match(/property="og:image" content="([^"]+)"/)[1];
        const imageResponse = await fetch(imageUrl);
        assert.equal(imageResponse.headers.get('content-type'), 'image/jpeg');
        assert.ok((await imageResponse.arrayBuffer()).byteLength < 300000);
        await request(app).get('/api/v1/share/site-images/preview-placeholder/wrong.jpg').expect(404);
    } finally { variants.readOriginal = originalRead; await new Promise(resolve => server.close(resolve)); }
    await service.reset('/regions/south');
    assert.equal((await service.resolve('/regions/south')).imageSource.url, '/uploads/chapter-banner.png', 'Reset restores the published zone banner');
    console.log('PASS: main-page and published-zone selectors, isolated saves, upload persistence, reset, public visibility, editor permissions, crawler tags and JPEG delivery');
};
run().catch(error => { console.error(error); process.exitCode = 1; });
