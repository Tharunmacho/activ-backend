/**
 * An event's PUBLIC ADDRESS: `/events/nlc-business-opportunities-2026-09-27`.
 *
 * The title and the IST start date, lower-case, hyphenated. It replaces the
 * 24-character Mongo id in every link a person sees or shares, because a link
 * pasted into Facebook or WhatsApp is read by a person before it is clicked.
 *
 * FIXED ONCE WRITTEN. Retitling or moving an event does not change its slug:
 * every link already posted to a social feed, printed on a flyer or sent in a
 * confirmation would otherwise break. The id keeps working too — both resolve.
 *
 * UNIQUE BY SUFFIX. Two events with the same title on the same day get `-2`,
 * `-3`; the unique index on the field is the real guarantee.
 */
const mongoose = require('mongoose');

const TZ = 'Asia/Kolkata';

/** "How to get NLC work?" -> "how-to-get-nlc-work". Empty for a Tamil-only title. */
const slugify = (text) => String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');

/** "2026-09-27", in IST — the date the event is on where it happens. */
const datePart = (startAt) => {
    const d = startAt ? new Date(startAt) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-CA', { timeZone: TZ });
};

const baseSlug = (event = {}) =>
    [slugify(event.title) || 'event', datePart(event.startAt)].filter(Boolean).join('-');

const isObjectId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value || ''));

/** The first free slug for this event: `base`, then `base-2`, `base-3` … */
const uniqueSlug = async(Model, event = {}) => {
    const base = baseSlug(event);
    for (let n = 1; n < 500; n += 1) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        const clash = await Model.exists({ slug: candidate, _id: { $ne: event._id } });
        if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
};

/**
 * The Mongo id for a value that may be an id or a slug. Returns the value
 * unchanged when it is already an id or matches nothing, so the caller's own
 * "not found" handling still decides what a bad link shows.
 */
const resolveEventId = async(idOrSlug) => {
    const value = String(idOrSlug || '').trim();
    if (!value || isObjectId(value)) return value;
    const Event = mongoose.model('Event');
    const doc = await Event.findOne({ slug: value.toLowerCase() }).select('_id').lean().catch(() => null);
    return doc ? String(doc._id) : value;
};

/** Express `router.param` handler: rewrites a slug in `:name` to the id. */
const resolveEventParam = async(req, res, next, value, name) => {
    try {
        req.params[name] = await resolveEventId(value);
        next();
    } catch (error) {
        next(error);
    }
};

/*
 * GALLERY ITEMS get the same kind of address: `/gallery/activ-inked-mou-with-gem-2026-09-10`.
 * The title, plus the item's date when the free-text `eventDate` reads as one.
 * Same rules as an event: written once on create, never changed by an edit,
 * and the old id links keep working.
 */
const galleryBaseSlug = (item = {}) => {
    const d = item.eventDate ? new Date(item.eventDate) : null;
    return [slugify(item.title) || 'gallery', d && !Number.isNaN(d.getTime()) ? datePart(d) : '']
        .filter(Boolean).join('-');
};

/** The first free slug for a document, against its own model, from a base. */
const uniqueSlugFrom = async(Model, doc = {}, base = '') => {
    for (let n = 1; n < 500; n += 1) {
        const candidate = n === 1 ? base : `${base}-${n}`;
        const clash = await Model.exists({ slug: candidate, _id: { $ne: doc._id } });
        if (!clash) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
};

/** The id for a gallery link that may carry an id or a slug. */
const resolveGalleryId = async(Model, idOrSlug) => {
    const value = String(idOrSlug || '').trim();
    if (!value || isObjectId(value)) return value;
    const doc = await Model.findOne({ slug: value.toLowerCase() }).select('_id').lean().catch(() => null);
    return doc ? String(doc._id) : value;
};

/** `/events/<slug>` when the event has one, `/events/<id>` otherwise. */
const eventPath = (event = {}) => `/events/${encodeURIComponent(event.slug || String(event._id || event.id || ''))}`;

module.exports = {
    slugify, baseSlug, uniqueSlug, resolveEventId, resolveEventParam, eventPath, isObjectId,
    galleryBaseSlug, uniqueSlugFrom, resolveGalleryId
};
