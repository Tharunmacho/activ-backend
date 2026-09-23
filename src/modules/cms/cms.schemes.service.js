const ApiError = require('../../core/utils/ApiError');
const { Scheme, SchemeSettings, SINGLETON_KEY } = require('./cms.models');
const {
    str, long, num, bool, asArray, pick,
    cleanMedia, toMedia, uniqueSlug,
    cleanFields, toFields, actorOf, cleanSections,
} = require('./cms.contentHelpers');

/**
 * ============================================================================
 * GOVERNMENT SCHEMES — `/schemes`, and the CMS screen behind it
 * ============================================================================
 *
 * The schemes used to be a band at the foot of the newsroom. They have their
 * own page now, read the way a member asks the question:
 *
 *     Central  ->  every national scheme
 *     State    ->  pick a state  ->  its state schemes, then its district ones
 *
 * The collection is unchanged (`web_schemes`) and so is the rule the old band
 * followed: `tier` is STORED, never derived from whether a state is filled in.
 * A national scheme administered from Chennai is still national.
 *
 * ------------------------------------------------- every field, three places
 *
 * The same rule as the newsroom: a field is named in the schema, in
 * `cleanScheme` on the way in and in `toScheme` on the way out. Missing from
 * the second it is dropped on save; missing from the third it is saved and
 * invisible, which is worse.
 */

const TIERS = ['national', 'state', 'district'];

/**
 * Region names are free text an editor typed, so they are compared the way
 * `regionMatch` compares them: case-insensitive, whitespace collapsed.
 * "Tamil Nadu" and "tamil  nadu" must be one state here, or the state page
 * shows half its schemes.
 */
const norm = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

const cleanScheme = (payload = {}) => ({
    ...pick(payload, 'title', str),
    ...pick(payload, 'summary', (v) => long(v, 1200)),
    ...pick(payload, 'body', (v) => long(v)),
    ...pick(payload, 'tier', (v) => (TIERS.includes(v) ? v : 'national')),
    ...pick(payload, 'state', str),
    ...pick(payload, 'district', str),
    ...pick(payload, 'authority', str),
    ...pick(payload, 'eligibility', (v) => long(v, 1200)),
    ...pick(payload, 'deadline', str),
    ...pick(payload, 'applyUrl', str),
    ...pick(payload, 'documentUrl', str),
    ...pick(payload, 'icon', str),
    ...pick(payload, 'category', str),
    ...pick(payload, 'benefits', (v) => long(v, 8000)),
    ...pick(payload, 'howToApply', (v) => long(v, 8000)),
    ...pick(payload, 'documentsRequired', (v) => asArray(v).map(str).filter(Boolean).slice(0, 40)),
    ...pick(payload, 'helpline', (v) => long(v, 600)),
    ...pick(payload, 'image', cleanMedia),
    ...pick(payload, 'featured', (v) => bool(v)),
    ...pick(payload, 'sortOrder', (v) => num(v)),
    ...pick(payload, 'extraFields', cleanFields),
    ...pick(payload, 'status', (v) => (v === 'published' ? 'published' : 'draft')),
});

/**
 * A national scheme carries no region, whatever was typed into the boxes
 * before its tier was changed — and a state scheme carries no district. The
 * form hides those boxes; this is what stops a hidden value from filing the
 * scheme somewhere the editor can no longer see.
 */
const settleRegion = (updates, existing = {}) => {
    const tier = updates.tier || existing.tier || 'national';
    if (tier === 'national') { updates.state = ''; updates.district = ''; }
    if (tier === 'state') updates.district = '';
    return updates;
};

const toScheme = (doc = {}) => ({
    id: String(doc._id || ''),
    slug: doc.slug || '',
    title: doc.title || '',
    summary: doc.summary || '',
    body: doc.body || '',
    tier: doc.tier || 'national',
    state: doc.state || '',
    district: doc.district || '',
    authority: doc.authority || '',
    eligibility: doc.eligibility || '',
    deadline: doc.deadline || '',
    applyUrl: doc.applyUrl || '',
    documentUrl: doc.documentUrl || '',
    icon: doc.icon || 'file-text',
    category: doc.category || '',
    benefits: doc.benefits || '',
    howToApply: doc.howToApply || '',
    documentsRequired: doc.documentsRequired || [],
    helpline: doc.helpline || '',
    image: toMedia(doc.image),
    featured: doc.featured === true,
    extraFields: toFields(doc.extraFields),
    status: doc.status || 'draft',
    sortOrder: Number(doc.sortOrder || 0),
    updatedAt: doc.updatedAt || null,
});

const cleanSettings = (payload = {}) => ({
    ...pick(payload, 'badgeIcon', str),
    ...pick(payload, 'badgeText', str),
    ...pick(payload, 'heading', str),
    ...pick(payload, 'headingHighlight', str),
    ...pick(payload, 'description', (v) => long(v, 2000)),
    ...pick(payload, 'heroImage', cleanMedia),
    ...pick(payload, 'centralLabel', str),
    ...pick(payload, 'centralDescription', (v) => long(v, 600)),
    ...pick(payload, 'stateLabel', str),
    ...pick(payload, 'stateDescription', (v) => long(v, 600)),
    ...pick(payload, 'emptyMessage', (v) => long(v, 600)),
    ...pick(payload, 'sections', cleanSections),
});

const toSettings = (doc = {}) => ({
    badgeIcon: doc.badgeIcon || 'landmark',
    badgeText: doc.badgeText || 'Schemes',
    heading: doc.heading || 'Government schemes for',
    headingHighlight: doc.headingHighlight ?? 'our members',
    description: doc.description || '',
    heroImage: toMedia(doc.heroImage),
    centralLabel: doc.centralLabel || 'Central schemes',
    centralDescription: doc.centralDescription
        || 'Run by the Government of India, open to members in every state.',
    stateLabel: doc.stateLabel || 'State schemes',
    stateDescription: doc.stateDescription
        || 'Run by a state government, with district schemes inside each state.',
    emptyMessage: doc.emptyMessage || '',
    sections: doc.sections || [],
});

/** Featured first, then the editor's order, then by name. */
const inOrder = (rows) => [...rows].sort((a, b) => (
    (Number(b.featured === true) - Number(a.featured === true))
    || (Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
    || String(a.title || '').localeCompare(String(b.title || ''))
));

const service = {
    /* ------------------------------------------------------------- public */

    /**
     * One list, narrowed.
     *
     *   ?tier=national                -> the Central page
     *   ?state=Tamil Nadu             -> that state's state AND district schemes
     *   ?state=…&district=Coimbatore  -> the state's own, plus that district's
     *
     * A state page lists both of its tiers because a member in Tamil Nadu is
     * asking "what can I apply to here", and a district scheme inside the
     * state is part of that answer. The page groups them.
     */
    async listSchemes({ tier = '', state = '', district = '', includeDrafts = false } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };
        if (TIERS.includes(tier)) filter.tier = tier;

        const rows = await Scheme.find(filter).lean().catch(() => []);

        const wantState = norm(state);
        const wantDistrict = norm(district);

        const kept = (rows || []).filter((row) => {
            if (!wantState) return true;
            if (row.tier === 'national') return false;
            if (norm(row.state) !== wantState) return false;
            if (wantDistrict && row.tier === 'district' && norm(row.district) !== wantDistrict) return false;
            return true;
        });

        return inOrder(kept).map(toScheme);
    },

    /**
     * How many schemes each state holds, for the states grid.
     *
     * Counted here rather than by fetching every scheme into the browser: the
     * grid needs thirty-six numbers, not thirty-six lists.
     */
    async stateCounts({ includeDrafts = false } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };
        filter.tier = { $in: ['state', 'district'] };

        const rows = await Scheme.find(filter).select('tier state').lean().catch(() => []);
        const counts = {};
        (rows || []).forEach((row) => {
            const key = norm(row.state);
            if (!key) return;
            const entry = counts[key] || (counts[key] = { state: row.state, state_: 0, district: 0 });
            if (row.tier === 'state') entry.state_ += 1; else entry.district += 1;
        });

        return Object.values(counts).map((c) => ({
            state: c.state,
            stateSchemes: c.state_,
            districtSchemes: c.district,
            total: c.state_ + c.district,
        }));
    },

    async getScheme(slug, { includeDrafts = false } = {}) {
        const doc = await Scheme.findOne({ slug: String(slug || '') }).lean();
        if (!doc || (!includeDrafts && doc.status !== 'published')) {
            throw ApiError.notFound('That scheme is not published');
        }
        return toScheme(doc);
    },

    async getSettings() {
        const doc = await SchemeSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
        return toSettings(doc || {});
    },

    /* -------------------------------------------------------------- admin */

    async listForAdmin() {
        const [schemes, settings] = await Promise.all([
            Scheme.find({}).lean().catch(() => []),
            SchemeSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
        ]);
        return {
            schemes: inOrder(schemes || []).map(toScheme),
            settings: toSettings(settings || {}),
        };
    },

    async saveScheme(id, payload = {}, user = {}) {
        const updates = { ...cleanScheme(payload), editedBy: actorOf(user) };

        if (id) {
            const existing = await Scheme.findById(id);
            if (!existing) throw ApiError.notFound('No such scheme');
            settleRegion(updates, existing);
            if (updates.title && updates.title !== existing.title) {
                updates.slug = await uniqueSlug(Scheme, updates.title, id);
            }
            const doc = await Scheme.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();
            return toScheme(doc);
        }

        settleRegion(updates);
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
        const doc = await SchemeSettings.findOneAndUpdate(
            { key: SINGLETON_KEY },
            { $set: { ...cleanSettings(payload), editedBy: actorOf(user) } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();
        return toSettings(doc);
    },
};

module.exports = service;
module.exports.cleanScheme = cleanScheme;
module.exports.toScheme = toScheme;
module.exports.norm = norm;
