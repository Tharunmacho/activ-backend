const { SharePreview } = require('./cms.models');
const cms = require('./cms.service');
const news = require('./cms.news.service');
const schemes = require('./cms.schemes.service');
const regions = require('./cms.regionPages.service');
const { resolveEventId } = require('../events/eventSlug');
const { eventShareContent } = require('../share/eventShareContent');
const eventImages = require('../share/eventPreviewImage');
const { newsShareContent, newsIndexContent, areaShareContent } = require('../share/pageShareContent');
const ApiError = require('../../core/utils/ApiError');
const { STATIC_PAGES, EDITOR_PAGES, plain, staticPage, normalizePath, defaultImage, cleanPreview } = require('./sharePreviews');

const photoOf = media => media?.type !== 'video' && !/\.(mp4|webm|ogg|mov)(?:[?#]|$)/i.test(media?.url || '') ? media?.url || '' : '';
const mediaOf = (url, alt = '') => ({ url, type: 'image', alt, fit: 'contain', position: 'center' });
const fullPath = (prefix, slug) => `/${prefix}/${encodeURIComponent(slug)}`;

let seeded = false;
let seeding;
const ensureDefaults = async() => {
    if (seeded) return;
    if (!seeding) seeding = SharePreview.bulkWrite(STATIC_PAGES.map(page => ({ updateOne: {
        filter: { path: page.path },
        // Insert only. Restarting the app or reopening CMS cannot replace a
        // photograph the client has already saved.
        update: { $setOnInsert: { path: page.path, title: '', description: '', image: defaultImage(page.path) } },
        upsert: true,
    } }))).then(() => { seeded = true; }).finally(() => { seeding = null; });
    return seeding;
};

const basePreview = async(path) => {
    const fixed = staticPage(path);
    if (fixed) {
        let content = {};
        if (path === '/news') {
            content = newsIndexContent(await news.getSettings());
        } else if (path === '/about') {
            const about = await cms.getAbout();
            content = { title: plain([about.heading, about.headingHighlight].filter(Boolean).join(' ')), description: plain(about.body), image: photoOf(about.media) };
        } else if (path === '/membership') {
            const membership = await require('./cms.membership.service').get();
            content = { title: plain(membership.title), description: plain([membership.subtitleLead, membership.subtitleRest, ...(membership.body || [])].filter(Boolean).join(' ')) };
        } else if (path === '/events') {
            const settings = await cms.getEventsSettings();
            content = { title: plain([settings.heading, settings.headingHighlight].filter(Boolean).join(' ')), description: plain(settings.lede || settings.subtitle), image: photoOf(settings.heroMedia) };
        } else if (path === '/gallery') {
            const [settings, albums] = await Promise.all([cms.getGallerySettings(), cms.listGallery()]);
            content = { title: plain([settings.heading, settings.headingHighlight].filter(Boolean).join(' ')), description: plain(settings.description), image: albums.map(album => photoOf(album.media)).find(Boolean) || '' };
        } else if (path.startsWith('/schemes')) {
            const settings = await schemes.getSettings();
            content = { title: path === '/schemes' ? plain([settings.heading, settings.headingHighlight].filter(Boolean).join(' ')) : '', description: plain(settings.description), image: photoOf(settings.heroImage) };
        }
        return { ...fixed, title: content.title || fixed.title, description: content.description || fixed.description, image: content.image ? mediaOf(content.image, content.alt || content.title || fixed.title) : defaultImage(path), canonicalPath: path, type: 'website' };
    }
    const parts = path.split('/').slice(1);
    const [kind, slug, detail, n] = parts;
    let card;
    if (kind === 'events') {
        const event = await cms.listEvent(await resolveEventId(slug), {});
        if (!event) throw ApiError.notFound('Public event not found');
        const image = eventImages.previewImageUrl(event, '');
        card = { ...eventShareContent(event), image: mediaOf(image, plain(event.title)), imageMeta: image ? { type: 'image/jpeg', width: 1200, height: 630 } : undefined, canonicalPath: fullPath('events', event.slug || event.id || slug), type: 'article', group: 'Events' };
    } else if (kind === 'gallery') {
        const album = await cms.getGalleryItem(slug, {});
        if (!album) throw ApiError.notFound('Public gallery not found');
        const cover = album.media || {};
        // The gallery's cover is photograph 0; the following indices refer to
        // the extra photographs, matching GalleryPhotoPage's links.
        const photo = detail === 'photo' ? (Number(n) === 0 ? cover : (album.photos || [])[Number(n) - 1]) : cover;
        if (detail === 'photo' && !photo) throw ApiError.notFound('Photograph not found');
        const title = plain(photo?.title || photo?.caption || album.title) || 'ACTIV Gallery';
        card = { title, description: plain(photo?.description || album.caption), image: mediaOf(photoOf(photo), plain(photo?.alt) || title), canonicalPath: fullPath('gallery', album.slug || album.id || slug) + (detail === 'photo' ? `/photo/${Number(n)}` : ''), type: 'article', group: 'Gallery' };
    } else if (kind === 'news') {
        const article = await news.getArticle(slug, {});
        if (!article) throw ApiError.notFound('Public article not found');
        const content = newsShareContent(article);
        card = { ...content, image: mediaOf(content.image, content.alt), canonicalPath: fullPath('news', article.slug || slug), type: 'article', group: 'News' };
    } else if (kind === 'states' || kind === 'regions') {
        const doc = kind === 'states' ? await regions.getStatePage(slug, {}) : await regions.getRegionPage(slug, {});
        if (!doc) throw ApiError.notFound('Public page not found');
        const custom = detail?.startsWith('section-') ? (doc.customSections || []).find(section => !section.isHidden && section.key === detail.slice(8)) : null;
        if (detail?.startsWith('section-') && !custom) throw ApiError.notFound('Public section not found');
        const content = areaShareContent(doc, detail, custom);
        card = { ...content, label: detail ? content.title : plain(doc.stateName || doc.regionName || doc.label), image: mediaOf(content.image, content.alt), canonicalPath: fullPath(kind, doc.slug || slug) + (detail ? `/${encodeURIComponent(detail)}` : ''), type: 'website', group: kind === 'regions' ? 'Zones' : 'States' };
    } else if (kind === 'schemes' && slug === 'view') {
        const scheme = await schemes.getScheme(detail, {});
        if (!scheme) throw ApiError.notFound('Public scheme not found');
        card = { title: plain(scheme.title) || 'ACTIV Scheme', description: plain(scheme.summary || scheme.description), image: mediaOf(photoOf(scheme.image), plain(scheme.title)), canonicalPath: `/schemes/view/${encodeURIComponent(scheme.slug || detail)}`, type: 'article', group: 'Schemes' };
    } else if (kind === 'schemes' && slug === 'state') {
        const state = regions.listAllStates().find(row => row.slug === detail);
        if (!state) throw ApiError.notFound('State not found');
        card = { title: `ACTIV ${state.name} Schemes`, description: `Government schemes and opportunities for entrepreneurs in ${state.name}.`, canonicalPath: path, type: 'website', group: 'Schemes' };
    } else if (kind === 'legal') {
        const doc = await cms.getLegalDocument(detail, {});
        if (!doc) throw ApiError.notFound('Public policy not found');
        card = { title: plain(doc.title) || 'ACTIV Policy', description: plain(doc.summary || doc.description), canonicalPath: doc.path || (doc.slug ? `/${doc.slug}` : path), type: 'website', group: 'Legal' };
    }
    if (!card) throw ApiError.notFound('Public page not found');
    return { ...card, path, label: card.label || card.title, description: plain(card.description).slice(0, 700), image: card.image?.url ? card.image : defaultImage(path) };
};

const applyRecord = (base, row) => ({
    ...base,
    title: plain(row?.title) || base.title,
    description: plain(row?.description) || base.description,
    // A seeded dummy remains a fallback when the page later gets a banner.
    image: row?.image?.url && !/\/share\/site-images\/(?:preview-placeholder|activ-conference)\//.test(row.image.url) ? { ...row.image, type: 'image' } : base.image,
    // Blank text fields mean "use the page's own title/description".
    overrides: { title: row?.title || '', description: row?.description || '', image: row?.image || null },
    // Default booking cards share the event canonical. A distinct card saved
    // for /book must keep that URL, so crawlers do not substitute the parent.
    canonicalPath: base.path?.endsWith('/book') && row && (row.title || row.description || row.image?.url) ? base.path : base.canonicalPath,
    updatedAt: row?.updatedAt || null,
});

const resolve = async(rawPath, { renderImage = true } = {}) => {
    const path = normalizePath(rawPath);
    if (!path) throw ApiError.notFound('Public page not found');
    // Validate public visibility before reading its override. An override must
    // never publish a hidden event, a draft article or a private page.
    const [base, row] = await Promise.all([basePreview(path), SharePreview.findOne({ path }).lean()]);
    const card = applyRecord(base, row);
    const body = base.text ? base.text.split('\n').slice(1).join('\n').trim() : base.description;
    card.shareText = [card.title, row?.description && card.description, body].filter(Boolean).join('\n\n');
    card.imageSource = card.image;
    // Use the same non-cropping JPEG conversion as event banners. New upload
    // filenames get new versions, so changing a CMS banner refreshes the image.
    if (renderImage && card.image.url && !/\/api\/v1\/share\/(?:site-images|page-image|events)\//.test(card.image.url)) {
        const version = eventImages.versionOf({ imageUrl: card.image.url });
        card.image = { ...card.image, url: `/api/v1/share/page-image/${version}.jpg?path=${encodeURIComponent(path)}` };
        card.imageMeta = { type: 'image/jpeg', width: 1200, height: 630 };
    }
    return card;
};

const editorData = async() => {
    await ensureDefaults();
    const [saved, bases, map] = await Promise.all([
        SharePreview.find({}).lean(), Promise.all(EDITOR_PAGES.map(page => basePreview(page.path))),
        regions.getMap(),
    ]);
    const rows = new Map(saved.map(row => [row.path, row]));
    // The same published pages as the website's Zones menu. Fetch the full
    // banner and content only when selected, rather than loading every board.
    const zones = map.regions.filter(region => region.hasPage).map(region => ({
        path: fullPath('regions', region.slug), label: plain(region.label), group: 'Zones',
    }));
    return { routes: [...bases.map(base => applyRecord(base, rows.get(base.path))), ...zones] };
};

const save = async(payload, actor = {}) => {
    const clean = cleanPreview(payload);
    await basePreview(clean.path);
    const { path, ...updates } = clean;
    await SharePreview.findOneAndUpdate({ path }, {
        $set: { ...updates, updatedBy: { email: actor.email || '', at: new Date() } },
        $setOnInsert: { path },
    }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    return resolve(path);
};

const reset = async(rawPath) => {
    const path = normalizePath(rawPath);
    if (!path) throw ApiError.badRequest('Choose a public website route');
    await basePreview(path);
    await SharePreview.deleteOne({ path });
    return resolve(path);
};

module.exports = { ensureDefaults, editorData, resolve, save, reset, _test: { basePreview, applyRecord } };
