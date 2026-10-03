const assert = require('node:assert/strict');
const config = require('../src/config');
const cms = require('../src/modules/cms/cms.service');
const { bannerName, nameEventBanner } = require('../src/modules/events/eventBanner');
const { mergePreview, websiteShell } = require('../src/modules/share/websitePage');
const store = require('../src/core/storage/uploadStore');
const variants = require('../src/core/storage/imageVariants');
const eventPreviewImage = require('../src/modules/share/eventPreviewImage');

async function main() {
    const share = require('../src/modules/share/eventShareContent').eventShareContent({
        title:'Event A',startAt:'2026-10-10T03:30:00Z',endAt:'2026-10-10T11:30:00Z',venue:'Hall A',venueAddress:'Address A',
        description:'Event A description',registrationFee:0,language:'Tamil',contactPhone:'12345',
        speakers:[{name:'Speaker A'}],agenda:[{startTime:'09:00',title:'Session A'}],
        onlineUrl:'PRIVATE_JOIN',whatsappChannelUrl:'PRIVATE_GROUP',attachments:[{url:'PRIVATE_FILE'}],
    },'https://activ.org.in/events/event-a');
    assert.equal(share.title,'Event A on 10 October 2026 at Hall A');
    for (const value of ['9:00 am','5:00 pm','IST','Address A','Free entry','Tamil','12345','Speaker A','Session A','https://activ.org.in/events/event-a']) {
        assert.ok(share.text.includes(value),value);
    }
    assert.ok(!/PRIVATE_JOIN|PRIVATE_GROUP|PRIVATE_FILE/.test(share.text));
    const event = {
        id: '0123456789abcdef01234567', slug: 'conference-2026-10-10',
        title: 'SCST Economic Liberty Conference', startAt: '2026-10-10T04:30:00Z',
        venue: 'DNC VIJAY MAHAL', description: 'Conference details & registration.',
        imageUrl: '/uploads/events/version/conference-2026-10-10.png',
    };
    const shell = '<html><head><title>Home</title><link rel="canonical" href="https://activ.org.in/">'
        + '<meta property="og:url" content="https://activ.org.in/"><meta property="og:image" content="logo.png">'
        + '<meta name="twitter:image" content="logo.png"><meta name="description" content="Home">'
        + '<script type="module" src="/assets/site.js"></script></head><body><div id="root"></div></body></html>';
    const realFetch = global.fetch;
    const previousOrigin = config.frontendUrl;
    const previousAppId = process.env.META_APP_ID;
    const originalList = cms.listEvent;
    const originalRead = variants.readOriginal;
    const originalPersist = store.persistBuffer;
    try {
        config.frontendUrl = 'https://activ.org.in';
        process.env.META_APP_ID = '123456789';
        let shellFetches = 0;
        global.fetch = async(url) => {
            if (String(url) === 'https://activ.org.in/?ref=share') {
                shellFetches++;
                return new Response(shell, { headers: { 'content-type': 'text/html' } });
            }
            return new Response('', { status: 404 });
        };
        cms.listEvent = async() => event;
        const router = require('../src/modules/share/share.routes');
        const handler = router.stack.find((layer) => Array.isArray(layer.route?.path) && layer.route.path.includes('/events/:slug')).route.stack[0].handle;
        for (const agent of ['Mozilla/5.0', 'facebookexternalhit/1.1', 'meta-externalfetcher/1.1', 'WhatsApp']) {
            const headers = {};
            let body = '';
            const res = {
                vary() {}, set(key, value) { headers[key] = value; return this; },
                removeHeader(key) { delete headers[key]; },
                type() { return this; }, send(value) { body = value; },
                redirect() { throw new Error('Public event must not redirect'); },
            };
            await handler({ params: { slug: event.id }, query: { view: 'page' }, headers: { 'user-agent': agent } }, res);
            assert.ok(body.includes('SCST Economic Liberty Conference on 10 October 2026 at DNC VIJAY MAHAL'));
            assert.ok(body.includes('Conference details &amp; registration.'));
            assert.ok(body.includes(eventPreviewImage.previewImageUrl(event,require('../src/core/storage/publicMedia').publicMediaOrigin())));
            assert.ok(body.includes('property="og:image:type" content="image/jpeg"'));
            assert.ok(body.includes('property="og:image:height" content="630"'));
            assert.ok(body.includes('property="fb:app_id" content="123456789"'));
            assert.ok(body.includes('id="root"') && body.includes('/assets/site.js'));
            assert.equal((body.match(/rel="canonical"/g) || []).length, 1);
            assert.equal((body.match(/property="og:url"/g) || []).length, 1);
            assert.ok(!body.includes('logo.png') && !body.includes('location.replace'));
            assert.equal(headers['Cache-Control'], 'no-cache');
        }
        assert.equal(shellFetches, 1, 'SPA shell is cached independently of event metadata');
        // A crawler gets a real JPEG derived from the same public event banner.
        const imageHandler = router.stack.find(layer => layer.route?.path === '/events/:slug/preview/:version.jpg').route.stack[0].handle;
        const fixture = await require('sharp')({create:{width:48,height:24,channels:3,background:'#114488'}}).png().toBuffer();
        variants.readOriginal = async() => fixture;
        let jpeg;
        let imageStatus=200;
        const imageHeaders={};
        const imageResponse = {status(code){imageStatus=code;return this;},end(){},set(key,value){imageHeaders[key]=value;},type(value){imageHeaders.type=value;return this;},send(bytes){jpeg=bytes;}};
        await imageHandler({params:{slug:event.id,version:eventPreviewImage.versionOf(event)}},imageResponse);
        assert.equal(imageStatus,200);
        assert.equal(imageHeaders.type,'image/jpeg');
        const imageMetadata = await require('sharp')(jpeg).metadata();
        assert.equal(imageMetadata.format,'jpeg');
        assert.equal(imageMetadata.width,1200);
        assert.equal(imageMetadata.height,630);
        const replacement={...event,imageUrl:'/uploads/new-banner.png'};
        assert.notEqual(eventPreviewImage.versionOf(event),eventPreviewImage.versionOf(replacement));
        await imageHandler({params:{slug:event.id,version:'old-version'}},imageResponse);
        assert.equal(imageStatus,404);
        cms.listEvent = async() => { throw new Error('Hidden event'); };
        await imageHandler({params:{slug:event.id,version:eventPreviewImage.versionOf(event)}},imageResponse);
        assert.equal(imageStatus,404);
        let hiddenRedirect = '';
        await handler({ params: { slug: event.id }, query: { view: 'page' }, headers: {} }, {
            redirect(status, url) { assert.equal(status, 302); hiddenRedirect = url; },
        });
        assert.ok(hiddenRedirect.endsWith('?ref=share'));
        assert.ok(!mergePreview(shell, router._test.page({ title: 'A < B', description: '', image: '', url: 'https://activ.org.in/events/a' })).includes('<title>A < B'));

        const bytes = Buffer.from('image fixture');
        const name = bannerName(event, 'cms-upload.png', bytes);
        assert.ok(name.endsWith('/conference-2026-10-10.png'));
        assert.notEqual(name, bannerName(event, 'cms-upload.png', Buffer.from('replacement')));
        assert.equal(bannerName({ slug: '../../outside' }, 'cms.png', bytes), '');
        variants.readOriginal = async() => bytes;
        const persisted = [];
        store.persistBuffer = async(buffer, destination) => { persisted.push(destination); return true; };
        assert.equal(await nameEventBanner({ ...event, bannerUrl: '/uploads/cms-upload.png' }), `/uploads/${name}`);
        assert.equal(persisted.length, 1);
        assert.equal(await nameEventBanner({ ...event, bannerUrl: 'https://cdn.example.com/banner.png' }), 'https://cdn.example.com/banner.png');
        store.persistBuffer = async() => false;
        assert.equal(await nameEventBanner({ ...event, bannerUrl: '/uploads/cms-upload.png' }), '/uploads/cms-upload.png');
        config.frontendUrl = 'invalid';
        assert.equal(await websiteShell(), null);
        console.log('PASS: initial event HTML for four user agents, canonical URL, title, description, image, hidden events, shell cache, and durable banner names');
    } finally {
        global.fetch = realFetch;
        config.frontendUrl = previousOrigin;
        cms.listEvent = originalList;
        variants.readOriginal = originalRead;
        store.persistBuffer = originalPersist;
        if (previousAppId === undefined) delete process.env.META_APP_ID;
        else process.env.META_APP_ID = previousAppId;
    }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
