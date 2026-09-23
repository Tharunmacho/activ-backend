const ApiError = require('../../core/utils/ApiError');
const { RegionPage, StatePage, GalleryItem } = require('./cms.models');
const {
    REGIONS, NATIONAL, isNational, slugify, findRegion, findState, statesOf, allStates,
} = require('./cms.regionMap');

/**
 * The Regions & States section of the public site.
 *
 * =========================================================================
 * EVERY FIELD IS MAPPED IN BOTH DIRECTIONS, ON PURPOSE
 * =========================================================================
 *
 * Mongoose strict mode discards a path the schema does not name, and returns
 * `success: true` while doing it. This repository has been caught by that on
 * the event category, the member fee, the CMS lede and the application's
 * rejection timestamp — four times, each one silent, each one found by a person
 * wondering why their edit "did not save".
 *
 * The defence is that every field appears in exactly three places and the three
 * are kept side by side in this file:
 *
 *     the schema          cms.models.js
 *     the write path      clean* below   — what the server will accept
 *     the read path       to* below      — what the client will ever see
 *
 * A field missing from the second is dropped on save. A field missing from the
 * third is saved and invisible, which is worse, because the data is there and
 * the screen says it is not. `tests/cms-regions.test.js` round-trips every one.
 *
 * ------------------------------------------------------------------- scope
 *
 * NOTHING HERE READS ANOTHER MODULE'S COLLECTIONS. No `Event`, no `Project`, no
 * `adminsdb` region tree. The association curates these lists by hand; see the
 * note at the head of `cms.regionMap.js` for why content geography is kept
 * apart from the staffing geography that decides where people can register.
 */

const str = (value) => String(value ?? '').trim();
const long = (value, max = 20000) => String(value ?? '').trim().slice(0, max);
const num = (value, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * `true` / `'true'` / `1`, because a multipart body is all strings.
 *
 * An absent value falls back rather than reading as false: a form that does not
 * render a control must not clear what another screen set.
 */
const bool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || value === 'true' || value === 1 || value === '1';
};

/**
 * An array, from an array or from the JSON string a multipart body sends.
 *
 * The CMS posts `multipart/form-data` whenever an image is attached, and every
 * field of a multipart body arrives as a string — an array of leaders included.
 * Parsing here rather than at each call site is what stops one of them from
 * forgetting.
 */
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

const EMPTY_MEDIA = { url: '', type: 'image', alt: '', fit: 'cover', position: 'center' };

const cleanMedia = (input = {}) => ({
    url: str(input.url),
    type: input.type === 'video' ? 'video' : 'image',
    alt: str(input.alt),
    fit: input.fit === 'contain' ? 'contain' : 'cover',
    position: str(input.position) || 'center',
});

/* ------------------------------------------------------------ sub-documents */

const cleanSlide = (input = {}) => ({
    media: cleanMedia(input.media || {}),
    caption: long(input.caption, 600),
    href: str(input.href),
    displayOrder: num(input.displayOrder),
    isHidden: bool(input.isHidden),
});

/**
 * A NAMED CONTACT ON A TIER. See the note on `contactPersonSchema`.
 *
 * Deliberately NOT `cleanLeader`: a leader carries `role` (the badge on the
 * portrait) and `bio` (the panel behind it), and a contact has neither — it
 * is never drawn as a portrait. Reusing the leader cleaner would quietly
 * accept and store both, and the next person reading the collection would
 * find contacts with roles and conclude they belong on the bench.
 */
const cleanContactPerson = (input = {}) => ({
    name: str(input.name),
    designation: str(input.designation),
    organisation: str(input.organisation),
    photoUrl: str(input.photoUrl),
    email: str(input.email),
    phone: str(input.phone),
    address: long(input.address, 400),
    displayOrder: num(input.displayOrder),
    isHidden: bool(input.isHidden),
});

/**
 * A GROUP OF CONTACTS — a heading and the people under it.
 *
 * Independent of the leadership tiers; see `contactGroupSchema`.
 */
const cleanContactGroup = (input = {}) => ({
    name: str(input.name),
    contacts: cleanList(input.contacts, cleanContactPerson, contactPersonIsEmpty),
    displayOrder: num(input.displayOrder),
    isHidden: bool(input.isHidden),
});

/* A group with no heading AND nobody in it is what "Add group" pressed by
   mistake leaves behind. A named group with nobody in it is kept — the
   editor is part way through. */
const contactGroupIsEmpty = (row) => !row.name && !row.contacts.length;

const cleanLeader = (input = {}) => ({
    name: str(input.name),
    role: str(input.role),
    designation: str(input.designation),
    organisation: str(input.organisation),
    photoUrl: str(input.photoUrl),
    bio: long(input.bio, 1200),
    /* This person's own contact — see the note on the schema. */
    email: str(input.email),
    phone: str(input.phone),
    address: long(input.address, 400),
    displayOrder: num(input.displayOrder),
    isHidden: bool(input.isHidden),
});

/**
 * ONE DISTRICT — the third tier of the state's leadership board.
 *
 * `slug` is derived here and never accepted from a client, the same rule
 * `regionKey` follows: a district whose stored slug disagrees with its name is
 * an anchor that scrolls to nothing.
 */
const cleanDistrict = (input = {}) => ({
    name: str(input.name),
    description: long(input.description, 400),
    /* Meaningful on a DISTRICT — which of the state's regions it sits in. A
       region row carries the field too, because both tiers share this cleaner,
       and it is simply never read there: a region is not inside a region. */
    regionName: str(input.regionName),
    leaders: cleanList(input.leaders, cleanLeader, leaderIsEmpty),
    contact: cleanOffice(input.contact),
    contacts: cleanList(input.contacts, cleanContactPerson, contactPersonIsEmpty),
    /* Clamped, not trusted. A negative or non-numeric count would reach the map
       as a label; `num` already answers 0 for anything unparseable. */
    activeMembers: Math.max(0, Math.round(num(input.activeMembers))),
    displayOrder: num(input.displayOrder),
    isHidden: bool(input.isHidden),
});

/**
 * ONE REGION OF A STATE — the same cleaner as a district, by design.
 *
 * A zone and a chapter are the same object at two scales; two cleaners would be
 * two places to add the next field and one place to forget it.
 */
const cleanStateRegion = (input = {}) => cleanDistrict(input);

const cleanFeedItem = (input = {}) => ({
    title: str(input.title),
    summary: long(input.summary, 1200),
    body: long(input.body),
    date: str(input.date),
    location: str(input.location),
    href: str(input.href),
    imageUrl: str(input.imageUrl),
    fileUrl: str(input.fileUrl),
    category: str(input.category),
    sector: str(input.sector),
    icon: str(input.icon),
    displayOrder: num(input.displayOrder),
    isFeatured: bool(input.isFeatured),
    isHidden: bool(input.isHidden),
});

/**
 * THE DASHBOARD'S OWN HEADINGS — see `dashboardLabels` on the schema.
 *
 * Eight short strings, all optional. `str` trims and coerces, so a field the
 * editor cleared comes back as '' and the client draws the shipped wording;
 * there is no sentinel and no way to store "use the default" other than blank,
 * which is the one an editor can actually reach from a text box.
 *
 * Capped at 120: these are headings and column heads. A paragraph typed into
 * one would break the layout it names rather than say anything.
 */
const LABEL_KEYS = [
    'ownTierEyebrow',
    'tierBelowEyebrow', 'tierBelowHeading',
    'districtsEyebrow', 'districtsHeading',
    'contactEyebrow', 'contactHeading',
];

const cleanLabels = (input = {}) => {
    const source = input || {};
    const out = {};
    LABEL_KEYS.forEach((key) => { out[key] = str(source[key]).slice(0, 120); });
    return out;
};

const toLabels = (doc = {}) => {
    const source = doc || {};
    const out = {};
    LABEL_KEYS.forEach((key) => { out[key] = str(source[key]); });
    return out;
};

const cleanOffice = (input = {}) => ({
    personName: str(input.personName),
    photoUrl: str(input.photoUrl),
    designation: str(input.designation),
    addressLines: asArray(input.addressLines).map(str).filter(Boolean).slice(0, 8),
    city: str(input.city),
    state: str(input.state),
    country: str(input.country) || 'India',
    pincode: str(input.pincode),
    email: str(input.email),
    phone: str(input.phone),
    mapUrl: str(input.mapUrl),
});

/** A short label with a glyph beside it. Used by the hero and the vision band. */
const cleanBadges = (value) => asArray(value)
    .map((row) => ({ icon: str(row && row.icon), label: str(row && row.label) }))
    .filter((row) => row.label)
    /* Four fits the band; a fifth wraps onto its own line and looks like a
       mistake. The cap is here rather than in the view so every client agrees. */
    .slice(0, 6);

/** Label-and-value chips: Capital / Chennai. */
const cleanFacts = (value) => asArray(value)
    .map((row) => ({
        icon: str(row && row.icon),
        label: str(row && row.label),
        value: str(row && row.value),
    }))
    .filter((row) => row.label || row.value)
    .slice(0, 6);

/** A bold claim and its quieter qualifier. */
const cleanGlance = (value) => asArray(value)
    .map((row) => ({
        icon: str(row && row.icon),
        title: str(row && row.title),
        subtitle: str(row && row.subtitle),
    }))
    .filter((row) => row.title || row.subtitle)
    .slice(0, 5);

const cleanCard = (input = {}) => ({
    imageUrl: str(input.imageUrl),
    title: str(input.title),
    subtitle: str(input.subtitle),
    href: str(input.href),
});

const cleanCards = (value) => asArray(value)
    .map(cleanCard)
    .filter((row) => row.title || row.imageUrl)
    .slice(0, 6);

const cleanSocials = (value) => asArray(value)
    .map((row) => ({ icon: str(row && row.icon), href: str(row && row.href) }))
    .filter((row) => row.href)
    .slice(0, 8);

const cleanHero = (input = {}) => ({
    eyebrow: str(input.eyebrow),
    headline: str(input.headline),
    tagline: str(input.tagline),
    blurb: long(input.blurb, 1200),
    backgroundUrl: str(input.backgroundUrl),
    sideImageUrl: str(input.sideImageUrl),
    features: cleanBadges(input.features),
    facts: cleanFacts(input.facts),
    glance: cleanGlance(input.glance),
});

const cleanVision = (input = {}) => ({
    title: str(input.title),
    text: long(input.text, 1200),
    pillars: cleanBadges(input.pillars),
});

const cleanSeo = (input = {}) => ({
    metaTitle: str(input.metaTitle).slice(0, 180),
    metaDescription: str(input.metaDescription).slice(0, 400),
    ogImageUrl: str(input.ogImageUrl),
});

/* ------------------------------------------------------- custom sections */

const CUSTOM_LAYOUTS = ['list', 'tiles', 'dated', 'figures', 'text'];

/**
 * A URL segment from whatever the editor typed.
 *
 * Lower case, hyphenated, no punctuation — because this ends up in a path, and
 * a section called "Trade & Delegations" must not produce a link the router
 * reads as two segments.
 */
const sectionKey = (value) => str(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const cleanCustomSection = (input = {}) => {
    const title = str(input.title);
    const layout = str(input.layout);
    return {
        key: sectionKey(input.key || title),
        title,
        icon: str(input.icon),
        layout: CUSTOM_LAYOUTS.includes(layout) ? layout : 'list',
        intro: long(input.intro, 600),
        text: long(input.text),
        items: cleanList(input.items, cleanFeedItem, feedIsEmpty),
        displayOrder: num(input.displayOrder, 0),
        isHidden: bool(input.isHidden, false),
    };
};

const sectionIsEmpty = (row) => !row.title && !row.text && !row.items.length;

/**
 * One key per section, always.
 *
 * Two sections called "Updates" would both answer at `/states/x/section-updates`
 * and the second would be unreachable — and the editor would have no way to
 * tell, because both cards would show a working "View All".
 */
const uniqueKeys = (rows = []) => {
    const seen = new Set();
    return rows.map((row, i) => {
        let key = row.key || `section-${i + 1}`;
        let n = 2;
        while (seen.has(key)) { key = `${row.key || 'section'}-${n}`; n += 1; }
        seen.add(key);
        return { ...row, key };
    });
};

const cleanSections = (value) => uniqueKeys(cleanList(value, cleanCustomSection, sectionIsEmpty));

const cleanLinks = (value) => asArray(value)
    .map((row) => ({ label: str(row && row.label), href: str(row && row.href) }))
    .filter((row) => row.label || row.href);

/** A list, cleaned, with anything wholly blank dropped. */
/**
 * Clean a list, drop the empty rows, and NUMBER THEM FROM THE ARRAY.
 *
 * `ordered()` sorts these on `displayOrder` when they are read back. The
 * CMS reorder buttons move rows within the array and set nothing, so
 * without this the sort undoes every reorder the moment the page reloads.
 *
 * It appeared to work here only because nothing had ever written a
 * `displayOrder`: every row tied on 0 and the sort fell through to its
 * index tiebreak. That is the array order by luck rather than by rule, and
 * one row with a real number in it is enough to break it.
 *
 * Numbered AFTER the empty rows are dropped, so the stored numbers have no
 * gaps — a gap is harmless to the sort and confusing to read in the
 * database.
 */
/**
 * =========================================================================
 * THE EDITOR’S ORDER FOR THE TIER BELOW — A HINT OVER A LIST, NOT THE LIST
 * =========================================================================
 *
 * `keys` is what the editor arranged, `rows` is what actually exists, and
 * `keyOf` says which field of a row the keys name. The two drift on their
 * own — a state page is created, renamed or deleted without the page above
 * hearing about it — so neither is allowed to decide membership:
 *
 *   - a key naming a row that is gone is IGNORED, not drawn as a gap;
 *   - a row the order has never heard of is KEPT, after the ones it has, in
 *     whatever order it arrived in (`statePanelsOf` sorts by name).
 *
 * Written the other way round — build the output from `keys` — a newly
 * created state would be invisible until somebody opened the zone above it
 * and pressed something. That is the failure this whole screen is about.
 */
const inChosenOrder = (rows, keys, keyOf) => {
    const wanted = (Array.isArray(keys) ? keys : [])
        .map((key) => String(key || '').trim().toLowerCase())
        .filter(Boolean);
    if (!wanted.length) return rows;

    const rank = new Map(wanted.map((key, index) => [key, index]));
    const at = (row) => {
        const found = rank.get(String(keyOf(row) || '').trim().toLowerCase());
        return found === undefined ? Number.MAX_SAFE_INTEGER : found;
    };
    /* A stable sort, so the rows the order does not name keep the order they
       came in — which is alphabetical, and is what they had before. */
    return rows
        .map((row, index) => ({ row, index, at: at(row) }))
        .sort((a, b) => (a.at - b.at) || (a.index - b.index))
        .map((entry) => entry.row);
};

const cleanStringList = (value) => asArray(value)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);

const cleanList = (value, cleaner, isEmpty) => asArray(value)
    .map(cleaner)
    .filter((row) => !isEmpty(row))
    .map((row, index) => (
        Object.prototype.hasOwnProperty.call(row, 'displayOrder')
            ? { ...row, displayOrder: index }
            : row
    ));

const slideIsEmpty = (row) => !row.media.url && !row.caption;
const leaderIsEmpty = (row) => !row.name && !row.designation && !row.photoUrl
    && !row.email && !row.phone;
/*
 * ANY ONE FIELD KEEPS THE ROW.
 *
 * Only a wholly blank contact is dropped — which is what "Add contact"
 * pressed by mistake leaves behind. A row with just a name is a person the
 * editor has started entering, and discarding it on save would lose their
 * work between one visit and the next.
 *
 * `organisation` is in the test because it was missing from it: a contact
 * entered as a firm and nothing else was silently thrown away.
 */
const contactPersonIsEmpty = (row) => !row.name && !row.email && !row.phone
    && !row.address && !row.designation && !row.organisation;
const feedIsEmpty = (row) => !row.title && !row.summary && !row.href && !row.imageUrl;
/* A district with a name and nothing else is legitimate — the editor has
   opened the row and will fill the bench in later. Only a wholly blank row,
   which is what "Add district" leaves behind when it is clicked by mistake,
   is dropped. */
const districtIsEmpty = (row) => !row.name && !row.description && !row.leaders.length
    && !row.contacts.length && !row.activeMembers
    && !row.contact.phone && !row.contact.email && !row.contact.personName;

/* ------------------------------------------------------------ the read path */

/**
 * Sorted by `displayOrder`, hidden rows removed for the public.
 *
 * A STABLE sort: `displayOrder` defaults to 0 on every row, so an editor who
 * has never reordered anything has a list of ties, and an unstable sort would
 * shuffle their page on every request. The index is the tiebreak.
 */
const ordered = (rows = [], { includeHidden = false } = {}) => (rows || [])
    .map((row, index) => ({ row, index }))
    .filter((entry) => includeHidden || !entry.row.isHidden)
    .sort((a, b) => (Number(a.row.displayOrder || 0) - Number(b.row.displayOrder || 0))
        || (a.index - b.index))
    .map((entry) => entry.row);

const toSlide = (doc = {}) => ({
    id: String(doc._id || ''),
    media: doc.media
        ? {
            url: doc.media.url || '',
            type: doc.media.type || 'image',
            alt: doc.media.alt || '',
            fit: doc.media.fit || 'cover',
            position: doc.media.position || 'center',
        }
        : { ...EMPTY_MEDIA },
    caption: doc.caption || '',
    href: doc.href || '',
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: !!doc.isHidden,
});

const toLeader = (doc = {}) => ({
    id: String(doc._id || ''),
    name: doc.name || '',
    role: doc.role || '',
    designation: doc.designation || '',
    organisation: doc.organisation || '',
    photoUrl: doc.photoUrl || '',
    bio: doc.bio || '',
    email: doc.email || '',
    phone: doc.phone || '',
    address: doc.address || '',
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: !!doc.isHidden,
});

/**
 * A named contact, on the way out.
 *
 * `id` is the Mongo subdocument id and is what the page keys its list on. A
 * contact has no slug — nothing links to one — so the id is the only stable
 * handle it has, and it is why this cannot just be the raw document.
 */
const toContactPerson = (doc = {}) => ({
    id: String(doc._id || ''),
    name: doc.name || '',
    designation: doc.designation || '',
    organisation: doc.organisation || '',
    photoUrl: doc.photoUrl || '',
    email: doc.email || '',
    phone: doc.phone || '',
    address: doc.address || '',
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: !!doc.isHidden,
});

const toContactGroup = (doc = {}, options = {}) => ({
    id: String(doc._id || ''),
    name: doc.name || '',
    contacts: ordered(doc.contacts, options).map(toContactPerson),
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: !!doc.isHidden,
});

const toStateRegion = (doc = {}, options = {}) => toDistrict(doc, options);

const toDistrict = (doc = {}, options = {}) => ({
    id: String(doc._id || ''),
    name: doc.name || '',
    description: doc.description || '',
    regionName: doc.regionName || '',
    slug: slugify(doc.name || ''),
    leaders: ordered(doc.leaders, options).map(toLeader),
    contact: toOffice(doc.contact),
    contacts: ordered(doc.contacts, options).map(toContactPerson),
    activeMembers: Number(doc.activeMembers || 0),
    displayOrder: Number(doc.displayOrder || 0),
    isHidden: !!doc.isHidden,
});

const toFeedItem = (doc = {}) => ({
    id: String(doc._id || ''),
    title: doc.title || '',
    summary: doc.summary || '',
    body: doc.body || '',
    date: doc.date || '',
    location: doc.location || '',
    href: doc.href || '',
    imageUrl: doc.imageUrl || '',
    fileUrl: doc.fileUrl || '',
    category: doc.category || '',
    sector: doc.sector || '',
    icon: doc.icon || '',
    displayOrder: Number(doc.displayOrder || 0),
    isFeatured: !!doc.isFeatured,
    isHidden: !!doc.isHidden,
});

const toOffice = (doc = {}) => ({
    personName: doc.personName || '',
    photoUrl: doc.photoUrl || '',
    designation: doc.designation || '',
    addressLines: Array.isArray(doc.addressLines) ? doc.addressLines.filter(Boolean) : [],
    city: doc.city || '',
    state: doc.state || '',
    country: doc.country || '',
    pincode: doc.pincode || '',
    email: doc.email || '',
    phone: doc.phone || '',
    mapUrl: doc.mapUrl || '',
});

const toBadges = (rows = []) => (rows || [])
    .map((row) => ({ icon: row.icon || '', label: row.label || '' }))
    .filter((row) => row.label);

const toFacts = (rows = []) => (rows || [])
    .map((row) => ({ icon: row.icon || '', label: row.label || '', value: row.value || '' }))
    .filter((row) => row.label || row.value);

const toGlance = (rows = []) => (rows || [])
    .map((row) => ({ icon: row.icon || '', title: row.title || '', subtitle: row.subtitle || '' }))
    .filter((row) => row.title || row.subtitle);

const toCard = (doc = {}) => ({
    imageUrl: doc.imageUrl || '',
    title: doc.title || '',
    subtitle: doc.subtitle || '',
    href: doc.href || '',
});

const toCards = (rows = []) => (rows || [])
    .map(toCard)
    .filter((row) => row.title || row.imageUrl);

const toSocials = (rows = []) => (rows || [])
    .map((row) => ({ icon: row.icon || '', href: row.href || '' }))
    .filter((row) => row.href);

const toHero = (doc = {}) => ({
    eyebrow: doc.eyebrow || '',
    headline: doc.headline || '',
    tagline: doc.tagline || '',
    blurb: doc.blurb || '',
    backgroundUrl: doc.backgroundUrl || '',
    sideImageUrl: doc.sideImageUrl || '',
    features: toBadges(doc.features),
    facts: toFacts(doc.facts),
    glance: toGlance(doc.glance),
});

const toVision = (doc = {}) => ({
    title: doc.title || '',
    text: doc.text || '',
    pillars: toBadges(doc.pillars),
});

const toSeo = (doc = {}) => ({
    metaTitle: doc.metaTitle || '',
    metaDescription: doc.metaDescription || '',
    ogImageUrl: doc.ogImageUrl || '',
});

const toLinks = (rows = []) => (rows || [])
    .map((row) => ({ label: row.label || '', href: row.href || '' }))
    .filter((row) => row.label || row.href);

const feeds = (doc, names, options) => {
    const out = {};
    for (const name of names) {
        out[name] = ordered(doc[name], options).map(toFeedItem);
    }
    return out;
};

/**
 * The region's lists.
 *
 * The first six are the state's lists as well — a region runs events, projects,
 * consulting and advocacy across its states — and the last four are the
 * region's own. Adding a name here is not enough on its own: the schema must
 * carry it and `toFeedItem` must map it, or it is dropped without a word.
 */
const toCustomSection = (doc = {}, options = {}) => ({
    key: doc.key || '',
    title: doc.title || '',
    icon: doc.icon || '',
    layout: doc.layout || 'list',
    intro: doc.intro || '',
    text: doc.text || '',
    items: ordered(doc.items, options).map(toFeedItem),
    displayOrder: Number(doc.displayOrder || 0),
});

const REGION_FEEDS = [
    'achievements', 'keyAchievements',
    'events', 'projects', 'policyAdvocacy', 'consultingServices',
    'publications', 'mediaCoverages',
    'sectorUpdates', 'newsUpdates', 'mediaReleases', 'speakInMedia',
];
const STATE_FEEDS = [
    'achievements', 'keyAchievements',
    'events', 'projects', 'policyAdvocacy', 'consultingServices',
    'publications', 'mediaReleases', 'mediaCoverages',
];

const toRegionPage = (doc, options = {}) => {
    if (!doc) return null;
    const region = findRegion(doc.regionKey);
    return {
        id: String(doc._id || ''),
        regionKey: doc.regionKey || '',
        regionName: doc.regionName || (region ? region.label : ''),
        /* The dashboard's own headings. Blank means the shipped wording — the
           client holds the same defaults, so an unseeded page is unchanged. */
        labels: toLabels(doc.labels),
        slug: doc.regionKey || '',
        shortDescription: doc.shortDescription || '',
        fullDescription: doc.fullDescription || '',
        hero: toHero(doc.hero),
        vision: toVision(doc.vision),
        heroCarousel: ordered(doc.heroCarousel, options).map(toSlide),
        leaders: ordered(doc.leaders, options).map(toLeader),
        ...feeds(doc, REGION_FEEDS, options),
        customSections: ordered(doc.customSections, options)
            .map((row) => toCustomSection(row, options)),
        /* This page's own tier below — the states of a region, the regions
           of the country. Stored here, never read off another page. */
        stateRegions: ordered(doc.stateRegions, options)
            .map((row) => toDistrict(row, options)),
        /* Which order to read the tier below in — see the field's note on the
           schema. Served so the CMS can show and rearrange it; the panels
           themselves come back already sorted by it. */
        tierOrder: (doc.tierOrder || []).map((key) => String(key || '')).filter(Boolean),
        relatedLinks: toLinks(doc.relatedLinks),
        contact: toOffice(doc.contact),
        contacts: ordered(doc.contacts, options).map(toContactPerson),
        regionContactGroups: ordered(doc.regionContactGroups, options).map((g) => toContactGroup(g, options)),
        districtContactGroups: ordered(doc.districtContactGroups, options).map((g) => toContactGroup(g, options)),
        explore: toCard(doc.explore),
        promoCards: toCards(doc.promoCards),
        socialLinks: toSocials(doc.socialLinks),
        consultingIntro: doc.consultingIntro || '',
        consultingCta: {
            label: (doc.consultingCta && doc.consultingCta.label) || '',
            href: (doc.consultingCta && doc.consultingCta.href) || '',
        },
        feedbackEnabled: doc.feedbackEnabled !== false,
        seo: toSeo(doc.seo),
        status: doc.status || 'draft',
        updatedAt: doc.updatedAt || null,
        updatedBy: (doc.updatedBy && doc.updatedBy.email) || '',
    };
};

const toStatePage = (doc, options = {}) => {
    if (!doc) return null;
    const region = findRegion(doc.regionKey);
    return {
        id: String(doc._id || ''),
        stateName: doc.stateName || '',
        labels: toLabels(doc.labels),
        slug: doc.slug || '',
        regionKey: doc.regionKey || '',
        regionName: region ? region.label : '',
        shortDescription: doc.shortDescription || '',
        fullDescription: doc.fullDescription || '',
        hero: toHero(doc.hero),
        vision: toVision(doc.vision),
        heroCarousel: ordered(doc.heroCarousel, options).map(toSlide),
        leaders: ordered(doc.leaders, options).map(toLeader),
        /* The state's OWN regions — not the national one it belongs to. */
        stateRegions: ordered(doc.stateRegions, options)
            .map((row) => toStateRegion(row, options)),
        districts: ordered(doc.districts, options)
            .map((row) => toDistrict(row, options)),
        ...feeds(doc, STATE_FEEDS, options),
        customSections: ordered(doc.customSections, options)
            .map((row) => toCustomSection(row, options)),
        relatedLinks: toLinks(doc.relatedLinks),
        contact: toOffice(doc.contact),
        contacts: ordered(doc.contacts, options).map(toContactPerson),
        regionContactGroups: ordered(doc.regionContactGroups, options).map((g) => toContactGroup(g, options)),
        districtContactGroups: ordered(doc.districtContactGroups, options).map((g) => toContactGroup(g, options)),
        explore: toCard(doc.explore),
        promoCards: toCards(doc.promoCards),
        socialLinks: toSocials(doc.socialLinks),
        consultingIntro: doc.consultingIntro || '',
        consultingCta: {
            label: (doc.consultingCta && doc.consultingCta.label) || '',
            href: (doc.consultingCta && doc.consultingCta.href) || '',
        },
        feedbackEnabled: doc.feedbackEnabled !== false,
        seo: toSeo(doc.seo),
        status: doc.status || 'draft',
        updatedAt: doc.updatedAt || null,
        updatedBy: (doc.updatedBy && doc.updatedBy.email) || '',
    };
};

/* ----------------------------------------------------------- the write path */

/**
 * Only the keys the payload actually carries are written.
 *
 * An absent key means UNTOUCHED, never "set to empty". The CMS edits one
 * section of a page at a time, and a save from the Leadership panel must not
 * blank the Sector Updates the other panel owns — the same rule the event write
 * path follows for `showOnOnboarding`.
 */
const pick = (payload, key, cleaner) => {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return {};
    return { [key]: cleaner(payload[key]) };
};

const commonUpdates = (payload = {}) => ({
    /* Shared by both page types, because both draw the same dashboard. */
    ...pick(payload, 'labels', cleanLabels),
    ...pick(payload, 'hero', cleanHero),
    ...pick(payload, 'vision', cleanVision),
    ...pick(payload, 'shortDescription', (v) => long(v, 2000)),
    ...pick(payload, 'fullDescription', (v) => long(v)),
    ...pick(payload, 'heroCarousel', (v) => cleanList(v, cleanSlide, slideIsEmpty)),
    ...pick(payload, 'leaders', (v) => cleanList(v, cleanLeader, leaderIsEmpty)),
    ...pick(payload, 'relatedLinks', cleanLinks),
    ...pick(payload, 'customSections', cleanSections),
    ...pick(payload, 'contact', cleanOffice),
    ...pick(payload, 'contacts', (v) => cleanList(v, cleanContactPerson, contactPersonIsEmpty)),
    ...pick(payload, 'regionContactGroups', (v) => cleanList(v, cleanContactGroup, contactGroupIsEmpty)),
    ...pick(payload, 'districtContactGroups', (v) => cleanList(v, cleanContactGroup, contactGroupIsEmpty)),
    ...pick(payload, 'seo', cleanSeo),
    ...pick(payload, 'status', (v) => (str(v) === 'published' ? 'published' : 'draft')),
});

const feedUpdates = (payload, names) => {
    let out = {};
    for (const name of names) {
        out = { ...out, ...pick(payload, name, (v) => cleanList(v, cleanFeedItem, feedIsEmpty)) };
    }
    return out;
};

const actorOf = (user = {}) => ({ email: user.email || '', at: new Date() });

/* ------------------------------------------------------------------ service */

module.exports = {
    REGION_FEEDS,
    STATE_FEEDS,
    toRegionPage,
    toStatePage,

    /**
     * The menu, and everything that needs to know what exists.
     *
     * Each region and each state is annotated with `hasPage`, so the nav can
     * link only to pages that will actually answer. A link to a 404 is worse
     * than an absent link: the visitor concludes the site is broken rather than
     * that the page has not been written yet.
     */
    async getMap({ includeDrafts = false } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };

        const [regionPages, statePages] = await Promise.all([
            RegionPage.find(filter).select('regionKey regionName status').lean().catch(() => []),
            StatePage.find(filter).select('stateName slug regionKey status').lean().catch(() => []),
        ]);

        const regionHas = new Map((regionPages || []).map((row) => [row.regionKey, row]));
        const stateHas = new Map((statePages || []).map((row) => [row.slug, row]));

        /*
         * THE COUNTRY IS IN THIS LIST, and it is marked as what it is.
         *
         * The header menu and the CMS both read this, and both need the
         * national page in the same list as the five regions — it sits above
         * them (`order: 0`) and is reached the same way. What neither may do
         * is treat it as a sixth region: `national: true` is how a caller
         * tells them apart without matching on the key, and `states` is empty
         * because no state page hangs under the country. Each hangs under its
         * own region, and listing all thirty-six here would put every state
         * in the menu twice.
         */
        const entry = (region) => {
            const page = regionHas.get(region.key);
            return {
                key: region.key,
                slug: region.key,
                label: (page && page.regionName) || region.label,
                order: region.order,
                national: region.national === true,
                hasPage: !!page,
                status: (page && page.status) || '',
                states: statesOf(region.key).map((state) => {
                    const statePage = stateHas.get(state.slug);
                    return {
                        name: state.name,
                        slug: state.slug,
                        hasPage: !!statePage,
                        status: (statePage && statePage.status) || '',
                    };
                }),
            };
        };

        return {
            regions: [NATIONAL, ...REGIONS]
                .map(entry)
                .sort((a, b) => a.order - b.order),
        };
    },

    /** Every state in the country, for the CMS picker. Content, not staffing. */
    listAllStates() {
        return allStates();
    },

    /**
     * ======================================================================
     * A DATABASE THAT IS DOWN IS NOT A PAGE THAT IS UNPUBLISHED
     * ======================================================================
     *
     * Both public reads were written `findOne(...).catch(() => null)`, and
     * then `if (!doc) throw notFound("not published yet")`. A missing
     * document and a failed query became the same answer.
     *
     * They are not the same answer, and the difference showed the moment the
     * connection dropped: Mongoose buffers an operation on a disconnected
     * client and rejects it after ten seconds, the catch turned that into
     * `null`, and EVERY STATE PAGE ON THE SITE reported "not published yet"
     * — 404, after ten seconds, with all thirty-six rows sitting in the
     * collection marked published. Somebody reading that goes looking for
     * what unpublished them.
     *
     * `readOne` keeps the null for what it was for — a page that genuinely is
     * not there — and lets a real failure through as a failure. A 500 naming
     * a database problem is a bad minute; a 404 naming the wrong cause is a
     * bad afternoon.
     */
    async readOne(query, what) {
        try {
            return await query.lean();
        } catch (err) {
            throw ApiError.internal(`${what} could not be read: ${err.message}`);
        }
    },

    async getRegionPage(slug, { includeDrafts = false } = {}) {
        const region = findRegion(slug);
        if (!region) throw ApiError.notFound('No such region');

        const doc = await this.readOne(
            RegionPage.findOne({ regionKey: region.key }), 'This region page',
        );
        if (!doc || (!includeDrafts && doc.status !== 'published')) {
            throw ApiError.notFound('This region page is not published yet');
        }

        /*
         * THE NATIONAL PAGE IS THE SAME PAGE, ONE LEVEL UP.
         *
         * `statePanels` is whatever the tier below is: the states of a region,
         * and the five REGIONS of the country. The name is the field the
         * public page has always read and a released build cannot be asked to
         * look elsewhere; what it holds is "the tier under this one".
         *
         * `mapPanels` is separate because the two answer different questions.
         * On a region page they are the same list — the map draws the states
         * and the boards are those states. On the national page the boards are
         * the regions and the map is still drawn state by state, because that
         * is what a map of India is; a reader picks a STATE off it and lands on
         * that state’s page.
         */
        const national = isNational(region.key);

        /* Together, not one after the other — see the note on `getStatePage`.
           Three sequential round trips is three times the latency for three
           answers none of which depends on another. */
        const [focusStates, rawPanels, mapPanels] = await Promise.all([
            national ? [] : this.focusStatesOf(region.key, { includeDrafts }),
            national
                ? this.regionPanelsOf({ includeDrafts })
                : this.statePanelsOf(region.key, { includeDrafts }),
            national
                ? this.statePanelsOf(region.key, { includeDrafts, all: true })
                : undefined,
        ]);

        /*
         * THE ORDER AN EDITOR CHOSE, APPLIED HERE AND NOWHERE ELSE.
         *
         * `statePanelsOf` and `regionPanelsOf` answer "which pages are there",
         * which is a question about the pages. "In what order" is a question
         * about THIS page, and its answer is on this document — so it is
         * applied at the one point that holds both.
         *
         * By `slug`, which is stable: `stateName` is editable, and an order
         * stored against a name silently un-orders itself the day somebody
         * corrects a spelling.
         */
        const statePanels = inChosenOrder(rawPanels, doc.tierOrder, (row) => row.slug);

        return {
            ...toRegionPage(doc, { includeHidden: includeDrafts }),
            /* The Focus States rail. From the MAP, not from the page — a region
               contains its states whether or not anybody has written them a
               page, and saying so is more useful than an empty rail. */
            focusStates,
            /* The tier below this one — see `statePanelsOf` / `regionPanelsOf`. */
            statePanels,
            mapPanels,
        };
    },

    /**
     * THE STATE TIER OF A REGION PAGE.
     *
     * =========================================================================
     * THE SAME BOARD, ONE LEVEL UP
     * =========================================================================
     *
     * A state page shows state, region and district. A region page shows the
     * two tiers it actually has: itself, and the states beneath it — so a
     * reader arriving at the South Region meets the same board, reading down
     * the same way, rather than a different page that happens to share a
     * header.
     *
     * Read from the state pages, never copied onto the region, for the reason
     * `regionPanelOf` gives in the other direction: a chairman is one person
     * and a second copy of them goes stale silently.
     *
     * A state whose bench is empty is left out rather than drawn as a heading
     * over nothing — the rule every card on these pages follows.
     */
    async statePanelsOf(regionKey, { includeDrafts = false, all = false } = {}) {
        const region = findRegion(regionKey);
        if (!region) return [];

        const filter = includeDrafts ? {} : { status: 'published' };
        /*
         * `all` is the national page: EVERY state, not the ones filed under
         * this key. No state page carries `regionKey: national` — each is
         * filed under its own region — so the ordinary query answers nothing
         * and the map of India would be drawn with no council on it at all.
         */
        const scope = all ? filter : { ...filter, regionKey: region.key };

        const pages = await StatePage
            .find(scope)
            /*
             * `contacts` and `activeMembers` ARE SELECTED, and were not.
             *
             * The region page prints a contact group per state and the map
             * puts each state’s member count on its marker — both read fields
             * this projection did not ask Mongo for, so both were silently
             * empty on every region page in the site. A `select` that omits a
             * field a caller reads is the same class of bug as a schema that
             * drops one: the data is there and the screen says it is not.
             */
            .select('stateName slug shortDescription leaders contact contacts activeMembers status')
            .sort({ stateName: 1 })
            .lean()
            .catch(() => []);

        return (pages || [])
            .map((doc) => ({
                name: doc.stateName || '',
                slug: doc.slug || '',
                blurb: doc.shortDescription || '',
                leaders: ordered(doc.leaders, { includeHidden: includeDrafts }).map(toLeader),
                contact: toOffice(doc.contact),
                contacts: ordered(doc.contacts, { includeHidden: includeDrafts })
                    .map(toContactPerson),
                activeMembers: Number(doc.activeMembers || 0),
            }))
            /*
             * A bench OR a contact is enough to be drawn. It was a bench
             * alone, which left a state that publishes a telephone number and
             * no portraits off its region page entirely.
             */
            .filter((row) => row.name && (row.leaders.length || row.contacts.length));
    },

    /**
     * ======================================================================
     * THE FIVE REGIONS, AS THE TIER BELOW THE NATIONAL PAGE
     * ======================================================================
     *
     * A state page draws its regions and districts; a region page draws its
     * states; the national page draws the regions. Same shape at every
     * level, and the same rule about where the people come from: read off
     * each region’s OWN page, never copied onto the national one, because a
     * regional chairman is one person and a second copy of them goes stale
     * silently.
     *
     * `slug` is the region key, so the panel’s heading links to the region
     * page — which is the journey the menu describes: India, then a region,
     * then a state.
     */
    async regionPanelsOf({ includeDrafts = false } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };
        const pages = await RegionPage
            .find(filter)
            .select('regionKey regionName shortDescription leaders contact contacts status')
            .lean()
            .catch(() => []);

        const byKey = new Map((pages || []).map((row) => [row.regionKey, row]));

        return REGIONS.map((region) => {
            const doc = byKey.get(region.key);
            if (!doc) return null;
            return {
                name: doc.regionName || region.label,
                slug: region.key,
                blurb: doc.shortDescription || '',
                leaders: ordered(doc.leaders, { includeHidden: includeDrafts }).map(toLeader),
                contact: toOffice(doc.contact),
                contacts: ordered(doc.contacts, { includeHidden: includeDrafts })
                    .map(toContactPerson),
                activeMembers: 0,
            };
        })
            .filter((row) => row && (row.leaders.length || row.contacts.length));
    },

    async focusStatesOf(regionKey, { includeDrafts = false } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };
        const pages = await StatePage
            .find({ ...filter, regionKey })
            .select('slug status')
            .lean()
            .catch(() => []);
        const has = new Map((pages || []).map((row) => [row.slug, row.status]));

        return statesOf(regionKey).map((state) => ({
            name: state.name,
            slug: state.slug,
            hasPage: has.has(state.slug),
        }));
    },

    async getStatePage(slug, { includeDrafts = false } = {}) {
        const state = findState(slug);
        if (!state) throw ApiError.notFound('No such state');

        const doc = await this.readOne(
            StatePage.findOne({ slug: state.slug }), 'This state page',
        );
        if (!doc || (!includeDrafts && doc.status !== 'published')) {
            throw ApiError.notFound('This state page is not published yet');
        }

        const region = findRegion(state.regionKey);

        /*
         * ======================================================================
         * THE TWO SIDE QUERIES GO TOGETHER, NOT ONE AFTER THE OTHER
         * ======================================================================
         *
         * They were `await`ed inside the returned object literal, which runs
         * them in sequence: the region panel, then the sibling states, each
         * waiting for the last. Neither reads the other’s answer.
         *
         * On a local database that costs a millisecond and nobody notices. On
         * a remote Atlas cluster every round trip is 80-400ms, and this page
         * makes four of them — it measured 1.4 SECONDS for 66KB, which is not
         * a lot of data travelling slowly, it is a little data travelling four
         * times in a row.
         *
         * `Promise.all` is the whole fix. The reads are independent by
         * construction: one is the region’s bench and the other is which
         * states have pages.
         */
        const [regionPanel, siblingStates] = await Promise.all([
            this.regionPanelOf(state.regionKey, {
                includeDrafts,
                /* The page you are standing on prints its own office in full
                   in the column to the left; repeating it as a row in the
                   column beside that is the same number twice. */
                exceptSlug: state.slug,
            }),
            this.focusStatesOf(state.regionKey, { includeDrafts }),
        ]);

        return {
            ...toStatePage(doc, { includeHidden: includeDrafts }),
            /* For the breadcrumb and the "back to the region" link. */
            region: region
                ? { key: region.key, slug: region.key, label: region.label }
                : null,
            /* The middle tier of the leadership board — see `regionPanelOf`. */
            regionPanel,
            siblingStates,
        };
    },

    /**
     * THE REGION TIER OF A STATE PAGE, read from the region's own page.
     *
     * =========================================================================
     * THE REGION'S BENCH IS NOT COPIED ONTO THE STATE
     * =========================================================================
     *
     * The board on a state page shows three tiers — State, Region, District —
     * and the middle one is the SAME people the region's own page shows. A
     * `regionLeaders` array on the state document would be a second copy of
     * that bench: an editor who replaces a regional chairman would change it in
     * one place and leave it wrong on however many state pages are beneath it,
     * with nothing on either screen to say the two disagreed. It is read from
     * the region page, every time, so there is one answer.
     *
     * `contacts` is the region's OTHER states, each with whatever telephone
     * number and email the state page carries — the "Region Contacts" column,
     * which is a list of the places inside the region a reader can ring. A
     * state with neither a number nor an email is left out rather than printed
     * as a name with nothing beside it, and so is the state doing the asking:
     * its own office is the column to the left of that one, in full.
     *
     * Draft pages are excluded on the public path exactly as everywhere else:
     * a region whose page is unpublished contributes an empty panel, and the
     * board simply does not draw that tier.
     */
    async regionPanelOf(regionKey, { includeDrafts = false, exceptSlug = '' } = {}) {
        const region = findRegion(regionKey);
        if (!region) return null;

        const filter = includeDrafts ? {} : { status: 'published' };

        const [regionDoc, statePages] = await Promise.all([
            RegionPage.findOne({ regionKey: region.key })
                .select('regionName shortDescription leaders contact status')
                .lean()
                .catch(() => null),
            StatePage.find({ ...filter, regionKey: region.key })
                .select('stateName slug contact status')
                .lean()
                .catch(() => []),
        ]);

        const published = regionDoc && (includeDrafts || regionDoc.status === 'published');

        return {
            key: region.key,
            slug: region.key,
            label: (published && regionDoc.regionName) || region.label,
            /* The line under the heading, same as a district's — read from the
               region's own page so there is one description, not two. */
            blurb: (published && regionDoc.shortDescription) || '',
            leaders: published
                ? ordered(regionDoc.leaders, { includeHidden: includeDrafts }).map(toLeader)
                : [],
            contact: published ? toOffice(regionDoc.contact) : toOffice({}),
            contacts: (statePages || [])
                .map((row) => {
                    const office = toOffice(row.contact);
                    return {
                        label: row.stateName || '',
                        href: row.slug ? `/states/${row.slug}` : '',
                        phone: office.phone,
                        email: office.email,
                    };
                })
                .filter((row) => row.label && (row.phone || row.email))
                .filter((row) => !exceptSlug || row.href !== `/states/${exceptSlug}`)
                .sort((a, b) => a.label.localeCompare(b.label)),
        };
    },

    /**
     * One feed, paginated — what "Read All" opens.
     *
     * Paged in the database's copy rather than by the browser, because a
     * region that has been running for ten years has hundreds of releases and
     * the landing page must not fetch them to show eight.
     */
    async getFeed({ scope, slug, type, offset = 0, limit = 20, includeDrafts = false }) {
        const names = scope === 'region' ? REGION_FEEDS : STATE_FEEDS;
        if (!names.includes(type)) throw ApiError.badRequest('No such list');

        const page = scope === 'region'
            ? await this.getRegionPage(slug, { includeDrafts })
            : await this.getStatePage(slug, { includeDrafts });

        const all = page[type] || [];
        const start = Math.max(0, Number(offset) || 0);
        const size = Math.min(100, Math.max(1, Number(limit) || 20));

        return {
            title: scope === 'region' ? page.regionName : page.stateName,
            slug: scope === 'region' ? page.slug : page.slug,
            type,
            items: all.slice(start, start + size),
            total: all.length,
            offset: start,
            limit: size,
        };
    },

    /* ----------------------------------------------------------- admin CRUD */

    /**
     * Create-or-update, keyed on the region.
     *
     * `upsert` rather than a separate create: there are exactly five regions and
     * they are known in advance, so "does a page exist yet" is not a question
     * the editor should have to answer.
     */
    async saveRegionPage(slug, payload = {}, user = {}) {
        const region = findRegion(slug);
        if (!region) throw ApiError.badRequest('No such region');

        const updates = {
            ...commonUpdates(payload),
            ...feedUpdates(payload, REGION_FEEDS),
            /* The rail's picture card. The state page has always had one; this
               is the same field on the region, so the two rails match. */
            ...pick(payload, 'explore', cleanCard),
            ...pick(payload, 'regionName', str),
            /* The tier this page owns. Never written from another page. */
            ...pick(payload, 'stateRegions', (v) => cleanList(v, cleanStateRegion, districtIsEmpty)),
            /* WHICH ORDER the tier below is read in — slugs on a zone page,
               region keys on the national one. Names, never rows: this page
               does not own the pages underneath it and must not write them. */
            ...pick(payload, 'tierOrder', cleanStringList),
            ...pick(payload, 'feedbackEnabled', (v) => bool(v, true)),
            ...pick(payload, 'consultingIntro', (v) => long(v, 600)),
            ...pick(payload, 'promoCards', cleanCards),
            ...pick(payload, 'socialLinks', cleanSocials),
            ...pick(payload, 'consultingCta', (v) => ({
                label: str(v && v.label), href: str(v && v.href),
            })),
            updatedBy: actorOf(user),
        };

        /*
         * `$setOnInsert` MUST NOT NAME A PATH `$set` ALREADY NAMES.
         *
         * Mongo refuses the whole update with "would create a conflict at
         * 'regionName'" — and it is easy to write, because `regionName` is in
         * `$set` only when the payload carried it. `onInsert` therefore fills
         * in what `$set` has not.
         */
        const onInsert = { regionKey: region.key };
        if (updates.regionName === undefined) onInsert.regionName = region.label;

        const doc = await RegionPage.findOneAndUpdate(
            { regionKey: region.key },
            { $set: updates, $setOnInsert: onInsert },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        return toRegionPage(doc, { includeHidden: true });
    },

    /**
     * Create-or-update, keyed on the state's slug.
     *
     * `regionKey` is DERIVED from the map and never taken from the payload: a
     * page whose state and region disagree appears in one menu and claims
     * another in its breadcrumb, and nothing on screen says which is right.
     */
    async saveStatePage(slug, payload = {}, user = {}) {
        const state = findState(slug);
        if (!state) {
            throw ApiError.badRequest(
                'No such state. Names must match the region map exactly.',
            );
        }

        const updates = {
            ...commonUpdates(payload),
            ...feedUpdates(payload, STATE_FEEDS),
            ...pick(payload, 'feedbackEnabled', (v) => bool(v, true)),
            ...pick(payload, 'consultingIntro', (v) => long(v, 600)),
            ...pick(payload, 'explore', cleanCard),
            /* The second and third tiers of the leadership board. A state page
               owns both; a region page has neither. */
            ...pick(payload, 'stateRegions', (v) => cleanList(v, cleanStateRegion, districtIsEmpty)),
            ...pick(payload, 'districts', (v) => cleanList(v, cleanDistrict, districtIsEmpty)),
            ...pick(payload, 'promoCards', cleanCards),
            ...pick(payload, 'socialLinks', cleanSocials),
            ...pick(payload, 'consultingCta', (v) => ({
                label: str(v && v.label), href: str(v && v.href),
            })),
            /* Derived, every time, so a renamed map entry heals on the next save. */
            stateName: state.name,
            regionKey: state.regionKey,
            updatedBy: actorOf(user),
        };

        /* `slug` only — `stateName` and `regionKey` are always in `$set`, and
           naming a path in both is the conflict documented above. */
        const doc = await StatePage.findOneAndUpdate(
            { slug: state.slug },
            { $set: updates, $setOnInsert: { slug: state.slug } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        ).lean();

        return toStatePage(doc, { includeHidden: true });
    },

    /**
     * ======================================================================
     * A LIST SCREEN GETS A LIST, NOT FORTY WHOLE PAGES
     * ======================================================================
     *
     * This returned every field of every region and state page so that the
     * editor could be handed its document without a second call. With six
     * region pages and thirty-six state pages — each carrying a bench, its
     * districts, its contacts, a carousel and ten feed lists — that is 1.4MB
     * off a remote Atlas cluster to draw forty rows of name and status.
     *
     * Measured: 31 SECONDS for the state pages alone, 78 for the whole call,
     * against 462ms for the same thirty-six rows projected to what the list
     * actually prints. The CMS gave up before the server did and showed
     * "The server took too long to respond", which reads as an outage.
     *
     * So the list is a list. The editor fetches the ONE page it is about to
     * edit — see `getRegionPageAdmin` / `getStatePageAdmin` — which is one
     * document instead of forty-two and is the only one anybody is looking
     * at.
     */
    async listForAdmin() {
        const LIST_FIELDS = {
            region: 'regionKey regionName status updatedAt',
            state: 'stateName slug regionKey status updatedAt',
        };

        const [regions, states] = await Promise.all([
            RegionPage.find({}).select(LIST_FIELDS.region).lean().catch(() => []),
            StatePage.find({}).select(LIST_FIELDS.state).sort({ stateName: 1 })
                .lean()
                .catch(() => []),
        ]);

        const byKey = new Map((regions || []).map((row) => [row.regionKey, row]));

        return {
            /*
             * India first, then the five regions.
             *
             * The national page is a region page under a reserved key, so it
             * is editable by the screen that already exists and needs no
             * second editor. `stateCount: 0` is correct and not a gap: no
             * state page hangs under the country — each hangs under its own
             * region — and the CMS row says "the whole country" rather than
             * "0 states", which would read as a region nobody has filled in.
             */
            regions: [NATIONAL, ...REGIONS].map((region) => {
                const doc = byKey.get(region.key);
                return {
                    key: region.key,
                    label: region.label,
                    national: region.national === true,
                    stateCount: region.states.length,
                    /*
                     * A SUMMARY, and shaped so the list screen’s existing
                     * `row.page?.status` keeps working. `null` still means
                     * "no page has been created", which is what the row
                     * renders as "Not created yet".
                     */
                    page: doc ? {
                        regionKey: doc.regionKey || region.key,
                        regionName: doc.regionName || region.label,
                        status: doc.status || 'draft',
                        updatedAt: doc.updatedAt || null,
                    } : null,
                };
            }),
            states: (states || []).map((doc) => ({
                stateName: doc.stateName || '',
                slug: doc.slug || '',
                regionKey: doc.regionKey || '',
                status: doc.status || 'draft',
                updatedAt: doc.updatedAt || null,
            })),
            /* So the picker can offer a state that has no page yet. */
            allStates: allStates(),
        };
    },

    /**
     * ONE region or national page, drafts included, for the editor.
     *
     * `getRegionPage` cannot serve this: it refuses a draft to the public,
     * and it attaches the tiers below — the state panels and the focus
     * states — which the editor neither shows nor saves, and which are
     * another forty documents to fetch.
     */
    async getRegionPageAdmin(slug) {
        const region = findRegion(slug);
        if (!region) throw ApiError.notFound('No such region');

        const doc = await RegionPage.findOne({ regionKey: region.key }).lean().catch(() => null);
        /* Not an error. A region with no page yet is the ordinary state of
           one nobody has written, and the editor opens empty on it. */
        return doc ? toRegionPage(doc, { includeHidden: true }) : null;
    },

    /** One state page, drafts included, for the editor. */
    async getStatePageAdmin(slug) {
        const state = findState(slug);
        if (!state) throw ApiError.notFound('No such state');

        const doc = await StatePage.findOne({ slug: state.slug }).lean().catch(() => null);
        return doc ? toStatePage(doc, { includeHidden: true }) : null;
    },

    /**
     * Deletes a page. The region itself is never deleted — it is in the map.
     *
     * Unpublishing is almost always what an editor means, and it is reversible;
     * this exists for a page created against the wrong state.
     */
    async deleteStatePage(slug) {
        const state = findState(slug);
        if (!state) throw ApiError.badRequest('No such state');
        await StatePage.deleteOne({ slug: state.slug });
        return { deleted: true, slug: state.slug };
    },

    /* --------------------------------------------------------------- gallery */

    /**
     * The gallery, filtered and paged in the database.
     *
     * `state` and `region` come from the page a visitor followed the link from;
     * `category`, `sector` and `q` come from the controls. Every one of them is
     * optional, and an absent filter is not a filter — never a `$ne` or a regex
     * that quietly matches rows nobody meant to include.
     */
    async listGallery({
        state = '', region = '', category = '', sector = '', q = '',
        offset = 0, limit = 24,
    } = {}) {
        const filter = { visible: true };

        const stateEntry = findState(state);
        if (state && stateEntry) filter.state = stateEntry.name;

        const regionEntry = findRegion(region);
        if (region && regionEntry) filter.region = regionEntry.key;

        if (str(category)) filter.category = str(category);
        if (str(sector)) filter.sector = str(sector);

        if (str(q)) {
            /* Escaped: a title search is free text a visitor typed, and `(` or
               `*` in it must be a character to look for, not a regex operator
               that throws or matches everything. */
            const needle = str(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = new RegExp(needle, 'i');
            filter.$or = [{ title: rx }, { caption: rx }, { description: rx }];
        }

        const start = Math.max(0, Number(offset) || 0);
        const size = Math.min(60, Math.max(1, Number(limit) || 24));

        const [rows, total] = await Promise.all([
            GalleryItem.find(filter)
                .sort({ sortOrder: 1, createdAt: -1 })
                .skip(start)
                .limit(size)
                .lean()
                .catch(() => []),
            GalleryItem.countDocuments(filter).catch(() => 0),
        ]);

        return {
            items: (rows || []).map((row) => ({
                id: String(row._id),
                title: row.title || '',
                caption: row.caption || '',
                category: row.category || '',
                sector: row.sector || '',
                state: row.state || '',
                region: row.region || '',
                eventDate: row.eventDate || '',
                location: row.location || '',
                media: row.media
                    ? { ...EMPTY_MEDIA, ...row.media }
                    : { ...EMPTY_MEDIA },
            })),
            total,
            offset: start,
            limit: size,
        };
    },

    /**
     * The filter dropdowns, built from what is ACTUALLY tagged.
     *
     * A dropdown offering a category no photograph carries is a dropdown that
     * returns an empty grid, and the visitor reads that as a broken page rather
     * than as an empty category.
     */
    async galleryFilters({ state = '', region = '' } = {}) {
        const filter = { visible: true };
        const stateEntry = findState(state);
        if (state && stateEntry) filter.state = stateEntry.name;
        const regionEntry = findRegion(region);
        if (region && regionEntry) filter.region = regionEntry.key;

        const [categories, sectors, states] = await Promise.all([
            GalleryItem.distinct('category', filter).catch(() => []),
            GalleryItem.distinct('sector', filter).catch(() => []),
            GalleryItem.distinct('state', { visible: true }).catch(() => []),
        ]);

        const clean = (list) => (list || []).map(str).filter(Boolean).sort();

        return {
            categories: clean(categories),
            sectors: clean(sectors),
            states: clean(states),
        };
    },
};
