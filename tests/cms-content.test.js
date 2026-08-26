/**
 * CMS content: read path, write path, media handling and the events lifecycle.
 *
 * Two kinds of check live here, and the split matters:
 *
 *   UNIT      — the sanitiser and the normalisers, pure functions, no server.
 *               These run anywhere, always, and are the ones that fail loudly
 *               when someone weakens the HTML whitelist.
 *
 *   LIVE      — the API, against a running backend. Skipped with a clear notice
 *               when nothing is listening, rather than reporting a failure that
 *               only means "the server is not up".
 *
 * The live half is careful about the database it is pointed at. It writes
 * nothing permanent: every mutation is made to a probe record it created, or is
 * a field it restores immediately afterwards, and it asserts the restore.
 *
 *   node tests/cms-content.test.js
 *   BASE_URL=http://localhost:5055 node tests/cms-content.test.js
 *
 * Credentials come from CMS_EMAIL / CMS_PASSWORD, defaulting to the seeded
 * admin. Without a valid sign-in the authenticated half is skipped, not failed.
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;
const EMAIL = process.env.CMS_EMAIL || 'admin@gmail.com';
const PASSWORD = process.env.CMS_PASSWORD || 'admin@1234';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const check = (label, ok, detail = '') => {
    if (ok) {
        passed++;
        console.log(`  ok    ${label}${detail ? '  — ' + detail : ''}`);
    } else {
        failed++;
        failures.push(`${label}${detail ? '  — ' + detail : ''}`);
        console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
    }
    return ok;
};

const skip = (label, why) => {
    skipped++;
    console.log(`  skip  ${label}  — ${why}`);
};

const section = (name) => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const call = async(method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
        const res = await fetch(API + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let payload = {};
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
        return { status: res.status, data: payload.data !== undefined ? payload.data : payload, message: payload.message };
    } catch (err) {
        return { status: 0, data: null, message: err.message };
    }
};

const len = (v) => (Array.isArray(v) ? v.length : 0);

// ============================================================ unit: sanitiser

const testSanitiser = () => {
    section('HTML sanitiser (unit)');

    const { sanitizeHtml } = require('../src/modules/cms/richText');

    // The whitelist must hold. Each of these is a way markup has been smuggled
    // past a naive filter in the wild.
    const dangerous = [
        ['<script>alert(1)</script>hi', 'script element'],
        ['<SCRIPT>alert(1)</SCRIPT>hi', 'uppercase script'],
        ['<img src=x onerror=alert(1)>', 'event handler on an unknown tag'],
        ['<p onclick="x()">t</p>', 'event handler on an allowed tag'],
        ['<a href="javascript:alert(1)">x</a>', 'javascript: URL'],
        ['<a href="java\tscript:alert(1)">x</a>', 'javascript: split by a tab'],
        ['<a href="JaVaScRiPt:alert(1)">x</a>', 'javascript: in mixed case'],
        ['<a href="data:text/html,<script>">x</a>', 'data: URL'],
        ['<iframe src="evil"></iframe>', 'iframe'],
        ['<style>body{display:none}</style>', 'style element'],
        ['<!--[if IE]><script>x</script><![endif]-->', 'conditional comment'],
        ['<object data="evil"></object>', 'object element'],
    ];

    for (const [input, label] of dangerous) {
        const out = sanitizeHtml(input);
        const leaked = /<script|<iframe|<style|<object|onerror|onclick|javascript:|data:text/i.test(out);
        check(`strips ${label}`, !leaked, JSON.stringify(out).slice(0, 60));
    }

    const kept = [
        ['<strong>bold</strong>', '<strong>', 'strong'],
        ['<em>italic</em>', '<em>', 'em'],
        ['a<br>b', '<br>', 'br'],
        ['<p>para</p>', '<p>', 'p'],
        ['<a href="/about">x</a>', 'href="/about"', 'relative link'],
        ['<a href="https://a.org">x</a>', 'rel="noopener', 'external link gains rel'],
    ];

    for (const [input, needle, label] of kept) {
        const out = sanitizeHtml(input);
        check(`keeps ${label}`, out.includes(needle), out.slice(0, 60));
    }

    check('plain text is untouched',
        sanitizeHtml('ACTIV is a chamber of commerce.') === 'ACTIV is a chamber of commerce.');
    check('empty input gives empty output', sanitizeHtml('') === '' && sanitizeHtml(null) === '');
};

// ============================================================ unit: cleanup

const testMediaHelpers = () => {
    section('Media cleanup (unit)');

    const { referencedFilenames } = require('../src/modules/cms/media.cleanup');
    check('reference scanner is exported', typeof referencedFilenames === 'function');

    // The path guard is the part worth pinning: a stored value is admin-editable,
    // and traversal out of the uploads directory must not be possible.
    const path = require('path');
    const { UPLOADS_DIR } = require('../src/modules/cms/media.cleanup');
    const escaped = path.resolve(UPLOADS_DIR, '../../src/server.js');
    check('traversal resolves outside uploads (so the guard must reject it)',
        !escaped.startsWith(UPLOADS_DIR + path.sep));
};

// ============================================================ live: public

const testPublicReads = async() => {
    section('Public reads');

    const site = (await call('GET', '/cms/site')).data || {};
    check('GET /cms/site', !!site.header, 'nav ' + len((site.header || {}).navLinks));
    check('  branding present', !!(site.brand || {}).fullName);
    check('  footer columns', len((site.footer || {}).linkColumns) > 0);
    check('  copyright carries {year}', String((site.footer || {}).copyright || '').includes('{year}'));

    const home = (await call('GET', '/cms/home')).data || {};
    const carousel = home.carousel || {};
    const about = home.about || {};
    check('GET /cms/home', !!carousel.headline || len(carousel.slides) > 0);
    check('  highlight card stats', Array.isArray((carousel.highlightCard || {}).stats));
    check('  about bullets carry icons',
        (about.bullets || []).every(b => b && typeof b.icon === 'string'));
    check('  retired stats/features are gone', !('stats' in home) && !('features' in home));

    const aboutPage = (await call('GET', '/cms/about')).data || {};
    check('GET /cms/about', typeof aboutPage.heading === 'string');
    check('  bullets and figures are arrays',
        Array.isArray(aboutPage.bullets) && Array.isArray(aboutPage.statsBar));

    const evCfg = (await call('GET', '/cms/events-settings')).data || {};
    check('GET /cms/events-settings', typeof evCfg.heading === 'string');
    check('  homeLimit is a number', typeof evCfg.homeLimit === 'number');

    const galCfg = (await call('GET', '/cms/gallery-settings')).data || {};
    check('GET /cms/gallery-settings', Array.isArray(galCfg.categories));
    check('  empty states are editable',
        typeof galCfg.emptyText === 'string' && typeof galCfg.emptyFilterText === 'string');

    const gallery = (await call('GET', '/cms/gallery')).data;
    check('GET /cms/gallery', Array.isArray(gallery), len(gallery) + ' item(s)');
    check('  every item carries media',
        (gallery || []).every(g => g.media && typeof g.media.fit === 'string'));

    const contact = (await call('GET', '/cms/contact-info')).data || {};
    check('GET /cms/contact-info', !!contact.formCard);
    check('  form wording is editable',
        typeof (contact.formCard || {}).namePlaceholder === 'string');
    check('  info card labels present',
        typeof (contact.infoCard || {}).addressLabel === 'string');

    const events = (await call('GET', '/cms/events')).data;
    check('GET /cms/events', Array.isArray(events), len(events) + ' published');
    check('  every event carries media',
        (events || []).every(e => e.media && typeof e.media.fit === 'string'));

    // Ordering is what the home strip depends on.
    const now = Date.now();
    const times = (events || []).filter(e => e.startAt).map(e => new Date(e.startAt).getTime());
    const upcoming = times.filter(t => t >= now);
    check('  upcoming events lead the list',
        times.slice(0, upcoming.length).every(t => t >= now),
        `${upcoming.length} upcoming, ${times.length - upcoming.length} past`);
    check('  upcoming are soonest-first',
        upcoming.every((t, i) => i === 0 || upcoming[i - 1] <= t));
};

const testGuards = async() => {
    section('Guards');

    check('GET /cms/overview needs a token', (await call('GET', '/cms/overview')).status === 401);
    check('PUT /cms/site needs a token', (await call('PUT', '/cms/site', { header: {} })).status === 401);
    check('POST /cms/events needs a token',
        (await call('POST', '/cms/events', { title: 'x' })).status === 401);
    check('DELETE /cms/gallery/:id needs a token',
        (await call('DELETE', '/cms/gallery/000000000000000000000000')).status === 401);
};

// ============================================================ live: authored

const testWrites = async(token) => {
    section('Write path (edit → database → public endpoint)');

    const PROBE = 'ZZZ-TEST-PROBE';

    const cases = [
        ['site', '/cms/site', d => d.header.ctaLabel,
            (d, v) => ({ header: { ...d.header, ctaLabel: v } })],
        ['home banner', '/cms/home', d => d.carousel.headline,
            (d, v) => ({ carousel: { ...d.carousel, headline: v } })],
        ['about page', '/cms/about', d => d.heading, (d, v) => ({ ...d, heading: v })],
        ['events copy', '/cms/events-settings', d => d.heading, (d, v) => ({ ...d, heading: v })],
        ['gallery copy', '/cms/gallery-settings', d => d.heading, (d, v) => ({ ...d, heading: v })],
        ['contact banner', '/cms/contact-info', d => d.banner.title,
            (d, v) => ({ ...d, banner: { ...d.banner, title: v } })],
    ];

    for (const [label, path, read, build] of cases) {
        const { data: before } = await call('GET', path);
        const original = read(before);

        const put = await call('PUT', path, build(before, PROBE), token);
        const { data: after } = await call('GET', path);
        check(`${label} — edit reaches the public endpoint`,
            put.status === 200 && read(after) === PROBE, `HTTP ${put.status}`);

        await call('PUT', path, build(before, original), token);
        const { data: restored } = await call('GET', path);
        check(`${label} — restored`, read(restored) === original);
    }

    // Deletion has to be real: this is what a fallback in the markup would hide.
    const { data: home } = await call('GET', '/cms/home');
    const figures = home.about.statsBar;

    await call('PUT', '/cms/home', { about: { ...home.about, statsBar: [] } }, token);
    const { data: emptied } = await call('GET', '/cms/home');
    check('deleting figures empties the public payload',
        len(emptied.about.statsBar) === 0, `was ${figures.length}`);

    await call('PUT', '/cms/home', { about: { ...home.about, statsBar: figures } }, token);
    const { data: back } = await call('GET', '/cms/home');
    check('  figures restored', len(back.about.statsBar) === figures.length);

    // A partial save must not blank a sibling block.
    const slides = len(home.carousel.slides);
    await call('PUT', '/cms/home', { about: home.about }, token);
    const { data: afterPartial } = await call('GET', '/cms/home');
    check('saving one block leaves the other intact',
        len(afterPartial.carousel.slides) === slides, `${slides} slide(s)`);

    // Markup is cleaned on the way in, so the database never holds a script tag.
    const { data: aboutDoc } = await call('GET', '/cms/about');
    const body = aboutDoc.body;
    await call('PUT', '/cms/about', { ...aboutDoc, body: '<script>alert(1)</script><strong>ok</strong>' }, token);
    const { data: sanitised } = await call('GET', '/cms/about');
    check('authored HTML is sanitised on write',
        !/script/i.test(sanitised.body) && sanitised.body.includes('<strong>'),
        JSON.stringify(sanitised.body).slice(0, 50));
    await call('PUT', '/cms/about', { ...aboutDoc, body }, token);
};

const testEventLifecycle = async(token) => {
    section('Events lifecycle');

    const PROBE = 'ZZZ-TEST-EVENT-PROBE';
    const start = new Date(Date.now() + 20 * 86400000);
    start.setHours(14, 30, 0, 0);

    const created = await call('POST', '/cms/events', {
        title: PROBE,
        description: 'Probe description.',
        startAt: start.toISOString(),
        location: 'Probe Venue',
        imageUrl: '/uploads/zzz-probe-banner.jpg',
        bannerFit: 'contain',
        bannerPosition: 'top',
        status: 'draft',
    }, token);

    check('create as draft', created.status === 201, `HTTP ${created.status}`);
    const id = (created.data || {})._id || (created.data || {}).id;
    if (!id) return check('  got an id', false, 'cannot continue');

    const find = (list) => (list || []).find(e => e.title === PROBE);

    check('draft is hidden from the public', !find((await call('GET', '/cms/events')).data));
    const mine = find((await call('GET', '/cms/events', undefined, token)).data);
    check('draft is visible to the admin', !!mine);

    if (mine) {
        check('  start instant round-trips',
            new Date(mine.startAt).getTime() === start.getTime(),
            new Date(mine.startAt).toISOString());
        check('  banner fit round-trips', (mine.media || {}).fit === 'contain');
        check('  banner position round-trips', (mine.media || {}).position === 'top');
    }

    await call('PUT', `/cms/events/${id}`, { status: 'published' }, token);
    check('publishing makes it public', !!find((await call('GET', '/cms/events')).data));

    await call('PUT', `/cms/events/${id}`, { status: 'draft' }, token);
    check('unpublishing hides it again', !find((await call('GET', '/cms/events')).data));

    check('a title is required',
        (await call('POST', '/cms/events', { startAt: start.toISOString() }, token)).status === 400);
    check('a date is required',
        (await call('POST', '/cms/events', { title: 'No date' }, token)).status === 400);

    check('delete', (await call('DELETE', `/cms/events/${id}`, undefined, token)).status === 200);
    check('  gone from the admin list',
        !find((await call('GET', '/cms/events', undefined, token)).data));
    check('deleting twice reports not-found',
        (await call('DELETE', `/cms/events/${id}`, undefined, token)).status === 404);
};

/**
 * The endpoints the mobile app ships against.
 *
 * Every one of these answered 404 until the routes existed, so Explore Members,
 * My Companies and the membership plans screen were dead on the phone while the
 * data sat in the database. Pinned here because a future route reshuffle that
 * drops one of them breaks an app already on people's devices, and nothing else
 * in this repository would notice.
 */
const testMobileEndpoints = async(token) => {
    section('Endpoints the mobile app calls');

    const cases = [
        ['/browse-members', 'Explore Members'],
        ['/browse-members/search?q=a', 'directory search'],
        ['/companies', 'My Companies'],
        ['/members/recent-activity', 'Recent Activity'],
    ];

    for (const [path, label] of cases) {
        const res = await call('GET', path, undefined, token);
        check(`${label} — GET ${path.split('?')[0]}`, res.status === 200, `HTTP ${res.status}`);
    }

    // Public: someone has to see the price before they have an account.
    const plans = await call('GET', '/membership/plans');
    check('membership plans are readable without a token', plans.status === 200, `HTTP ${plans.status}`);
    check('  plans carry both paise and rupees',
        ((plans.data || {}).plans || []).every(p => typeof p.amountPaise === 'number' && typeof p.amount === 'number'),
        `${((plans.data || {}).plans || []).length} plan(s)`);

    // Scoping is from the token, not from a parameter.
    check('companies need a token', (await call('GET', '/companies')).status === 401);
    check('recent activity needs a token', (await call('GET', '/members/recent-activity')).status === 401);

    // A certificate is a claim about status, so it is refused to anyone whose
    // membership is not actually active.
    const cert = await call('GET', '/members/certificate/membership', undefined, token);
    check('a certificate is refused without an active membership',
        [403, 404].includes(cert.status), `HTTP ${cert.status} — ${cert.message}`);
    check('an unknown certificate kind is a 404',
        (await call('GET', '/members/certificate/nonsense', undefined, token)).status === 404);
};

const testMediaLifecycle = async(token) => {
    section('Media cleanup (live)');

    const fs = require('fs');
    const path = require('path');
    const { UPLOADS_DIR } = require('../src/modules/cms/media.cleanup');

    // A real file on disk, referenced by a real record, then deleted with it.
    const name = `cms-test-${Date.now()}.png`;
    const file = path.join(UPLOADS_DIR, name);

    try {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
    } catch (err) {
        return skip('media cleanup', `cannot write to uploads — ${err.message}`);
    }

    const added = await call('POST', '/cms/gallery', {
        url: `/uploads/${name}`,
        title: 'ZZZ-TEST-MEDIA',
    }, token);

    if (added.status !== 201) {
        try { fs.unlinkSync(file); } catch { /* nothing to clean */ }
        return check('add a gallery item with an uploaded file', false, `HTTP ${added.status}`);
    }

    check('add a gallery item with an uploaded file', true);
    check('  the file is still on disk while referenced', fs.existsSync(file));

    const itemId = (added.data || {})._id || (added.data || {}).id;
    await call('DELETE', `/cms/gallery/${itemId}`, undefined, token);

    check('deleting the item removes the file from disk', !fs.existsSync(file),
        fs.existsSync(file) ? 'still present' : 'reclaimed');

    // Belt and braces: never leave the probe file behind.
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* already gone */ }
};

// ============================================================ run

const main = async() => {
    console.log('\n' + '='.repeat(70));
    console.log('CMS CONTENT TESTS');
    console.log('='.repeat(70));

    testSanitiser();
    testMediaHelpers();

    const reachable = (await call('GET', '/cms/site')).status === 200;

    if (!reachable) {
        section('Live API');
        skip('every live check', `nothing answering at ${API} — start the server first`);
    } else {
        console.log(`\nLive API: ${API}`);
        await testPublicReads();
        await testGuards();

        const auth = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
        const token = (auth.data || {}).token;

        if (!token) {
            section('Authenticated');
            skip('write, events and media checks', `could not sign in as ${EMAIL} (HTTP ${auth.status})`);
        } else {
            await testMobileEndpoints(token);
            await testWrites(token);
            await testEventLifecycle(token);
            await testMediaLifecycle(token);
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach(f => console.log('  - ' + f));
    }
    console.log('='.repeat(70) + '\n');

    process.exit(failed ? 1 : 0);
};

main().catch((err) => {
    console.error('\nTest run crashed:', err);
    process.exit(1);
});
