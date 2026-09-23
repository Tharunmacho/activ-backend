const ApiError = require('../../core/utils/ApiError');
const { NewsArticle, Scheme, NewsSettings, SINGLETON_KEY } = require('./cms.models');

/**
 * ============================================================================
 * THE NEWSROOM — articles, and the schemes under them
 * ============================================================================
 *
 * Two collections through one service, because they are edited on one screen
 * and read by one page. They are not one collection: see the note at the head
 * of `newsArticleSchema`.
 *
 * ------------------------------------------------- every field, three places
 *
 * The rule the region pages follow, for the same reason: Mongoose strict mode
 * drops a path the schema does not name and returns `success: true` while
 * doing it. Every field therefore appears in the schema, in a `clean*` on the
 * way in, and in a `to*` on the way out, and the three are kept beside each
 * other in this file. A field missing from the second is dropped on save; a
 * field missing from the third is saved and invisible, which is worse.
 */

const {
    str, long, num, bool, asArray, pick,
    cleanMedia, toMedia, uniqueSlug, cleanDate,
    cleanFields, toFields, actorOf, cleanSections,
} = require('./cms.contentHelpers');
const { cleanScheme, toScheme } = require('./cms.schemes.service');

/* ---------------------------------------------------------------- articles */

const cleanArticle = (payload = {}) => ({
    ...pick(payload, 'title', str),
    ...pick(payload, 'summary', (v) => long(v, 1200)),
    ...pick(payload, 'body', (v) => long(v)),
    ...pick(payload, 'image', cleanMedia),
    ...pick(payload, 'photos', (v) => asArray(v).map(cleanMedia).filter((m) => m.url)),
    ...pick(payload, 'externalUrl', str),
    ...pick(payload, 'sourceName', str),
    ...pick(payload, 'displayDate', str),
    ...pick(payload, 'publishedAt', cleanDate),
    ...pick(payload, 'category', str),
    ...pick(payload, 'location', str),
    ...pick(payload, 'state', str),
    ...pick(payload, 'district', str),
    ...pick(payload, 'featured', (v) => bool(v)),
    ...pick(payload, 'sortOrder', (v) => num(v)),
    ...pick(payload, 'extraFields', cleanFields),
    ...pick(payload, 'status', (v) => (v === 'published' ? 'published' : 'draft')),
});

const toArticle = (doc = {}) => ({
    id: String(doc._id || ''),
    slug: doc.slug || '',
    title: doc.title || '',
    summary: doc.summary || '',
    body: doc.body || '',
    image: toMedia(doc.image),
    photos: (doc.photos || []).map(toMedia),
    externalUrl: doc.externalUrl || '',
    sourceName: doc.sourceName || '',
    displayDate: doc.displayDate || '',
    publishedAt: doc.publishedAt || null,
    category: doc.category || '',
    location: doc.location || '',
    state: doc.state || '',
    district: doc.district || '',
    featured: doc.featured === true,
    extraFields: toFields(doc.extraFields),
    status: doc.status || 'draft',
    sortOrder: Number(doc.sortOrder || 0),
    updatedAt: doc.updatedAt || null,
});

/* ----------------------------------------------------------------- schemes */

/* `cleanScheme` / `toScheme` live in `cms.schemes.service.js` now, with the
   Schemes screen that owns them. The two legacy routes below still use them,
   so an older client writing through `/news-admin/schemes` stores the same
   shape the new screen does. */

/* ---------------------------------------------------------------- settings */

const cleanSettings = (payload = {}) => ({
    ...pick(payload, 'badgeIcon', str),
    ...pick(payload, 'badgeText', str),
    ...pick(payload, 'heading', str),
    ...pick(payload, 'headingHighlight', str),
    ...pick(payload, 'description', (v) => long(v, 2000)),
    ...pick(payload, 'heroImage', cleanMedia),
    ...pick(payload, 'categories', (v) => asArray(v).map(str).filter(Boolean)),
    ...pick(payload, 'schemesHeading', str),
    ...pick(payload, 'schemesDescription', (v) => long(v, 2000)),
    ...pick(payload, 'sections', cleanSections),
});

const toSettings = (doc = {}) => ({
    badgeIcon: doc.badgeIcon || 'newspaper',
    badgeText: doc.badgeText || 'Newsroom',
    heading: doc.heading || 'What is happening at',
    headingHighlight: doc.headingHighlight || 'ACTIV',
    description: doc.description || '',
    heroImage: toMedia(doc.heroImage),
    categories: doc.categories || [],
    schemesHeading: doc.schemesHeading || 'Schemes & Benefits',
    schemesDescription: doc.schemesDescription || '',
    sections: doc.sections || [],
});

/**
 * ============================================================================
 * THE ORDER THE NEWSROOM READS IN
 * ============================================================================
 *
 * `publishedAt` descending, nulls first, then `createdAt` descending.
 *
 * Mongo sorts null BEFORE any date in an ascending sort and AFTER it in a
 * descending one, which would bury an undated article at the bottom. So the
 * sort is done in memory on a list that is already page-sized: the newsroom
 * shows tens of articles, not thousands, and a correct order on the first
 * screen matters more than saving a few milliseconds on a collection this
 * size. When it stops being this size, this is the thing to revisit.
 */
const newestFirst = (rows) => [...rows].sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : Infinity;
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : Infinity;
    if (at !== bt) return bt - at;
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
});

const service = {
    /* ------------------------------------------------------------- public */

    /**
     * The newsroom list.
     *
     * `state` and `district` narrow it; neither given is everything, which is
     * what the national page shows. A national article — one with no state on
     * it — appears in EVERY filter, because it is news for everybody and a
     * Tamil Nadu reader filtering to Tamil Nadu has not asked to stop hearing
     * about the association as a whole.
     */
    async listNews({ state = '', district = '', category = '', includeDrafts = false, limit = 60 } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };
        if (category) filter.category = category;

        const rows = await NewsArticle.find(filter).limit(Math.min(200, Math.max(1, limit)))
            .lean()
            .catch(() => []);

        const wanted = (row) => {
            if (state && row.state && row.state !== state) return false;
            if (district && row.district && row.district !== district) return false;
            return true;
        };

        return newestFirst((rows || []).filter(wanted)).map(toArticle);
    },

    async getArticle(slug, { includeDrafts = false } = {}) {
        const doc = await NewsArticle.findOne({ slug: String(slug || '') }).lean();
        if (!doc || (!includeDrafts && doc.status !== 'published')) {
            throw ApiError.notFound('That article is not published');
        }
        return toArticle(doc);
    },

    /**
     * The schemes, grouped by tier.
     *
     * Grouped on the server because the grouping IS the answer: the page draws
     * three columns and a client that had to group a flat list would be a
     * second place the tier rule lives.
     */
    async listSchemes({ state = '', district = '', includeDrafts = false } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };
        const rows = await Scheme.find(filter).sort({ sortOrder: 1, title: 1 }).lean().catch(() => []);

        const wanted = (row) => {
            if (row.tier === 'state' && state && row.state && row.state !== state) return false;
            if (row.tier === 'district' && district && row.district && row.district !== district) return false;
            return true;
        };

        const kept = (rows || []).filter(wanted).map(toScheme);
        return {
            national: kept.filter((r) => r.tier === 'national'),
            state: kept.filter((r) => r.tier === 'state'),
            district: kept.filter((r) => r.tier === 'district'),
        };
    },

    async getSettings() {
        const doc = await NewsSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
        return toSettings(doc || {});
    },

    /* -------------------------------------------------------------- admin */

    async listForAdmin() {
        const [news, schemes, settings] = await Promise.all([
            NewsArticle.find({}).lean().catch(() => []),
            Scheme.find({}).sort({ tier: 1, sortOrder: 1 }).lean().catch(() => []),
            NewsSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
        ]);

        return {
            news: newestFirst(news || []).map(toArticle),
            schemes: (schemes || []).map(toScheme),
            settings: toSettings(settings || {}),
        };
    },

    async saveArticle(id, payload = {}, user = {}) {
        const updates = { ...cleanArticle(payload), editedBy: actorOf(user) };

        if (id) {
            const existing = await NewsArticle.findById(id);
            if (!existing) throw ApiError.notFound('No such article');
            /* Re-slugged only when the title moved, so a published URL is not
               rewritten by an edit to the body. */
            if (updates.title && updates.title !== existing.title) {
                updates.slug = await uniqueSlug(NewsArticle, updates.title, id);
            }
            const doc = await NewsArticle.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
            return toArticle(doc);
        }

        const doc = await NewsArticle.create({
            ...updates,
            slug: await uniqueSlug(NewsArticle, updates.title || 'untitled'),
        });
        return toArticle(doc.toObject());
    },

    async deleteArticle(id) {
        const done = await NewsArticle.findByIdAndDelete(id);
        if (!done) throw ApiError.notFound('No such article');
        return { deleted: true };
    },

    async saveScheme(id, payload = {}, user = {}) {
        const updates = { ...cleanScheme(payload), editedBy: actorOf(user) };

        if (id) {
            const existing = await Scheme.findById(id);
            if (!existing) throw ApiError.notFound('No such scheme');
            if (updates.title && updates.title !== existing.title) {
                updates.slug = await uniqueSlug(Scheme, updates.title, id);
            }
            const doc = await Scheme.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
            return toScheme(doc);
        }

        const doc = await Scheme.create({
            ...updates,
            slug: await uniqueSlug(Scheme, updates.title || 'untitled'),
        });
        return toScheme(doc.toObject());
    },

    async deleteScheme(id) {
        const done = await Scheme.findByIdAndDelete(id);
        if (!done) throw ApiError.notFound('No such scheme');
        return { deleted: true };
    },

    async saveSettings(payload = {}, user = {}) {
        const doc = await NewsSettings.findOneAndUpdate(
            { key: SINGLETON_KEY },
            { $set: { ...cleanSettings(payload), editedBy: actorOf(user) } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();
        return toSettings(doc);
    },
};

module.exports = service;
