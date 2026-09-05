const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const {
    SINGLETON_KEY, ICON_NAMES,
    SiteSettings, Home, About, EventsSettings,
    GallerySettings, GalleryItem, ContactSettings, ContactMessage,
} = require('./cms.models');
const Event = require('../events/event.model');
const eventService = require('../events/event.service');
// One rule, two shapes: the clause for the grid and the predicate for the
// single-event page. See the file itself for why they cannot be written twice.
const { onboardingClause, isOnboardingContent } = require('../events/onboardingVisibility');
const { removeOrphans } = require('./media.cleanup');
const { sanitizeHtml } = require('./richText');

const {
    toEvent, sanitizeAgenda, sanitizeSpeakers, sanitizeReminders, sanitizeTargets,
    sanitizeRegistrationFields
} = eventService;

/**
 * The advanced-display half of an event, lifted off the shared mapper.
 *
 * The CMS listing has its own shape — `imageUrl`, `location`, a `media` object —
 * which the public site and the mobile app both read, so it cannot simply be
 * replaced with `toEvent`'s. These fields are additive and identical in both,
 * so they are taken from the one mapper rather than written out twice and left
 * to drift.
 */
const pickEventDetail = (event = {}) => ({
    category: event.category,
    // Who the event was aimed at, as a person reads it. Derived by the one
    // mapper so the CMS card and the dashboards print it identically.
    targetLabel: event.targetLabel,
    audience: event.audience,
    agenda: event.agenda,
    speakers: event.speakers,
    venueAddress: event.venueAddress,
    venueMapUrl: event.venueMapUrl,
    contactName: event.contactName,
    contactPhone: event.contactPhone,
    contactEmail: event.contactEmail,
    registrationEnabled: event.registrationEnabled,
    registrationDeadline: event.registrationDeadline,
    registrationClosesAt: event.registrationClosesAt,
    capacity: event.capacity,
    registrationNote: event.registrationNote,
    reminderOffsetsHours: event.reminderOffsetsHours,
    // What a seat costs, and every region the event was aimed at. Both have to
    // reach the editor or it cannot show back what was just saved.
    registrationFee: event.registrationFee,
    targets: event.targets,
    /*
     * The two fields that decide whether the public can read this event.
     *
     * BOTH are needed, and sending only the flag was not enough. It postdates
     * every event in the collection, so an untargeted CMS event — which is on
     * the public site, via its channel — reads back `showOnOnboarding: false`.
     * An editor form that trusted the flag alone would show "not on the public
     * site" for an event anyone can already read. With the channel here the
     * form can derive the same answer the server does.
     */
    showOnOnboarding: event.showOnOnboarding,
    channel: event.channel,
    // The first of the two audience boxes. Sent back with `targets`, not in
    // place of it — the form restores both or it restores neither.
    reachEveryone: event.reachEveryone,
    // The form the editor designed, so the CMS can show back what it saved.
    registrationFields: event.registrationFields,
});

/**
 * The event fields the CMS editor may set beyond the basics.
 *
 * Shared by create and update, and applied the same way in both: a key absent
 * from the payload is left alone, so saving the basics form does not wipe an
 * agenda entered on the detail form.
 */
const eventDetailUpdates = (payload = {}) => {
    const update = {};

    if (payload.audience !== undefined) {
        update.audience = String(payload.audience || '').toLowerCase() === 'paid' ? 'paid' : 'all';
    }
    if (payload.agenda !== undefined) update.agenda = sanitizeAgenda(parseArray(payload.agenda));
    if (payload.speakers !== undefined) update.speakers = sanitizeSpeakers(parseArray(payload.speakers));
    if (payload.reminderOffsetsHours !== undefined) {
        update.reminderOffsetsHours = sanitizeReminders(parseArray(payload.reminderOffsetsHours));
    }

    ['category', 'venueAddress', 'venueMapUrl', 'contactName', 'contactPhone', 'contactEmail', 'registrationNote']
        .forEach((key) => {
            if (payload[key] !== undefined) update[key] = str(payload[key]);
        });

    if (payload.registrationEnabled !== undefined) {
        update.registrationEnabled = payload.registrationEnabled === true || payload.registrationEnabled === 'true';
    }

    /*
     * "Post this in the onboarding events section too."
     *
     * Read from the payload the same way `registrationEnabled` is, and for the
     * same reason: a multipart body — which is what the CMS posts whenever a
     * banner is attached — carries every field as a string, so the switch
     * arrives as `"true"` rather than `true` on exactly the saves that also
     * upload an image. Comparing against `true` alone made the flag survive a
     * text-only save and silently drop on any save with a banner.
     *
     * Absent means untouched, not false. The CMS's own screen does not render
     * this switch — a `channel: 'public'` event is onboarding content already —
     * so re-saving an event there must not clear what the super admin set.
     */
    if (payload.showOnOnboarding !== undefined) {
        update.showOnOnboarding = payload.showOnOnboarding === true || payload.showOnOnboarding === 'true';
    }

    // "Everyone in the association" — see the schema. Absent means untouched,
    // like every other flag here.
    if (payload.reachEveryone !== undefined) {
        update.reachEveryone = payload.reachEveryone === true || payload.reachEveryone === 'true';
    }

    if (payload.registrationDeadline !== undefined) {
        const raw = payload.registrationDeadline;
        if (raw === null || raw === '') {
            update.registrationDeadline = null;
        } else {
            const parsed = new Date(raw);
            if (!Number.isNaN(parsed.getTime())) update.registrationDeadline = parsed;
        }
    }

    if (payload.capacity !== undefined) {
        const capacity = Math.round(Number(payload.capacity));
        update.capacity = Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
    }

    if (payload.registrationFee !== undefined) {
        const fee = Math.round(Number(payload.registrationFee));
        update.registrationFee = Number.isFinite(fee) && fee > 0 ? fee : 0;
    }

    // The registration form the editor designed. Cleaned by the SAME function
    // the events API uses — this editor and that endpoint write one collection,
    // and two cleaning rules would mean two ideas of what a valid field is.
    if (payload.registrationFields !== undefined) {
        update.registrationFields = sanitizeRegistrationFields(parseArray(payload.registrationFields));
    }

    /*
     * The region list, and the legacy fields mirrored from its first entry.
     *
     * Cleaned by `eventService.sanitizeTargets` — the SAME function the events
     * API uses — because this editor and that endpoint write the same
     * collection. Two cleaning rules would mean an event posted from the CMS
     * and one posted from the app could disagree about whether a block without
     * a district is a valid target.
     *
     * The mirror is written here and not left to the caller for the reason the
     * events service gives: they are two representations of one fact, and a
     * write that touches one without the other leaves an event whose audience
     * depends on which client is asking.
     */
    if (payload.targets !== undefined) {
        const targets = sanitizeTargets(parseArray(payload.targets));
        update.targets = targets;

        const primary = targets[0] || { state: '', district: '', block: '' };
        update.state = primary.state;
        update.district = primary.district;
        update.block = primary.block;
    }

    return update;
};

/**
 * An array that may have arrived as a JSON string.
 *
 * The CMS posts events as `multipart/form-data` whenever a banner is attached,
 * and every field of a multipart body is a string — an agenda sent alongside a
 * file arrives as `"[{...}]"`, not as an array.
 */
function parseArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Public site content.
 *
 * Four rules shape this module:
 *
 * 1. A public GET never fails because content has not been authored yet. A new
 *    deployment has no home page written, and a 404 would leave the landing
 *    page unable to render at all. Empty defaults come back instead.
 *
 * 2. A public GET never invents content either. The pages render nothing where
 *    nothing is authored, rather than falling back to copy baked into the
 *    markup — otherwise deleting something in the CMS appears to do nothing,
 *    which is the single most confusing thing a CMS can do.
 *
 * 3. A partial save never wipes a sibling block. A page's blocks are edited on
 *    one screen; sending only the About block must not blank the carousel, so
 *    updates are merged per block rather than replacing the document.
 *
 * 4. Events are NOT a new collection. The platform already has an `Event` model
 *    with publish gating that the member app reads. A second store would mean
 *    publishing everything twice and the two lists disagreeing.
 */

const EMPTY_MEDIA = { url: '', type: 'image', alt: '', fit: 'cover', position: 'center' };

const EMPTY_SITE = {
    brand: { logo: { ...EMPTY_MEDIA }, fullName: '', tagline: '' },
    header: { navLinks: [], ctaLabel: '', ctaHref: '', background: '#ffffff', textColor: '#1c2e68' },
    extraFields: [],
    footer: {
        addressLines: [], linkColumns: [], contactHeading: '', phones: [], email: '',
        socials: [], copyright: '', legalLinks: [], note: '',
    },
};

const EMPTY_HOME = {
    carousel: {
        slides: [], headline: '', headlineHighlight: '', subheadline: '',
        ctaLabel: '', ctaHref: '', ctaIcon: 'heart',
        secondaryCtaLabel: '', secondaryCtaHref: '', secondaryCtaIcon: 'play',
        galleryPosters: { enabled: true, limit: 6, position: 'after' },
        highlightCard: { enabled: true, icon: 'users', eyebrow: '', value: '', caption: '', stats: [] },
    },
    about: {
        badgeIcon: 'users', badgeText: '', heading: '', headingHighlight: '', eyebrow: '',
        body: '', bullets: [], media: { ...EMPTY_MEDIA }, logoOverlay: { ...EMPTY_MEDIA },
        linkLabel: '', linkHref: '', statsBar: [], extraFields: [],
    },
};

const EMPTY_ABOUT = {
    badgeIcon: 'users', badgeText: '', heading: '', headingHighlight: '',
    body: '', bullets: [], bulletPoints: [],
    media: { ...EMPTY_MEDIA }, logoOverlay: { ...EMPTY_MEDIA }, statsBar: [],
    extraFields: [],
};

const EMPTY_EVENTS_SETTINGS = {
    badgeText: '', heading: '', headingHighlight: '', lede: '', subtitle: '',
    heroMedia: { ...EMPTY_MEDIA },
    heroBadge: { enabled: true, icon: 'calendar-days', title: '', subtitle: '' },
    stats: [],
    searchPlaceholder: 'Search events...',
    categories: [],
    viewAllLabel: '', viewAllHref: '/events',
    emptyText: '', emptyFilterText: '', homeLimit: 3,
    banner: { enabled: true, icon: 'calendar-days', title: '', subtitle: '', ctaLabel: '', ctaHref: '' },
    extraFields: [],
};

const EMPTY_GALLERY_SETTINGS = {
    badgeIcon: 'image', badgeText: '', heading: '', headingHighlight: '', description: '',
    noteLines: [], categories: [], viewMoreLabel: '', pageSize: 8,
    emptyText: '', emptyFilterText: '',
    detail: {
        backLabel: 'Back to Gallery',
        aboutHeading: 'About this event',
        highlightsHeading: 'Highlights',
        photosHeading: 'More photographs',
        relatedHeading: 'More from the gallery',
        ctaLabel: '', ctaHref: '',
        missingText: 'This item is no longer available.',
    },
    extraFields: [],
};

const EMPTY_CONTACT = {
    badgeIcon: 'users', badgeText: '', heading: '', headingHighlight: '', description: '',
    heroMedia: [],
    formCard: {
        icon: 'send', title: '', subtitle: '', submitLabel: '', successMessage: '',
        namePlaceholder: '', emailPlaceholder: '', phonePlaceholder: '',
        subjectPlaceholder: '', messagePlaceholder: '',
        validationMessage: '', failureMessage: '',
    },
    infoCard: {
        icon: 'users', title: '', subtitle: '',
        addressLabel: '', phoneLabel: '', emailLabel: '', hoursLabel: '',
    },
    addressLines: [], phone: '', alternatePhone: '', email: '', workingHours: [], mapEmbedUrl: '',
    social: { facebook: '', instagram: '', linkedin: '', youtube: '' },
    banner: { enabled: true, icon: 'users', title: '', subtitle: '', ctaLabel: '', ctaHref: '' },
    extraFields: [],
};

const actorOf = (user = {}) => ({ email: user.email || '', at: new Date() });

const str = (value) => String(value ?? '').trim();

/** `#rgb` or `#rrggbb`, case-insensitive. Anything else yields the fallback. */
const hexColor = (value, fallback) => {
    const raw = String(value || '').trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) ? raw.toLowerCase() : fallback;
};

/** An icon the renderer knows, or the given fallback. */
const icon = (value, fallback = 'star') => (ICON_NAMES.includes(str(value)) ? str(value) : fallback);

const asArray = (value) => {
    if (Array.isArray(value)) return value;
    // The admin forms send one item per line.
    if (typeof value === 'string') return value.split('\n').map(v => v.trim()).filter(Boolean);
    return [];
};

/** A list of plain strings, blank entries dropped. */
const stringList = (value) => asArray(value).map(str).filter(Boolean);

/**
 * Normalise a media object.
 *
 * `type` is honoured when given and otherwise inferred from the extension —
 * inference alone is unreliable (a CDN URL often has none), which is why the
 * editor stores it explicitly, but a URL pasted without one still behaves.
 */
const cleanMedia = (input = {}) => {
    const source = input || {};
    const url = str(source.url || source.imageUrl || source.mediaUrl);
    const declared = ['image', 'video'].includes(source.type) ? source.type : null;
    const looksVideo = /\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(url);

    return {
        url,
        type: declared || (looksVideo ? 'video' : 'image'),
        alt: str(source.alt),
        fit: source.fit === 'contain' ? 'contain' : 'cover',
        position: str(source.position) || 'center',
    };
};

/**
 * A list of media objects — the extra photographs on a gallery item.
 *
 * Entries with no URL are dropped rather than stored: the editor's repeatable
 * list starts each new row empty, and a row the admin added and never filled in
 * would otherwise become a blank frame on the public page.
 */
const cleanPhotos = (value) => {
    // A multipart save (a file upload alongside the fields) stringifies arrays,
    // so the list can arrive as JSON text rather than as an array.
    let source = value;
    if (typeof source === 'string' && source.trim().startsWith('[')) {
        try { source = JSON.parse(source); } catch { source = []; }
    }

    return asArray(source)
        .map(m => cleanMedia(typeof m === 'string' ? { url: m } : m))
        .filter(m => m.url)
        .slice(0, 24);
};

/**
 * The editor's own named fields on a gallery item.
 *
 * A row with neither a label nor a value is dropped — the editor's list starts
 * each new row empty, and a row somebody added and never filled in would
 * otherwise render as a stray colon on the public page. A row with a label and
 * no value is KEPT, because "Sponsors: —" is a thing an editor may deliberately
 * be part-way through writing.
 */
const cleanExtraFields = (value) => {
    let source = value;
    // A multipart save stringifies arrays; see `cleanPhotos`.
    if (typeof source === 'string' && source.trim().startsWith('[')) {
        try { source = JSON.parse(source); } catch { source = []; }
    }

    return asArray(source)
        .map(f => ({ label: str(f && f.label), value: String((f && f.value) ?? '').trim().slice(0, 2000) }))
        .filter(f => f.label || f.value)
        .slice(0, 20);
};

/**
 * The long write-up on a gallery item.
 *
 * Trimmed at the ends and capped, but NOT collapsed: the paragraph breaks an
 * editor typed are the only structure this field has, and the public page
 * renders them verbatim. Stored as plain text and printed by React, so it is
 * escaped on the way out — no markup is interpreted and none needs stripping.
 */
const cleanDescription = (value) => String(value ?? '').trim().slice(0, 8000);

/** A label and its destination. Entries with neither are dropped by the caller. */
const cleanLink = (input = {}) => ({ label: str(input.label), href: str(input.href) });

const cleanLinks = (value) => asArray(value).map(cleanLink).filter(l => l.label || l.href);

/** A figure, its caption and the icon beside it. */
const cleanStats = (value, fallbackIcon = 'users') =>
    asArray(value)
        .map(s => ({ icon: icon(s.icon, fallbackIcon), value: str(s.value), label: str(s.label) }))
        // A stat with neither figure nor label is an empty column.
        .filter(s => s.value || s.label);

/**
 * Bullets carry an icon each, so a plain string list is not enough.
 *
 * A string is still accepted: documents written before bullets had icons store
 * one, and the migration is "edit the page", not "run a script".
 */
const cleanBullets = (value) =>
    asArray(value)
        .map(b => (typeof b === 'string'
            ? { icon: 'users', text: b }
            : { icon: icon(b.icon, 'users'), text: String(b.text ?? '') }))
        // Sanitised on the way in, not on the way out. Storing raw markup and
        // cleaning it at render time means every future reader has to remember
        // to do so; cleaning it once here means the database only ever holds
        // markup that is safe to print.
        .map(b => ({ icon: b.icon, text: sanitizeHtml(b.text) }))
        .filter(b => b.text);

const boolOf = (value, fallback = true) => {
    if (value === undefined || value === null || value === '') return fallback;
    return value !== false && value !== 'false' && value !== 0 && value !== '0';
};

/** Read a singleton, or its empty shape. */
const readSingleton = async(Model, empty) => {
    const doc = await Model.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
    return doc ? { ...empty, ...doc } : { ...empty, key: SINGLETON_KEY };
};

/**
 * Write a singleton.
 *
 * `runValidators` is on because an upsert skips them otherwise — which is how a
 * required field ends up missing on a document nothing ever validated.
 */
const writeSingleton = (Model, payload, user) =>
    Model.findOneAndUpdate(
        { key: SINGLETON_KEY },
        { $set: { ...payload, key: SINGLETON_KEY, editedBy: actorOf(user) } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();

/**
 * Reclaim the disk space a write just freed.
 *
 * Called after the write has landed, never before: the cleanup counts live
 * references, and running it first would still see the document being replaced.
 * Nothing is awaited by the caller's response — an admin should not wait on a
 * filesystem scan to be told their save worked — but the promise IS returned so
 * tests can await it.
 */
const reclaim = (previous) => removeOrphans(previous);

class CmsService {
    // ============================================================ site chrome

    async getSiteSettings() {
        const doc = await readSingleton(SiteSettings, EMPTY_SITE);
        return {
            ...doc,
            brand: {
                ...EMPTY_SITE.brand,
                ...(doc.brand || {}),
                logo: { ...EMPTY_MEDIA, ...((doc.brand || {}).logo || {}) },
            },
            header: { ...EMPTY_SITE.header, ...(doc.header || {}) },
            extraFields: doc.extraFields || [],
            footer: { ...EMPTY_SITE.footer, ...(doc.footer || {}) },
        };
    }

    /**
     * Update the header, the footer or the branding.
     *
     * Merged per block for the same reason the home page is: the CMS screen has
     * three save buttons and saving the footer must not blank the nav.
     */
    /**
     * A hex colour, or the fallback.
     *
     * These values are interpolated into an inline `style`, so an unchecked
     * string is a place for arbitrary CSS to be injected by anyone who can edit
     * site settings. Accepting only `#rgb` / `#rrggbb` makes that impossible
     * rather than merely unlikely.
     */
    async updateSiteSettings(payload = {}, user = {}) {
        const set = { editedBy: actorOf(user) };

        if (payload.brand) {
            const b = payload.brand;
            // `name` was accepted here and rendered nowhere. Dropped rather than
            // kept, so nothing asks an editor to fill in a field that has no
            // effect on the site.
            set.brand = {
                logo: cleanMedia(b.logo),
                fullName: str(b.fullName),
                tagline: str(b.tagline),
            };
        }

        if (payload.header) {
            const h = payload.header;
            set.header = {
                navLinks: cleanLinks(h.navLinks),
                ctaLabel: str(h.ctaLabel),
                ctaHref: str(h.ctaHref),
                // Validated, because these are written straight into a style
                // attribute. Anything that is not a plain hex colour falls back
                // to the default rather than reaching the page.
                background: hexColor(h.background, '#ffffff'),
                textColor: hexColor(h.textColor, '#1c2e68'),
            };
        }

        if (payload.footer) {
            const f = payload.footer;
            set.footer = {
                addressLines: stringList(f.addressLines),
                linkColumns: asArray(f.linkColumns)
                    .map(c => ({ heading: str(c.heading), links: cleanLinks(c.links) }))
                    // A column with a heading and no links is a heading floating
                    // in whitespace.
                    .filter(c => c.links.length),
                contactHeading: str(f.contactHeading),
                phones: stringList(f.phones),
                email: str(f.email),
                socials: asArray(f.socials)
                    .map(s => ({ icon: icon(s.icon, 'facebook'), href: str(s.href) }))
                    // A social icon linking nowhere is a dead button.
                    .filter(s => s.href),
                copyright: str(f.copyright),
                legalLinks: cleanLinks(f.legalLinks),
                note: str(f.note),
            };
        }

        // The editor's own footer rows. Sent independently of the two blocks
        // above, so a header-only save does not blank them.
        if (payload.extraFields !== undefined) set.extraFields = cleanExtraFields(payload.extraFields);

        // Captured before the write so a replaced logo can be reclaimed after.
        const previous = await SiteSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);

        await SiteSettings.findOneAndUpdate(
            { key: SINGLETON_KEY },
            { $set: { ...set, key: SINGLETON_KEY } },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        );

        await reclaim(previous);
        return this.getSiteSettings();
    }

    // ============================================================ home page

    async getHome() {
        const doc = await Home.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);
        if (!doc) return { ...EMPTY_HOME, key: SINGLETON_KEY };

        const carousel = doc.carousel || {};
        const about = doc.about || {};

        // Merged rather than spread, so a document saved before a block existed
        // still answers with that block's empty shape instead of `undefined`.
        return {
            ...doc,
            carousel: {
                ...EMPTY_HOME.carousel,
                ...carousel,
                // A document saved before the banner could carry gallery posters
                // has no such block; the default turns them on, which is what
                // makes the feature appear without an editor hunting for it.
                galleryPosters: {
                    ...EMPTY_HOME.carousel.galleryPosters,
                    ...(carousel.galleryPosters || {}),
                },
                highlightCard: {
                    ...EMPTY_HOME.carousel.highlightCard,
                    ...(carousel.highlightCard || {}),
                    stats: (carousel.highlightCard || {}).stats || [],
                },
            },
            about: {
                ...EMPTY_HOME.about,
                ...about,
                media: { ...EMPTY_MEDIA, ...(about.media || {}) },
                logoOverlay: { ...EMPTY_MEDIA, ...(about.logoOverlay || {}) },
                bullets: about.bullets || [],
                statsBar: about.statsBar || [],
                extraFields: about.extraFields || [],
            },
        };
    }

    /**
     * Update one or both blocks of the home page.
     *
     * Only the blocks present in the payload are touched. The CMS edits both on
     * one screen but saves them separately, and a save of the About block must
     * not blank the carousel someone spent ten minutes on.
     */
    async updateHome(payload = {}, user = {}) {
        const set = { editedBy: actorOf(user) };

        if (payload.carousel) {
            const c = payload.carousel;
            const card = c.highlightCard || {};
            const posters = c.galleryPosters || {};
            const posterLimit = Number(posters.limit);

            set.carousel = {
                galleryPosters: {
                    enabled: boolOf(posters.enabled, true),
                    // Capped at 10: past that the banner takes longer to cycle
                    // than anybody stays on the page.
                    limit: Number.isFinite(posterLimit) && posterLimit >= 0 ? Math.min(posterLimit, 10) : 6,
                    position: posters.position === 'before' ? 'before' : 'after',
                },
                // A slide with no media is not a slide — it renders as a blank
                // frame the visitor has to sit through.
                slides: asArray(c.slides)
                    .map(s => ({ media: cleanMedia(s.media || s), caption: str(s.caption) }))
                    .filter(s => s.media.url),
                headline: str(c.headline),
                headlineHighlight: str(c.headlineHighlight),
                subheadline: str(c.subheadline),
                ctaLabel: str(c.ctaLabel),
                ctaHref: str(c.ctaHref),
                ctaIcon: icon(c.ctaIcon, 'heart'),
                secondaryCtaLabel: str(c.secondaryCtaLabel),
                secondaryCtaHref: str(c.secondaryCtaHref),
                secondaryCtaIcon: icon(c.secondaryCtaIcon, 'play'),
                highlightCard: {
                    enabled: boolOf(card.enabled, true),
                    icon: icon(card.icon, 'users'),
                    eyebrow: str(card.eyebrow),
                    value: str(card.value),
                    caption: str(card.caption),
                    stats: cleanStats(card.stats),
                },
            };
        }

        if (payload.about) {
            const a = payload.about;
            set.about = {
                badgeIcon: icon(a.badgeIcon, 'users'),
                badgeText: str(a.badgeText),
                heading: str(a.heading),
                headingHighlight: str(a.headingHighlight),
                eyebrow: str(a.eyebrow),
                body: sanitizeHtml(a.body),
                bullets: cleanBullets(a.bullets),
                media: cleanMedia(a.media || a),
                logoOverlay: cleanMedia(a.logoOverlay),
                linkLabel: str(a.linkLabel),
                linkHref: str(a.linkHref),
                statsBar: cleanStats(a.statsBar),
                extraFields: cleanExtraFields(a.extraFields),
            };
        }

        const previous = await Home.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);

        await Home.findOneAndUpdate(
            { key: SINGLETON_KEY },
            { $set: { ...set, key: SINGLETON_KEY } },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
        );

        // A removed carousel slide or a replaced About photograph.
        await reclaim(previous);
        return this.getHome();
    }

    // ============================================================ about page

    async getAbout() {
        const doc = await readSingleton(About, EMPTY_ABOUT);
        return {
            ...doc,
            media: { ...EMPTY_MEDIA, ...(doc.media || {}) },
            logoOverlay: { ...EMPTY_MEDIA, ...(doc.logoOverlay || {}) },
            // A document written before bullets carried icons still renders.
            bullets: (doc.bullets || []).length
                ? doc.bullets
                : (doc.bulletPoints || []).map(t => ({ icon: 'users', text: t })),
            statsBar: doc.statsBar || [],
        };
    }

    async updateAbout(payload = {}, user = {}) {
        const bullets = cleanBullets(payload.bullets !== undefined ? payload.bullets : payload.bulletPoints);
        const previous = await About.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);

        const saved = await writeSingleton(About, {
            badgeIcon: icon(payload.badgeIcon, 'users'),
            badgeText: str(payload.badgeText),
            heading: str(payload.heading),
            headingHighlight: str(payload.headingHighlight),
            body: sanitizeHtml(payload.body),
            bullets,
            // Kept in step so anything still reading the old field agrees with
            // the new one rather than showing content two edits out of date.
            bulletPoints: bullets.map(b => b.text),
            media: cleanMedia(payload.media || payload),
            logoOverlay: cleanMedia(payload.logoOverlay),
            statsBar: cleanStats(payload.statsBar),
            extraFields: cleanExtraFields(payload.extraFields),
        }, user);

        await reclaim(previous);
        return saved;
    }

    // ============================================================ events page

    async getEventsSettings() {
        const doc = await readSingleton(EventsSettings, EMPTY_EVENTS_SETTINGS);
        // A document written before the hero fields existed has no `heroBadge`
        // or `banner` sub-document at all, and the page would read `.title` off
        // undefined. Filling from the defaults here means every caller gets the
        // whole shape whatever the row's age.
        return {
            ...doc,
            heroMedia: { ...EMPTY_MEDIA, ...(doc.heroMedia || {}) },
            heroBadge: { ...EMPTY_EVENTS_SETTINGS.heroBadge, ...(doc.heroBadge || {}) },
            banner: { ...EMPTY_EVENTS_SETTINGS.banner, ...(doc.banner || {}) },
            stats: doc.stats || [],
            categories: doc.categories || [],
        };
    }

    updateEventsSettings(payload = {}, user = {}) {
        const limit = Number(payload.homeLimit);
        const badge = payload.heroBadge || {};
        const banner = payload.banner || {};

        return writeSingleton(EventsSettings, {
            badgeText: str(payload.badgeText),
            heading: str(payload.heading),
            headingHighlight: str(payload.headingHighlight),
            lede: str(payload.lede),
            subtitle: str(payload.subtitle),

            heroMedia: cleanMedia(payload.heroMedia || {}),
            heroBadge: {
                enabled: boolOf(badge.enabled, true),
                icon: icon(badge.icon, 'calendar-days'),
                title: str(badge.title),
                subtitle: str(badge.subtitle),
            },
            stats: cleanStats(payload.stats, 'calendar-days'),

            searchPlaceholder: str(payload.searchPlaceholder) || 'Search events...',
            categories: asArray(payload.categories)
                // A chip may arrive as a bare string from a textarea.
                .map(c => (typeof c === 'string'
                    ? { label: c.trim(), icon: 'calendar-days' }
                    : { label: str(c.label), icon: icon(c.icon, 'calendar-days') }))
                .filter(c => c.label),

            viewAllLabel: str(payload.viewAllLabel),
            viewAllHref: str(payload.viewAllHref) || '/events',
            emptyText: str(payload.emptyText),
            emptyFilterText: str(payload.emptyFilterText),
            homeLimit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 24) : 3,

            banner: {
                enabled: boolOf(banner.enabled, true),
                icon: icon(banner.icon, 'calendar-days'),
                title: str(banner.title),
                subtitle: str(banner.subtitle),
                ctaLabel: str(banner.ctaLabel),
                ctaHref: str(banner.ctaHref),
            },

            extraFields: cleanExtraFields(payload.extraFields),
        }, user);
    }

    // ============================================================ gallery

    /**
     * `detail` is merged key by key.
     *
     * `readSingleton` merges one level deep, so a document saved before that
     * block existed would hand the poster page an `undefined`, and one saved by
     * an older build of the editor a half-populated one. Merging here means
     * every reader gets the whole shape, whatever generation of document is in
     * the database.
     */
    async getGallerySettings() {
        const doc = await readSingleton(GallerySettings, EMPTY_GALLERY_SETTINGS);
        return {
            ...doc,
            detail: { ...EMPTY_GALLERY_SETTINGS.detail, ...(doc.detail || {}) },
        };
    }

    updateGallerySettings(payload = {}, user = {}) {
        const size = Number(payload.pageSize);
        const detail = payload.detail || {};

        return writeSingleton(GallerySettings, {
            badgeIcon: icon(payload.badgeIcon, 'image'),
            badgeText: str(payload.badgeText),
            heading: str(payload.heading),
            headingHighlight: str(payload.headingHighlight),
            description: str(payload.description),
            noteLines: stringList(payload.noteLines),
            categories: asArray(payload.categories)
                // A chip may arrive as a bare string from a textarea.
                .map(c => (typeof c === 'string'
                    ? { label: c.trim(), icon: 'image' }
                    : { label: str(c.label), icon: icon(c.icon, 'image') }))
                .filter(c => c.label),
            viewMoreLabel: str(payload.viewMoreLabel),
            pageSize: Number.isFinite(size) && size >= 0 ? Math.min(size, 200) : 8,
            emptyText: str(payload.emptyText),
            emptyFilterText: str(payload.emptyFilterText),

            detail: {
                backLabel: str(detail.backLabel) || 'Back to Gallery',
                aboutHeading: str(detail.aboutHeading) || 'About this event',
                highlightsHeading: str(detail.highlightsHeading) || 'Highlights',
                photosHeading: str(detail.photosHeading) || 'More photographs',
                relatedHeading: str(detail.relatedHeading) || 'More from the gallery',
                ctaLabel: str(detail.ctaLabel),
                ctaHref: str(detail.ctaHref),
                missingText: str(detail.missingText) || 'This item is no longer available.',
            },

            extraFields: cleanExtraFields(payload.extraFields),
        }, user);
    }

    /**
     * The gallery, in the order the page it is bound for wants it.
     *
     * `homeOnly` is the landing banner, and it differs from the grid in both what
     * it selects and how it sorts. The grid is an ARRANGEMENT — `sortOrder`
     * ascending, so an editor decides what sits where. The landing banner is a
     * FEED: "what has this association been doing lately", newest first, which
     * is the opposite end of the same list and is why it cannot simply slice the
     * grid's order.
     *
     * The write-up, bullets and extra photographs are projected away for the
     * banner. Nothing on a banner slide reads them, and an event with twelve
     * photographs would otherwise put all twelve URLs into the payload of the
     * one page whose weight matters most.
     */
    async listGallery({ includeHidden = false, homeOnly = false, limit = 0 } = {}) {
        const filter = includeHidden ? {} : { visible: { $ne: false } };
        // `$ne: false` rather than `true`: rows created before the field existed
        // have no `showOnHome`, and they are the ones already on the site.
        if (homeOnly) filter.showOnHome = { $ne: false };

        /*
         * `pinned` leads both surfaces; the rest follows each one's own order.
         *
         * `-1` because MongoDB sorts `false` before `true`.
         *
         * THE FIELD MUST EXIST ON EVERY ROW. Mongo ranks a MISSING field below
         * an explicit `false`, so a row that has never been pinned would sort
         * *under* one that was pinned and then unpinned — toggling the switch on
         * and off would promote an item permanently, for no visible reason. The
         * schema default covers every new row, and the existing ones were
         * backfilled when this shipped. Nothing may `$unset` it.
         */
        let query = GalleryItem.find(filter)
            .sort(homeOnly
                ? { pinned: -1, createdAt: -1 }
                : { pinned: -1, sortOrder: 1, createdAt: -1 });

        if (homeOnly) query = query.select('-description -highlights -photos -customFields');

        const cap = Number(limit);
        if (Number.isFinite(cap) && cap > 0) query = query.limit(Math.min(cap, 60));

        const items = await query.lean().catch(() => []);

        return items.map(i => ({
            ...i,
            media: { ...EMPTY_MEDIA, ...(i.media || {}) },
            ...(i.photos ? { photos: i.photos.map(p => ({ ...EMPTY_MEDIA, ...(p || {}) })) } : {}),
        }));
    }

    /**
     * One item, for its own page.
     *
     * A hidden item is a 404 to the public and readable to an admin, matching
     * how the list behaves — an editor checking a link before publishing should
     * not have to make the image live to do it.
     */
    async getGalleryItem(id, { includeHidden = false } = {}) {
        // Checked here rather than left to Mongoose: a malformed id makes
        // `findById` throw a CastError, which surfaces as a 500 on what is
        // really a visitor following a stale link.
        if (!/^[0-9a-fA-F]{24}$/.test(String(id || ''))) {
            throw ApiError.notFound('Gallery item not found');
        }

        const doc = await GalleryItem.findById(id).lean().catch(() => null);
        if (!doc || (!includeHidden && doc.visible === false)) {
            throw ApiError.notFound('Gallery item not found');
        }

        return {
            ...doc,
            media: { ...EMPTY_MEDIA, ...(doc.media || {}) },
            photos: (doc.photos || []).map(p => ({ ...EMPTY_MEDIA, ...(p || {}) })),
            highlights: doc.highlights || [],
            customFields: doc.customFields || [],
        };
    }

    async addGalleryItem(payload = {}, user = {}) {
        const media = cleanMedia(payload.media || payload);
        if (!media.url) throw ApiError.badRequest('An image or video is required');

        // Appended to the end unless a position is given, so adding never
        // silently reorders the grid.
        const last = await GalleryItem.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean().catch(() => null);
        const sortOrder = Number.isFinite(Number(payload.sortOrder))
            ? Number(payload.sortOrder)
            : ((last && last.sortOrder) || 0) + 1;

        return GalleryItem.create({
            media,
            title: str(payload.title),
            caption: str(payload.caption),
            category: str(payload.category),
            eventDate: str(payload.eventDate),
            location: str(payload.location),
            description: cleanDescription(payload.description),
            highlights: stringList(payload.highlights),
            photos: cleanPhotos(payload.photos),
            customFields: cleanExtraFields(payload.customFields),
            featured: boolOf(payload.featured, false),
            pinned: boolOf(payload.pinned, false),
            showOnHome: boolOf(payload.showOnHome, true),
            sortOrder,
            visible: boolOf(payload.visible, true),
            editedBy: actorOf(user),
        });
    }

    async updateGalleryItem(id, payload = {}, user = {}) {
        const update = { editedBy: actorOf(user) };
        if (payload.media || payload.url || payload.imageUrl) update.media = cleanMedia(payload.media || payload);

        ['title', 'caption', 'category', 'eventDate', 'location'].forEach((field) => {
            if (payload[field] !== undefined) update[field] = str(payload[field]);
        });

        // Not in the loop above: the write-up is long-form and carries its own
        // length cap, and the other two are lists rather than strings.
        if (payload.description !== undefined) update.description = cleanDescription(payload.description);
        if (payload.highlights !== undefined) update.highlights = stringList(payload.highlights);
        if (payload.photos !== undefined) update.photos = cleanPhotos(payload.photos);
        if (payload.customFields !== undefined) update.customFields = cleanExtraFields(payload.customFields);

        if (payload.sortOrder !== undefined) update.sortOrder = Number(payload.sortOrder) || 0;
        if (payload.visible !== undefined) update.visible = boolOf(payload.visible, true);
        if (payload.featured !== undefined) update.featured = boolOf(payload.featured, false);
        if (payload.pinned !== undefined) update.pinned = boolOf(payload.pinned, false);
        if (payload.showOnHome !== undefined) update.showOnHome = boolOf(payload.showOnHome, true);

        // Held so a replaced image is reclaimed once the new one is stored.
        const before = await GalleryItem.findById(id).lean().catch(() => null);

        const doc = await GalleryItem.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
        if (!doc) throw ApiError.notFound('Gallery item not found');

        // The extra photographs are reclaimed alongside the poster: removing a
        // row from the photo list is as much a replacement as swapping the main
        // image, and `removeOrphans` only deletes what nothing still points at.
        if (before) await reclaim([before.media, before.photos]);
        return doc;
    }

    async deleteGalleryItem(id) {
        const doc = await GalleryItem.findByIdAndDelete(id);
        if (!doc) throw ApiError.notFound('Gallery item not found');

        // The row is gone, so the scan below will not count it as a reference.
        await reclaim([doc.media, doc.photos]);
        return { id };
    }

    // ============================================================ contact

    async getContactInfo() {
        const doc = await readSingleton(ContactSettings, EMPTY_CONTACT);
        return {
            ...doc,
            heroMedia: (doc.heroMedia || []).map(m => ({ ...EMPTY_MEDIA, ...(m || {}) })),
            formCard: { ...EMPTY_CONTACT.formCard, ...(doc.formCard || {}) },
            infoCard: { ...EMPTY_CONTACT.infoCard, ...(doc.infoCard || {}) },
            social: { ...EMPTY_CONTACT.social, ...(doc.social || {}) },
            banner: { ...EMPTY_CONTACT.banner, ...(doc.banner || {}) },
            extraFields: doc.extraFields || [],
        };
    }

    async updateContactInfo(payload = {}, user = {}) {
        const social = payload.social || {};
        const form = payload.formCard || {};
        const info = payload.infoCard || {};
        const banner = payload.banner || {};
        const previous = await ContactSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null);

        const saved = await writeSingleton(ContactSettings, {
            badgeIcon: icon(payload.badgeIcon, 'users'),
            badgeText: str(payload.badgeText),
            heading: str(payload.heading),
            headingHighlight: str(payload.headingHighlight),
            description: str(payload.description),
            heroMedia: asArray(payload.heroMedia).map(cleanMedia).filter(m => m.url),

            formCard: {
                icon: icon(form.icon, 'send'),
                title: str(form.title),
                subtitle: str(form.subtitle),
                submitLabel: str(form.submitLabel),
                successMessage: str(form.successMessage),
                namePlaceholder: str(form.namePlaceholder),
                emailPlaceholder: str(form.emailPlaceholder),
                phonePlaceholder: str(form.phonePlaceholder),
                subjectPlaceholder: str(form.subjectPlaceholder),
                messagePlaceholder: str(form.messagePlaceholder),
                validationMessage: str(form.validationMessage),
                failureMessage: str(form.failureMessage),
            },
            infoCard: {
                icon: icon(info.icon, 'users'),
                title: str(info.title),
                subtitle: str(info.subtitle),
                addressLabel: str(info.addressLabel),
                phoneLabel: str(info.phoneLabel),
                emailLabel: str(info.emailLabel),
                hoursLabel: str(info.hoursLabel),
            },

            addressLines: stringList(payload.addressLines),
            phone: str(payload.phone),
            alternatePhone: str(payload.alternatePhone),
            email: str(payload.email).toLowerCase(),
            workingHours: stringList(payload.workingHours),
            mapEmbedUrl: str(payload.mapEmbedUrl),

            social: {
                facebook: str(social.facebook),
                instagram: str(social.instagram),
                linkedin: str(social.linkedin),
                youtube: str(social.youtube),
            },

            banner: {
                enabled: boolOf(banner.enabled, true),
                icon: icon(banner.icon, 'users'),
                title: str(banner.title),
                subtitle: str(banner.subtitle),
                ctaLabel: str(banner.ctaLabel),
                ctaHref: str(banner.ctaHref),
            },

            extraFields: cleanExtraFields(payload.extraFields),
        }, user);

        // A hero image removed from the pair above.
        await reclaim(previous);
        return saved;
    }

    // ============================================================ messages

    /**
     * Store a message from the public form.
     *
     * The only unauthenticated write on the platform, so deliberately narrow:
     * three required fields, everything else ignored, lengths capped. Nothing
     * here is ever rendered as HTML.
     */
    async createContactMessage(payload = {}, meta = {}) {
        const name = str(payload.name);
        const email = str(payload.email).toLowerCase();
        const message = str(payload.message);

        if (!name) throw ApiError.badRequest('Please tell us your name');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest('Please provide a valid email address');
        if (!message) throw ApiError.badRequest('Please write a message');

        // Capped rather than rejected: someone pasting a long message should not
        // lose it to a 400 they cannot act on.
        const clip = (v, max) => String(v || '').slice(0, max);

        const doc = await ContactMessage.create({
            name: clip(name, 120),
            email: clip(email, 200),
            phone: clip(payload.phone, 30),
            subject: clip(payload.subject, 200),
            message: clip(message, 5000),
            status: 'new',
            meta: { ip: clip(meta.ip, 60), userAgent: clip(meta.userAgent, 300) },
        });

        logger.info('Contact message received', { email: doc.email, id: String(doc._id) });

        // The sender is told it arrived; they are not handed the stored record.
        return { id: String(doc._id), receivedAt: doc.createdAt };
    }

    async listContactMessages({ status, page = 1, limit = 20 } = {}) {
        const filter = status && status !== 'all' ? { status } : {};
        const skip = (Math.max(1, Number(page)) - 1) * Number(limit);

        const [messages, total, unread] = await Promise.all([
            ContactMessage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean().catch(() => []),
            ContactMessage.countDocuments(filter).catch(() => 0),
            ContactMessage.countDocuments({ status: 'new' }).catch(() => 0),
        ]);

        return {
            messages,
            unread,
            pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) || 0 },
        };
    }

    async setMessageStatus(id, status) {
        if (!['new', 'read', 'archived'].includes(status)) {
            throw ApiError.badRequest('Status must be new, read or archived');
        }
        const doc = await ContactMessage.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean();
        if (!doc) throw ApiError.notFound('Message not found');
        return doc;
    }

    async deleteContactMessage(id) {
        const doc = await ContactMessage.findByIdAndDelete(id);
        if (!doc) throw ApiError.notFound('Message not found');
        return { id };
    }

    // ============================================================ events

    /**
     * Events reuse the platform's `Event` model.
     *
     * A separate CMS events collection was specified, but one already exists
     * with publish gating and geographic targeting, and the member Events screen
     * reads it. Two stores would mean publishing every event twice and the
     * public site disagreeing with the app about what is happening.
     */
    /**
     * Ordered soonest-upcoming first, then past events most-recent first.
     *
     * The public strip takes the first few under a heading that reads "Upcoming
     * Events". A plain `startAt: -1` put the furthest-out event at the top, so
     * the home page advertised next year's conference and hid next week's. A
     * plain ascending sort has the mirror problem: it leads with the oldest
     * event on record.
     *
     * The partition is done here rather than in the query because a single
     * MongoDB sort cannot express "future ascending, then past descending", and
     * the alternative — two queries — would have to split the limit between
     * them without knowing how many of each exist.
     */
    async listEvents({ includeDrafts = false, limit = 100 } = {}) {
        const filter = includeDrafts ? {} : { status: 'published' };

        /*
         * A members-only event is not public-site content.
         *
         * This listing feeds the marketing site's Events page, which anyone can
         * read without signing in. An event the super admin marked `paid` is by
         * definition not for them, and publishing it here would put the whole
         * point of the audience gate — that some events are a membership
         * benefit — on a page reachable without a membership.
         *
         * The admin listing keeps them, because the editor has to see what they
         * just wrote.
         */
        if (!includeDrafts) filter.audience = { $ne: 'paid' };

        /*
         * WHAT REACHES THE ONBOARDING SITE: THE CMS PROGRAMME, PLUS WHATEVER
         * THE SUPER ADMIN EXPLICITLY POSTED THERE.
         *
         * The rule, and the reasoning behind every clause of it, lives in
         * `events/onboardingVisibility.js`. It is there and not here because the
         * single-event page below has to apply the SAME rule to one loaded
         * document, and two inline copies of it is how a page the grid hides
         * ends up served to anyone who has the link.
         *
         * Pushed onto `$and` rather than assigned onto `filter`, so this and the
         * caller's own conditions cannot overwrite each other — which a
         * top-level `filter.channel = …` could, and did.
         */
        if (!includeDrafts) {
            filter.$and = [...(filter.$and || []), onboardingClause()];
        }

        // Fetched newest-first so the limit keeps the most relevant events when
        // there are more than it allows: an old event dropping off matters far
        // less than a forthcoming one.
        const events = await Event.find(filter).sort({ startAt: -1 }).limit(Number(limit)).lean().catch(() => []);

        const now = Date.now();
        const at = e => (e.startAt ? new Date(e.startAt).getTime() : 0);
        const undated = e => !e.startAt;

        /*
         * AN UNDATED EVENT IS NOT A PAST ONE.
         *
         * `at()` returns 0 for a missing date, so the plain comparison filed
         * every event whose date is not settled yet at the far end of the past —
         * behind 1970 — which is where nobody scrolls. Since the schema stopped
         * requiring a date that is a normal state for a real announcement, not
         * an anomaly.
         *
         * They lead the upcoming list instead: something with no date has not
         * happened, which is what "upcoming" means to a reader. Among
         * themselves they keep the order the query returned (newest-written
         * first), and every dated event follows in date order.
         */
        const upcoming = events
            .filter(e => undated(e) || at(e) >= now)
            .sort((a, b) => {
                if (undated(a) !== undated(b)) return undated(a) ? -1 : 1;
                if (undated(a)) return 0;
                return at(a) - at(b);
            });

        const past = events.filter(e => !undated(e) && at(e) < now).sort((a, b) => at(b) - at(a));

        return this.mapEvents([...upcoming, ...past]);
    }

    /**
     * The website shape of an event.
     *
     * Its own method so the listing and the single-event page below map through
     * exactly one function. Two copies of this is how a card and the page it
     * opens end up disagreeing about the same row.
     */
    mapEvents(list = []) {
        return (list || []).map(e => ({
            id: String(e._id),
            title: e.title || '',
            description: e.description || '',
            startAt: e.startAt || null,
            endAt: e.endAt || null,
            location: e.venue || [e.block, e.district, e.state].filter(Boolean).join(', '),
            venue: e.venue || '',
            state: e.state || '',
            district: e.district || '',
            block: e.block || '',
            imageUrl: e.bannerUrl || '',
            // The same media shape every other CMS section uses, so the website
            // can render an event banner through `CmsMediaFrame` and honour the
            // fit and focal point the editor chose. `imageUrl` stays for the
            // mobile app, which knows only that field.
            media: {
                url: e.bannerUrl || '',
                type: /\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(e.bannerUrl || '') ? 'video' : 'image',
                alt: e.bannerAlt || '',
                fit: e.bannerFit === 'contain' ? 'contain' : 'cover',
                position: e.bannerPosition || 'center',
            },
            status: e.status || 'draft',
            // The advanced-display fields, mapped through the one event mapper
            // so this listing and `/events` cannot describe the same row
            // differently. `toEvent` is the authority on their shape.
            ...pickEventDetail(toEvent(e)),
        }));
    }

    /**
     * The moment an event starts.
     *
     * `startAt` is preferred and is what the CMS sends: a full ISO instant with
     * an offset, built in the browser where the editor's own timezone is the
     * right one.
     *
     * The `date` + `time` pair is the fallback for older callers, and it is
     * ambiguous by construction — `new Date('2026-09-14T14:30:00')` is parsed in
     * the SERVER's timezone. In development that is IST and looks correct; on a
     * UTC host the same input lands five and a half hours out, so an event
     * entered as 2.30pm is shown to visitors as 8pm. Anything relying on this
     * branch should be moved to `startAt`.
     */
    toStartAt(payload = {}) {
        if (payload.startAt) {
            const parsed = new Date(payload.startAt);
            if (!Number.isNaN(parsed.getTime())) return parsed;
        }
        if (payload.date) {
            const time = str(payload.time) || '00:00';
            const parsed = new Date(`${payload.date}T${time.length === 5 ? time : '00:00'}:00`);
            if (!Number.isNaN(parsed.getTime())) return parsed;
        }
        return null;
    }

    /**
     * One event, for its own public page.
     *
     * Built from the same mapper as the listing, so the page a visitor opens
     * cannot describe an event differently from the card they clicked.
     *
     * TWO THINGS ARE HIDDEN, and for the same reason they are hidden from the
     * listing: a draft is not published, and a members-only event is a
     * membership benefit that does not belong on a page anyone can read without
     * signing in. Both answer 404 rather than 403 — a public visitor has no
     * business learning that a members-only event exists at this id.
     */
    async listEvent(id, { includeDrafts = false } = {}) {
        // Checked here rather than left to Mongoose: a malformed id throws a
        // CastError, which surfaces as a 500 on what is a stale link.
        if (!/^[0-9a-fA-F]{24}$/.test(String(id || ''))) throw ApiError.notFound('Event not found');

        const doc = await Event.findById(id).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Event not found');

        const isDraft = (doc.status || 'draft') !== 'published';
        const membersOnly = String(doc.audience || 'all').toLowerCase() === 'paid';

        /*
         * A THIRD THING IS HIDDEN: an event that is not onboarding content.
         *
         * The same rule the listing applies, from the same module, evaluated
         * against this one document. Without it the opt-in is only a filter on
         * the grid: an event the super admin kept inside the association would
         * be absent from the list and fully readable at `/events/:id`, which is
         * exactly where a link copied out of a member dashboard lands an
         * anonymous visitor.
         */
        if (!includeDrafts && (isDraft || membersOnly || !isOnboardingContent(doc))) {
            throw ApiError.notFound('Event not found');
        }

        // `listEvents` maps a whole array; one document goes through the same
        // path so the shapes cannot drift.
        const [mapped] = this.mapEvents([doc]);
        return mapped;
    }

    /**
     * NOTHING HERE IS REQUIRED — see the note at the top of the event schema.
     *
     * The two guards this replaces rejected an event with no title or no
     * settled date. Both are ordinary states for something being written: the
     * date is agreed after the speaker is, and an editor who cannot save
     * without one types "TBC" and ships it. `status` carries readiness; these
     * fields carry what is known.
     *
     * `toStartAt` returns `null` for a missing or unparseable date, and `null`
     * is stored as-is. The distinction it keeps is between "no date yet" and
     * "the epoch" — the listings sort on this field.
     */
    async createEvent(payload = {}, user = {}) {
        const title = str(payload.title);
        const startAt = this.toStartAt(payload);

        return Event.create({
            title,
            description: str(payload.description),
            startAt,
            // An end time is optional: many events are announced with a start
            // and no published finish.
            endAt: payload.endAt ? new Date(payload.endAt) : undefined,
            venue: str(payload.location || payload.venue),
            state: str(payload.state),
            district: str(payload.district),
            block: str(payload.block),
            bannerUrl: str(payload.imageUrl || payload.bannerUrl),
            bannerAlt: str(payload.bannerAlt || payload.alt),
            bannerFit: payload.bannerFit === 'contain' || payload.fit === 'contain' ? 'contain' : 'cover',
            bannerPosition: str(payload.bannerPosition || payload.position) || 'center',
            // Published by default: adding an event through the CMS means it to
            // appear. Drafts remain available via the status control.
            status: payload.status === 'draft' ? 'draft' : 'published',
            // Which site this belongs to. Sent by the screen that posted it:
            // the CMS says 'public', the super admin's Events screen 'members'.
            channel: payload.channel === 'members' ? 'members' : 'public',
            createdBy: user.email || '',
            // Agenda, speakers, audience, venue detail and registration.
            ...eventDetailUpdates(payload),
        });
    }

    async updateEvent(id, payload = {}) {
        const update = {};

        /*
         * Re-saving from a screen (re)declares which site the event belongs to.
         *
         * This is how a row posted before `channel` existed gets corrected: open
         * it where it belongs and press Save. Only a value the client actually
         * sent is honoured — an older client that knows nothing of the field
         * leaves it alone rather than silently reassigning the event.
         */
        if (payload.channel !== undefined) {
            update.channel = payload.channel === 'members' ? 'members' : 'public';
        }

        if (payload.title !== undefined) update.title = str(payload.title);
        if (payload.description !== undefined) update.description = str(payload.description);
        if (payload.location !== undefined || payload.venue !== undefined) {
            update.venue = str(payload.location ?? payload.venue);
        }
        if (payload.imageUrl !== undefined || payload.bannerUrl !== undefined) {
            update.bannerUrl = str(payload.imageUrl ?? payload.bannerUrl);
        }
        if (payload.bannerAlt !== undefined || payload.alt !== undefined) {
            update.bannerAlt = str(payload.bannerAlt ?? payload.alt);
        }
        if (payload.bannerFit !== undefined || payload.fit !== undefined) {
            update.bannerFit = (payload.bannerFit ?? payload.fit) === 'contain' ? 'contain' : 'cover';
        }
        if (payload.bannerPosition !== undefined || payload.position !== undefined) {
            update.bannerPosition = str(payload.bannerPosition ?? payload.position) || 'center';
        }
        ['state', 'district', 'block'].forEach((f) => {
            if (payload[f] !== undefined) update[f] = str(payload[f]);
        });
        if (payload.status !== undefined) update.status = payload.status === 'draft' ? 'draft' : 'published';

        const startAt = this.toStartAt(payload);
        if (startAt) update.startAt = startAt;
        if (payload.endAt !== undefined) update.endAt = payload.endAt ? new Date(payload.endAt) : null;

        // Only the detail keys actually present in this payload, so saving the
        // basics form does not clear an agenda entered on the detail form.
        Object.assign(update, eventDetailUpdates(payload));

        const before = await Event.findById(id).select('bannerUrl').lean().catch(() => null);

        const doc = await Event.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true }).lean();
        if (!doc) throw ApiError.notFound('Event not found');

        if (before) await reclaim(before.bannerUrl);
        return doc;
    }

    async deleteEvent(id) {
        const doc = await Event.findByIdAndDelete(id);
        if (!doc) throw ApiError.notFound('Event not found');

        await reclaim(doc.bannerUrl);
        return { id };
    }

    // ============================================================ overview

    async getOverview() {
        const [site, home, about, contact, gallery, galleryHidden, events, messages, unread] = await Promise.all([
            SiteSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            Home.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            About.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            ContactSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            GalleryItem.countDocuments().catch(() => 0),
            GalleryItem.countDocuments({ visible: false }).catch(() => 0),
            Event.countDocuments().catch(() => 0),
            ContactMessage.countDocuments().catch(() => 0),
            ContactMessage.countDocuments({ status: 'new' }).catch(() => 0),
        ]);

        const h = home || {};
        const s = site || {};
        const carousel = h.carousel || {};
        const homeAbout = h.about || {};

        return {
            site: {
                // The nav is what makes the chrome usable; branding alone is not
                // enough to call it set up.
                configured: !!((s.header || {}).navLinks || []).length,
                navLinks: ((s.header || {}).navLinks || []).length,
                footerColumns: ((s.footer || {}).linkColumns || []).length,
                socials: ((s.footer || {}).socials || []).length,
                updatedAt: s.updatedAt,
            },
            home: {
                configured: !!home,
                slides: (carousel.slides || []).length,
                headlineWritten: !!carousel.headline,
                highlightStats: ((carousel.highlightCard || {}).stats || []).length,
                aboutBullets: (homeAbout.bullets || []).length,
                aboutStats: (homeAbout.statsBar || []).length,
                aboutWritten: !!homeAbout.body,
                updatedAt: h.updatedAt,
            },
            about: {
                configured: !!(about && (about.body || (about.bullets || []).length)),
                bullets: ((about || {}).bullets || []).length,
                stats: ((about || {}).statsBar || []).length,
                updatedAt: about && about.updatedAt,
            },
            contact: {
                configured: !!(contact && (contact.email || contact.phone)),
                addressLines: ((contact || {}).addressLines || []).length,
                workingHours: ((contact || {}).workingHours || []).length,
                updatedAt: contact && contact.updatedAt,
            },
            gallery: { total: gallery, hidden: galleryHidden },
            events: { total: events },
            messages: { total: messages, unread },
        };
    }
}

module.exports = new CmsService();
