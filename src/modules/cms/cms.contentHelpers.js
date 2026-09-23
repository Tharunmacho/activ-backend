const ApiError = require('../../core/utils/ApiError');

/**
 * ============================================================================
 * SHARED CLEANERS for the newsroom and the schemes
 * ============================================================================
 *
 * Moved out of `cms.news.service.js` when the schemes got their own screen and
 * their own service. Both read and write the same shapes — media, the editor's
 * own fields, a derived unique slug — and two copies of a cleaner is how one
 * collection starts storing a field the other silently drops.
 */

const str = (value) => String(value ?? '').trim();
const long = (value, max = 40000) => String(value ?? '').trim().slice(0, max);
const num = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/** `true` / `'true'` / `1`, because a multipart body is all strings. */
const bool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || value === 'true' || value === 1 || value === '1';
};

const asArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
};

/**
 * A key the payload carries, or nothing at all.
 *
 * AN ABSENT KEY MEANS UNTOUCHED. A save from a screen that does not render a
 * control must not clear what another screen set — the same rule the events
 * and region writers follow.
 */
const pick = (payload, key, clean) => (
    Object.prototype.hasOwnProperty.call(payload, key) ? { [key]: clean(payload[key]) } : {}
);

const cleanMedia = (input = {}) => ({
    url: str(input.url),
    type: input.type === 'video' ? 'video' : 'image',
    alt: str(input.alt),
    fit: input.fit === 'contain' ? 'contain' : 'cover',
    position: str(input.position) || 'center',
});

const toMedia = (doc = {}) => ({
    url: doc.url || '',
    type: doc.type || 'image',
    alt: doc.alt || '',
    fit: doc.fit || 'cover',
    position: doc.position || 'center',
});

/**
 * ============================================================================
 * THE SLUG IS DERIVED, AND IT IS MADE UNIQUE HERE
 * ============================================================================
 *
 * Never accepted from a client: an article whose stored slug disagrees with
 * its title is a URL that reads as somebody else's story.
 *
 * Two articles can legitimately share a headline — "Annual General Meeting"
 * every year — and the collection has a unique index, so the second save would
 * fail with E11000 and the CMS would report "could not save" on a perfectly
 * ordinary title. A numeric suffix is added until the slug is free, and the
 * row being edited is excluded from that search so re-saving an article does
 * not rename it every time.
 */
const slugify = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

const uniqueSlug = async (Model, title, exceptId) => {
    const base = slugify(title) || 'untitled';
    for (let n = 0; n < 50; n += 1) {
        const candidate = n === 0 ? base : `${base}-${n + 1}`;
        /* eslint-disable no-await-in-loop */
        const clash = await Model.findOne({ slug: candidate }).select('_id').lean();
        if (!clash || String(clash._id) === String(exceptId)) return candidate;
    }
    /* Fifty "annual-general-meeting"s is not a naming problem any more. */
    return `${base}-${Date.now()}`;
};

/**
 * A real date, or null. NEVER the epoch.
 *
 * `listNews` sorts on this, and a missing date standing in as 1970 files an
 * undated article at the far end of the past. Undated articles LEAD the list —
 * something with no date has just been written — and that only works if the
 * absence survives as an absence.
 *
 * A malformed date is an error and not a blank: "not a date I can read" and
 * "no date yet" are different answers, and collapsing them loses the editor's
 * typo silently.
 */
const cleanDate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw ApiError.badRequest('That date could not be read');
    return parsed;
};

/**
 * The editor's own fields, on their way in.
 *
 * A row with no label is a row their “Add field” button made and they never
 * filled in — dropped rather than stored, or the public page grows a
 * labelled line with nothing on either side of it. A row with a label and no
 * value is KEPT: “Correction: —” is a thing somebody may mean to print.
 */
const cleanFields = (value) => asArray(value)
    .map((row) => ({
        label: str(row && row.label).slice(0, 120),
        /* 8000, not 2000: a `content` field is a section of prose rather than
           a one-line fact, and the cap that suited a label-and-value pair
           truncates a write-up mid-sentence with nothing to say it did. */
        value: long(row && row.value, 8000),
        /*
         * The mark drawn beside it, and WHERE it goes — see `namedField` on
         * the schema. Both are asked for rather than guessed: a glyph cannot
         * be inferred from a label somebody typed, and a field that wants to
         * be a paragraph cannot be told apart from one that wants to be a
         * line except by asking.
         */
        icon: str(row && row.icon) || 'info',
        placement: str(row && row.placement) === 'content' ? 'content' : 'card',
    }))
    .filter((row) => row.label)
    .slice(0, 40);

/**
 * The same fields on their way OUT.
 *
 * `icon` and `placement` are defaulted here as well as on save: every row
 * written before they existed has neither, and a page that draws a mark
 * beside each field would otherwise leave a hole — or, for `placement`, put
 * the field nowhere at all.
 */
const toFields = (rows) => (rows || [])
    .map((row) => ({
        label: (row && row.label) || '',
        value: (row && row.value) || '',
        icon: (row && row.icon) || 'info',
        placement: (row && row.placement) === 'content' ? 'content' : 'card',
    }))
    .filter((row) => row.label);

const actorOf = (user = {}) => ({
    email: user.email || user.username || 'cms',
    at: new Date(),
});

/**
 * What the editor did to each card on the News screen.
 *
 * `cleanSections` in `cms.service.js` is the same rule. Each service keeps
 * its own cleaners rather than importing across service boundaries.
 */
const cleanSections = (value) => {
    const seen = new Set();
    return asArray(value)
        .map((row) => ({
            key: str(row && row.key).slice(0, 80),
            hidden: (row && row.hidden) === true || (row && row.hidden) === 'true',
            fields: asArray(row && row.fields)
                .map((f) => ({ label: str(f && f.label), value: long(f && f.value, 2000) }))
                .filter((f) => f.label || f.value)
                .slice(0, 20),
        }))
        .filter((row) => {
            if (!row.key || seen.has(row.key)) return false;
            seen.add(row.key);
            // A card nobody touched carries no information, so it stores no row.
            return row.hidden || row.fields.length > 0;
        })
        .slice(0, 60);
};
module.exports = {
    str, long, num, bool, asArray, pick,
    cleanMedia, toMedia, slugify, uniqueSlug, cleanDate,
    cleanFields, toFields, actorOf, cleanSections,
};
