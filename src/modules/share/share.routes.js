/**
 * LINK PREVIEWS for the public website — `/api/v1/share/events/:slug`,
 * `/api/v1/share/gallery/:slug`, `/api/v1/share/news[/:slug]` and the state and
 * zone (`/regions/:slug`) pages.
 *
 * WhatsApp, Facebook, LinkedIn, X, Telegram… never run the site's JavaScript.
 * They fetch the pasted URL and read the <meta property="og:*"> tags in the
 * HTML that comes back. The website is deployed as static files on Apache, so
 * every URL answers with the same index.html and every event shared anywhere
 * previewed as the site's generic card with no banner.
 *
 * The site's `.htaccess` (website/public/share-previews.htaccess, merged into
 * public_html by the deploy) rewrites a CRAWLER's request for
 * `/events/<slug>` or `/gallery/<slug>` to these routes. People never reach
 * them; if one does (a direct link), the page sends them on to the real page.
 *
 * Visibility is the public API's own: `cmsService.listEvent` and
 * `getGalleryItem` 404 a draft, members-only or non-onboarding event exactly as
 * the public page does, so a preview can never show more than the page would.
 */
const express = require('express');
const config = require('../../config');
const cmsService = require('../cms/cms.service');
const { resolveEventId } = require('../events/eventSlug');

const router = express.Router();

const SITE_NAME = 'ACTIV - Adidravidar Confederation of Trade & Industrial Vision';
const TZ = 'Asia/Kolkata';

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const oneLine = (v) => str(v).replace(/\s+/g, ' ');
const esc = (v) => str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The public site's origin: FRONTEND_URL, else the host the crawler asked. */
const siteOrigin = (req) => {
    const configured = str(config.frontendUrl).replace(/\/+$/, '');
    if (configured && !/localhost|127\.0\.0\.1/i.test(configured)) return configured;
    const host = str(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0].trim();
    const proto = str(req.headers['x-forwarded-proto']).split(',')[0].trim() || req.protocol || 'https';
    return host ? `${proto}://${host}` : configured;
};

/**
 * An absolute, crawler-sized image URL. Our own uploads get `?w=1200`, which
 * `imageVariants` answers with a ~150 KB JPEG — WhatsApp drops the image from
 * a card whose picture is much over 300 KB, and the raw banner PNGs are 600 KB+.
 */
const shareImage = (req, raw) => {
    let url = str(raw);
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = `${siteOrigin(req)}${url.startsWith('/') ? '' : '/'}${url}`;
    try {
        const parsed = new URL(url);
        if (/^\/uploads\/[^/]+\.(jpe?g|png|webp)$/i.test(parsed.pathname) && !parsed.searchParams.has('w')) {
            parsed.searchParams.set('w', '1200');
        }
        return parsed.toString();
    } catch {
        return url;
    }
};

/**
 * The picture's real size and type. Facebook shows a GREY box on the first
 * share of an image it has not seen yet unless og:image:width/height are in
 * the page — it measures in the background and only the next share gets the
 * picture. Measured once per URL and remembered; never blocks the card for
 * more than 3 s, and a failure just leaves the tags out.
 */
const imageInfoCache = new Map();
const imageInfo = async(url) => {
    if (!url) return null;
    if (imageInfoCache.has(url)) return imageInfoCache.get(url);
    let info = null;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const meta = await require('sharp')(Buffer.from(await res.arrayBuffer())).metadata();
            if (meta && meta.width && meta.height) {
                const type = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[meta.format] || '';
                info = { width: meta.width, height: meta.height, type };
            }
        }
    } catch {
        info = null;
    }
    if (imageInfoCache.size > 200) imageInfoCache.delete(imageInfoCache.keys().next().value);
    if (info) imageInfoCache.set(url, info);
    return info;
};

const validDate = (value) => {
    const d = value ? new Date(value) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
};

/** "10 October 2026" */
const longDate = (d) => d.toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
/** "Saturday, 10 October 2026 · 9:00 am IST" */
const fullWhen = (d) => `${d.toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`
    + ` · ${d.toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })} IST`;

/** Where it happens, in the words the editor used. */
const venueOf = (event) => {
    if (str(event.mode).toLowerCase() === 'online') {
        return `Online${str(event.onlinePlatform) ? ` (${str(event.onlinePlatform)})` : ''}`;
    }
    return oneLine(event.venue || event.location);
};

/**
 * The card: "<Event name> on <date> at <venue>" as the title, and every other
 * detail a reader decides on in the description.
 */
const eventCard = (event) => {
    const name = oneLine(event.title) || 'ACTIV event';
    const start = validDate(event.startAt);
    const venue = venueOf(event);

    const title = [name, start ? `on ${longDate(start)}` : '', venue ? `at ${venue}` : '']
        .filter(Boolean).join(' ');

    const where = [venue, str(event.mode).toLowerCase() === 'online' ? '' : oneLine(event.venueAddress)]
        .filter(Boolean).join(', ');
    const details = [
        start ? `📅 ${fullWhen(start)}` : '📅 Date to be confirmed',
        where ? `📍 ${where}` : '',
    ].filter(Boolean).join('  ');
    const about = oneLine(event.description);
    const description = [details, about].filter(Boolean).join(' — ').slice(0, 300);

    return { title, description, image: event.imageUrl || (event.media && event.media.url) || '', alt: name };
};

const page = ({ title, description, image, alt, url, type = 'article', imageMeta = null }) => {
    const tags = [
        ['property', 'og:type', type],
        ['property', 'og:site_name', SITE_NAME],
        ['property', 'og:title', title],
        ['property', 'og:description', description],
        ['property', 'og:url', url],
        ['property', 'og:image', image],
        ['property', 'og:image:secure_url', image.startsWith('https://') ? image : ''],
        ['property', 'og:image:type', (imageMeta && imageMeta.type) || ''],
        ['property', 'og:image:width', imageMeta ? String(imageMeta.width) : ''],
        ['property', 'og:image:height', imageMeta ? String(imageMeta.height) : ''],
        ['property', 'og:image:alt', alt || title],
        ['property', 'og:locale', 'en_IN'],
        ['name', 'twitter:card', image ? 'summary_large_image' : 'summary'],
        ['name', 'twitter:title', title],
        ['name', 'twitter:description', description],
        ['name', 'twitter:image', image],
        ['name', 'description', description],
    ].filter(([, , v]) => v)
        .map(([a, k, v]) => `<meta ${a}="${k}" content="${esc(v)}" />`).join('\n    ');

    // A person who lands here goes on to the page itself. `ref=share` stops
    // the .htaccess rule sending them straight back (see share-previews.htaccess).
    const human = `${url}${url.includes('?') ? '&' : '?'}ref=share`;
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)} | ACTIV</title>
    <link rel="canonical" href="${esc(url)}" />
    ${tags}
  </head>
  <body>
    <h1>${esc(title)}</h1>
    ${image ? `<p><img src="${esc(image)}" alt="${esc(alt || title)}" style="max-width:100%" /></p>` : ''}
    <p>${esc(description)}</p>
    <p><a href="${esc(human)}">Open on activ.org.in</a></p>
    <script>location.replace(${JSON.stringify(human).replace(/</g, '\\u003c')});</script>
  </body>
</html>`;
};

const send = (res, html) => {
    res.vary('User-Agent');
    // Helmet's CSP forbids inline script; this page's one line is the redirect.
    res.set('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    res.set('Cache-Control', 'public, max-age=300');
    res.type('html').send(html);
};

/** Unknown / hidden: the site's own index, so a crawler still gets its default card. */
const fallback = (req, res, path) => {
    res.redirect(302, `${siteOrigin(req)}${path}${path.includes('?') ? '&' : '?'}ref=share`);
};

router.get(['/events/:slug', '/events/:slug/book'], async(req, res) => {
    const slug = str(req.params.slug);
    try {
        const id = await resolveEventId(slug);
        const event = await cmsService.listEvent(id, {});
        if (!event) return fallback(req, res, `/events/${encodeURIComponent(slug)}`);
        const url = `${siteOrigin(req)}/events/${encodeURIComponent(event.slug || event.id || slug)}`;
        const card = eventCard(event);
        const image = shareImage(req, card.image);
        return send(res, page({ ...card, image, url, imageMeta: await imageInfo(image) }));
    } catch {
        return fallback(req, res, `/events/${encodeURIComponent(slug)}`);
    }
});

router.get(['/gallery/:slug', '/gallery/:slug/photo/:n'], async(req, res) => {
    const slug = str(req.params.slug);
    try {
        const item = await cmsService.getGalleryItem(slug, {});
        if (!item) return fallback(req, res, `/gallery/${encodeURIComponent(slug)}`);
        const url = `${siteOrigin(req)}/gallery/${encodeURIComponent(item.slug || item._id || slug)}`;
        const title = oneLine(item.title) || 'ACTIV gallery';
        const image = shareImage(req, item.media && item.media.url);
        return send(res, page({
            title,
            description: oneLine(item.caption).slice(0, 300),
            image,
            imageMeta: await imageInfo(image),
            alt: title,
            url,
        }));
    } catch {
        return fallback(req, res, `/gallery/${encodeURIComponent(slug)}`);
    }
});

/**
 * News: one article's own card — headline as the title, the date and place the
 * newsroom prints, then the summary; the article's picture, else its first
 * photo. `getArticle` throws for a draft exactly as the public page does, so a
 * preview never shows an article the page would not.
 */
const newsCard = (article) => {
    const title = oneLine(article.title) || 'ACTIV news';
    const published = validDate(article.publishedAt);
    const when = oneLine(article.displayDate) || (published ? longDate(published) : '');
    const where = oneLine(article.location) || [oneLine(article.district), oneLine(article.state)].filter(Boolean).join(', ');
    const details = [when ? `📅 ${when}` : '', where ? `📍 ${where}` : ''].filter(Boolean).join('  ');
    const about = oneLine(article.summary) || oneLine(article.body);
    const description = [details, about].filter(Boolean).join(' — ').slice(0, 300);
    const photo = (article.photos || []).find((m) => m && m.url);
    const image = (article.image && article.image.url) || (photo && photo.url) || '';
    return { title, description, image, alt: oneLine(article.image && article.image.alt) || title };
};

router.get('/news/:slug', async(req, res) => {
    const slug = str(req.params.slug);
    const path = `/news/${encodeURIComponent(slug)}`;
    try {
        const article = await require('../cms/cms.news.service').getArticle(slug, {});
        if (!article) return fallback(req, res, path);
        const card = newsCard(article);
        const image = shareImage(req, card.image);
        return send(res, page({
            ...card,
            image,
            imageMeta: await imageInfo(image),
            url: `${siteOrigin(req)}/news/${encodeURIComponent(article.slug || slug)}`,
        }));
    } catch {
        return fallback(req, res, path);
    }
});

/** The newsroom itself: the heading, description and hero picture its editor set. */
router.get('/news', async(req, res) => {
    try {
        const settings = await require('../cms/cms.news.service').getSettings();
        const heading = [oneLine(settings.heading), oneLine(settings.headingHighlight)].filter(Boolean).join(' ');
        const title = heading || 'ACTIV News';
        const image = shareImage(req, settings.heroImage && settings.heroImage.url);
        return send(res, page({
            title,
            description: (oneLine(settings.description) || 'News, chapters and announcements from ACTIV.').slice(0, 300),
            image,
            imageMeta: await imageInfo(image),
            alt: title,
            url: `${siteOrigin(req)}/news`,
            type: 'website',
        }));
    } catch {
        return fallback(req, res, '/news');
    }
});

/**
 * State and region pages: the editor's "When the page is shared" fields
 * (`seo`), falling back to the page's own name, summary and hero picture —
 * the same choices StatePage / RegionPage make in the browser.
 */
const areaPage = (kind) => async(req, res) => {
    const slug = str(req.params.slug);
    const path = `/${kind}/${encodeURIComponent(slug)}`;
    try {
        const regionPages = require('../cms/cms.regionPages.service');
        const doc = kind === 'states'
            ? await regionPages.getStatePage(slug, {})
            : await regionPages.getRegionPage(slug, {});
        if (!doc) return fallback(req, res, path);
        const seo = doc.seo || {};
        const name = oneLine(kind === 'states' ? doc.stateName : (doc.regionName || doc.label));
        const title = oneLine(seo.metaTitle) || `ACTIV ${name}`.trim();
        const hero = (doc.heroCarousel || [])[0];
        const image = shareImage(req, seo.ogImageUrl || (hero && hero.media && hero.media.url) || (doc.explore && doc.explore.imageUrl) || '');
        return send(res, page({
            title,
            description: (oneLine(seo.metaDescription) || oneLine(doc.shortDescription)).slice(0, 300),
            image,
            imageMeta: await imageInfo(image),
            alt: title,
            url: `${siteOrigin(req)}/${kind}/${encodeURIComponent(doc.slug || slug)}`,
            type: 'website',
        }));
    } catch {
        return fallback(req, res, path);
    }
};
router.get(['/states/:slug', '/states/:slug/:type'], areaPage('states'));
router.get(['/regions/:slug', '/regions/:slug/:type'], areaPage('regions'));

module.exports = router;
module.exports._test = { eventCard, newsCard, shareImage, page };
