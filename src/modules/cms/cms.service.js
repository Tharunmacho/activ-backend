const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const {
    SINGLETON_KEY, ICON_NAMES,
    SiteSettings, Home, About, EventsSettings, LegalDocument, LegalRevision,
    GallerySettings, GalleryItem, ContactSettings, ContactMessage,
    // Counted by the Overview, which answers for every screen in the sidebar.
    Membership, NewsArticle, NewsSettings, Scheme, RegionPage, StatePage, LeaderMessage,
} = require('./cms.models');
const Event = require('../events/event.model');
const eventService = require('../events/event.service');
// One rule, two shapes: the clause for the grid and the predicate for the
// single-event page. See the file itself for why they cannot be written twice.
const { onboardingClause, isOnboardingContent } = require('../events/onboardingVisibility');
const { removeOrphans } = require('./media.cleanup');
const { sanitizeHtml } = require('./richText');

const { findState } = require('./cms.regionMap');

/**
 * The canonical state name and its region, from whatever the editor picked.
 *
 * Spelling comes from the content map rather than from the payload, because
 * `buildGeoFilter`-style matching is exact: "Tamil nadu" and "Tamil Nadu" are
 * two galleries, each holding half the photographs.
 */
const galleryState = (payload = {}) => {
    const name = String(payload.state || '').trim();
    if (!name) return { name: '', regionKey: '' };
    const found = findState(name);
    return found
        ? { name: found.name, regionKey: found.regionKey }
        : { name, regionKey: String(payload.region || '').trim().toLowerCase() };
};

const {
    toEvent, sanitizeAgenda, sanitizeSpeakers, sanitizeDays, sanitizeReminders, sanitizeTargets,
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
    /*
     * HOW you attend, beside WHAT it is. Both are public: a reader deciding
     * whether to book needs to know there is no room to turn up to, and which
     * service they will need installed.
     *
     * `onlineUrl` is NOT here — see `withJoinLink` below.
     */
    mode: event.mode,
    onlinePlatform: event.onlinePlatform,
    // Who the event was aimed at, as a person reads it. Derived by the one
    // mapper so the CMS card and the dashboards print it identically.
    targetLabel: event.targetLabel,
    audience: event.audience,
    agenda: event.agenda,
    /* The per-day programme. Empty on a single-day event and on everything
       written before it existed — the reader falls back to `agenda`. */
    days: event.days || [],
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
    topic: event.topic,
    language: event.language,
    reminderOffsetsHours: event.reminderOffsetsHours,
    // What a seat costs, and every region the event was aimed at. Both have to
    // reach the editor or it cannot show back what was just saved.
    registrationFee: event.registrationFee,
    // BOTH prices reach the editor, or the member rate is blank every time the
    // form reopens and the next save clears a rate nobody meant to remove.
    memberFee: event.memberFee,
    memberPrice: event.memberPrice,
    hasMemberRate: event.hasMemberRate,
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
    /*
     * A THIRD surface, and a different question from the two above: not
     * "may the public read it" but "is it one of the few on the landing
     * page". True unless somebody turned it off — see the schema.
     */
    showOnHome: event.showOnHome !== false,
    // The QR card on the event page. See the schema.
    showQrOnPage: event.showQrOnPage !== false,
    /*
     * The home page BANNER, and the words over this event there — the
     * gallery's own banner fields, on an event. See the schema.
     */
    showInBanner: event.showInBanner !== false,
    bannerHeadline: event.bannerHeadline || '',
    bannerHighlight: event.bannerHighlight || '',
    bannerSubheadline: event.bannerSubheadline || '',
    bannerAlign: event.bannerAlign === 'right' ? 'right' : 'left',
    // The first of the two audience boxes. Sent back with `targets`, not in
    // place of it — the form restores both or it restores neither.
    reachEveryone: event.reachEveryone,
    // The form the editor designed, so the CMS can show back what it saved.
    registrationFields: event.registrationFields,
});

/**
 * The join link, for the two readers allowed to have it.
 *
 * A link on a public page is a seat given away: the point of taking a booking
 * for an online event is that the people who join are the people who
 * registered. So it is added here, by a caller that has already established who
 * is asking, rather than living in `pickEventDetail` where every public mapper
 * would carry it by default.
 *
 * Opt-IN rather than opt-out on purpose. A field that has to be remembered and
 * stripped is a field that eventually is not.
 */
const withJoinLink = (mapped = {}, event = {}, privileged = false) =>
    (privileged ? { ...mapped, onlineUrl: event.onlineUrl || '' } : mapped);

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
    if (payload.days !== undefined) update.days = sanitizeDays(parseArray(payload.days));
    if (payload.speakers !== undefined) update.speakers = sanitizeSpeakers(parseArray(payload.speakers));
    if (payload.reminderOffsetsHours !== undefined) {
        update.reminderOffsetsHours = sanitizeReminders(parseArray(payload.reminderOffsetsHours));
    }

    /*
     * ONLINE OR OFFLINE, normalised to the two the schema allows.
     *
     * Anything unrecognised falls to `offline`, which is the safe direction: an
     * event wrongly marked offline shows its venue and loses a link the editor
     * can re-enter, while one wrongly marked online hides the address people
     * need to turn up at.
     */
    if (payload.mode !== undefined) {
        update.mode = String(payload.mode || '').trim().toLowerCase() === 'online' ? 'online' : 'offline';
    }

    ['category', 'venueAddress', 'venueMapUrl', 'contactName', 'contactPhone', 'contactEmail', 'registrationNote',
        'onlinePlatform', 'onlineUrl', 'topic', 'language']
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

    /*
     * On the home page's strip. Same string-boolean handling as the flag
     * above, for the same reason: a multipart save carries it as "true".
     *
     * Absent means untouched. The Home screen sends ONLY this field when an
     * editor toggles a row, so an event saved from there must keep every
     * other thing about it.
     */
    if (payload.showOnHome !== undefined) {
        update.showOnHome = payload.showOnHome === true || payload.showOnHome === 'true';
    }
    // The QR card on the event page; same string-boolean rule, absent = untouched.
    if (payload.showQrOnPage !== undefined) {
        update.showQrOnPage = payload.showQrOnPage === true || payload.showQrOnPage === 'true';
    }

    /*
     * The home page banner — the switch and the words, as on a gallery item
     * (`updateGalleryItem`), with the same lengths. Absent means untouched:
     * the Home screen sends only the switch, or only the words.
     */
    if (payload.showInBanner !== undefined) {
        update.showInBanner = payload.showInBanner === true || payload.showInBanner === 'true';
    }
    [['bannerHeadline', 120], ['bannerHighlight', 60], ['bannerSubheadline', 280]].forEach(([field, max]) => {
        if (payload[field] !== undefined) update[field] = String(payload[field] || '').trim().slice(0, max);
    });
    if (payload.bannerAlign !== undefined) update.bannerAlign = payload.bannerAlign === 'right' ? 'right' : 'left';

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

    /*
     * The member rate, cleaned by the SAME rule `event.service.sanitize` uses —
     * empty clears it, a number sets it, and zero is a real answer.
     *
     * The CMS and the events API write one collection, and the two ideas of
     * what an empty member-price box means would differ by the entire ticket
     * price: one of them would read `''` as "free for every member".
     */
    if (payload.memberFee !== undefined) {
        const raw = payload.memberFee;
        if (raw === null || raw === '' || raw === 'null') {
            update.memberFee = null;
        } else {
            const member = Math.round(Number(raw));
            update.memberFee = Number.isFinite(member) && member >= 0 ? member : null;
        }
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
    sections: [],
    // The band above the footer, on every page.
    acrossIndia: { enabled: true, eyebrow: 'Across India', heading: 'Find ACTIV where you are', subtitle: '', hidden: [] },
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
        galleryPosters: { enabled: true, position: 'after' },
        highlightCard: { enabled: true, icon: 'users', eyebrow: '', value: '', caption: '', stats: [] },
    },
    about: {
        badgeIcon: 'users', badgeText: '', heading: '', headingHighlight: '', eyebrow: '',
        body: '', bullets: [], media: { ...EMPTY_MEDIA }, logoOverlay: { ...EMPTY_MEDIA },
        linkLabel: '', linkHref: '', statsBar: [], extraFields: [],
    },
    sections: [],
};

const EMPTY_QUOTE = { text: '', author: '', role: '', photo: { ...EMPTY_MEDIA } };

const EMPTY_ABOUT = {
    badgeIcon: 'users', badgeText: '', heading: '', headingHighlight: '',
    body: '', bullets: [], bulletPoints: [],
    media: { ...EMPTY_MEDIA }, logoOverlay: { ...EMPTY_MEDIA }, statsBar: [],
    quote: { ...EMPTY_QUOTE },
    extraFields: [],
    sections: [],
};

const EMPTY_EVENTS_SETTINGS = {
    badgeText: '', heading: '', headingHighlight: '', lede: '', subtitle: '',
    heroMedia: { ...EMPTY_MEDIA },
    heroBadge: { enabled: true, icon: 'calendar-days', title: '', subtitle: '' },
    stats: [],
    searchPlaceholder: 'Search events...',
    categories: [],
    viewAllLabel: '', viewAllHref: '/events',
    emptyText: '', emptyFilterText: '',
    banner: { enabled: true, icon: 'calendar-days', title: '', subtitle: '', ctaLabel: '', ctaHref: '' },
    // Where a visitor is sent for events that already happened.
    pastLink: { enabled: true, icon: 'image', title: 'Looking for an event that has already happened?', subtitle: 'Every conclave, seminar and meeting we have held is in the gallery, with its photographs.', label: 'Open the gallery', href: '/gallery' },
    extraFields: [],
    sections: [],
};

const EMPTY_GALLERY_SETTINGS = {
    badgeIcon: 'image', badgeText: '', heading: '', headingHighlight: '', description: '',
    noteLines: [], categories: [], viewMoreLabel: '', pageSize: 8,
    // The band saying this page IS the record of past events.
    pastEvents: { enabled: true, icon: 'calendar-days', title: 'Our past events', subtitle: 'Every conclave, seminar and meeting we have held — open one for its photographs, the write-up and where it was.' },
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
    sections: [],
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
    regionsBand: { enabled: true, eyebrow: '', heading: '', subtitle: '' },
    extraFields: [],
    sections: [],
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
/**
 * A photograph as the API serves it.
 *
 * `customFields` is defaulted to an array HERE rather than left undefined,
 * because every caller maps it — a row written before the field existed
 * would otherwise throw on `.map` on the one page built to show it.
 */
const servedPhoto = (p) => ({
    ...EMPTY_MEDIA,
    title: '',
    caption: '',
    description: '',
    ...(p || {}),
    customFields: (((p && p.customFields) || []).map(servedField)),
});

/**
 * A named field as the API serves it.
 *
 * `icon` and `placement` are defaulted HERE, not left blank: the page draws a
 * mark beside every card field and decides where each one goes, and a row
 * written before these existed would otherwise leave the hole this was added
 * to close, or land nowhere at all.
 */
const servedField = (f) => ({
    label: (f && f.label) || '',
    value: (f && f.value) || '',
    icon: (f && f.icon) || 'info',
    placement: (f && f.placement) === 'content' ? 'content' : 'card',
});

/**
 * The named fields of a gallery album, and of each of its photographs.
 *
 * The same shape at both levels, deliberately: an editor filling in a
 * photograph is doing what they did on the album, and a second cleaner would
 * be a second place to forget the next cap.
 *
 * `cleanExtraFields` below now delegates to this, so every "Your own fields"
 * list on the site — the pages, the schemes, the events, the news — carries
 * the same icon and the same choice of where it goes.
 *
 * ONE PASS, and it has to be. Written as `cleanExtraFields(value).map(...)`
 * reading the icon back out of the source by INDEX, it would be correct only
 * while nothing was dropped — and that cleaner drops every row with neither a
 * label nor a value, which is exactly what an editor leaves behind after
 * pressing "add field" and changing their mind. One blank row anywhere in the
 * list and every icon after it belongs to the wrong field.
 */
const cleanNamedFields = (value) => {
    let source = value;
    // A multipart save stringifies arrays; see `cleanPhotos`.
    if (typeof source === 'string' && source.trim().startsWith('[')) {
        try { source = JSON.parse(source); } catch { source = []; }
    }

    return asArray(source)
        .map(f => ({
            label: str(f && f.label),
            /* Longer than `cleanExtraFields` allows, because a `content` field
               is a section of prose rather than a one-line fact. */
            value: String((f && f.value) ?? '').trim().slice(0, 8000),
            icon: str(f && f.icon) || 'info',
            /* Anything that is not the one other spelling is `card`, which is
               where every field written before this existed already appears. */
            placement: str(f && f.placement) === 'content' ? 'content' : 'card',
        }))
        .filter(f => f.label || f.value)
        .slice(0, 20);
};

const cleanPhotos = (value) => {
    // A multipart save (a file upload alongside the fields) stringifies arrays,
    // so the list can arrive as JSON text rather than as an array.
    let source = value;
    if (typeof source === 'string' && source.trim().startsWith('[')) {
        try { source = JSON.parse(source); } catch { source = []; }
    }

    /*
     * Each photograph keeps its own NAME, description and named fields — it
     * has a page of its own to fill. Up to 100 per album: enough for a full
     * day's event, few enough to page through.
     *
     * `title` and `customFields` are cleaned here and NOT left to the schema.
     * Mongoose strict mode drops a path this function does not return, so a
     * field added to the model and forgotten here saves with a 200 and a
     * `success: true` and is simply not there afterwards — which is how
     * `state` and `region` were lost on this very collection.
     *
     * `cleanExtraFields` is reused rather than reimplemented: the pairs mean
     * the same thing on a photograph as on the album, and two copies of the
     * rule is two places to forget the next cap.
     */
    return asArray(source)
        .map(m => {
            const raw = typeof m === 'string' ? { url: m } : (m || {});
            return {
                ...cleanMedia(raw),
                title: str(raw.title).slice(0, 200),
                caption: String(raw.caption || '').trim().slice(0, 1000),
                /* The write-up. `cleanDescription` is what the album's own body
                   goes through, so the two carry the same cap and the same
                   handling of an editor's line breaks. */
                description: cleanDescription(raw.description),
                customFields: cleanNamedFields(raw.customFields),
            };
        })
        .filter(m => m.url)
        .slice(0, 100);
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

    /*
     * ONE RULE, and it is `cleanNamedFields`.
     *
     * These two were the same pair list with two cleaners — one for the
     * gallery, one for every other screen — and the moment the gallery's grew
     * an icon and a placement, every other screen quietly kept dropping both.
     * That is the silent-loss shape this codebase has been bitten by before:
     * a 200, `success: true`, and the field is simply not there.
     *
     * The name stays because a dozen call sites read well with it.
     */
    return cleanNamedFields(source);
};

/**
 * ==========================================================================
 * WHAT THE EDITOR DID TO EACH SECTION — see `sectionOverrides` in the models
 * ==========================================================================
 *
 * Two answers per section: is it still on the page, and what did the editor
 * add to it. Both arrive on the same row because they are the same card.
 *
 * A row is KEPT when it is hidden OR carries fields, and dropped otherwise.
 * That is what stops the list growing a row for every card an editor merely
 * scrolled past: the CMS sends one row per card it rendered, and the ones
 * nobody touched are `{ hidden: false, fields: [] }` — no information, so no
 * row. Without that filter every save would store nine inert rows per page
 * and a schema change adding a card would quietly orphan them.
 *
 * `key` is a slug this repo owns. It is length-capped and trimmed anyway,
 * because "we generate it" is a statement about today's callers.
 */
const cleanSections = (value) => {
    let source = value;
    // A multipart save stringifies arrays; see `cleanPhotos`.
    if (typeof source === 'string' && source.trim().startsWith('[')) {
        try { source = JSON.parse(source); } catch { source = []; }
    }

    const seen = new Set();
    return asArray(source)
        .map(s => ({
            key: str(s && s.key).slice(0, 80),
            hidden: (s && s.hidden) === true || (s && s.hidden) === 'true',
            /* The editor's own heading for the card. Capped like every other
               free-text field; blank means "the shipped one". */
            title: str(s && s.title).slice(0, 160),
            fields: cleanExtraFields(s && s.fields),
        }))
        .filter((s) => {
            if (!s.key) return false;
            // One row per section. A duplicate key would make "is this card
            // hidden" depend on which row a reader happened to find first.
            if (seen.has(s.key)) return false;
            seen.add(s.key);
            /* A ROW WITH ONLY A RENAME ON IT IS STILL INFORMATION.
               Dropping it here would let an editor rename a card, be told the
               page saved, and find the shipped heading back on the next load. */
            return s.hidden || !!s.title || s.fields.length > 0;
        })
        .slice(0, 60);
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

/* ==================================================== legal documents */

/**
 * A slug that can be a URL and cannot be mistaken for a path.
 *
 * Lower case, alphanumerics and single hyphens. A slug with a slash in it would
 * mount a document at a nested route nothing serves; one with a dot could be
 * read as a file extension by a proxy in front of the app.
 */
const cleanSlug = (value) =>
    str(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);

/**
 * One headed block of a legal document.
 *
 * Paragraphs are trimmed and blanks dropped, but NOTHING is collapsed, rewritten
 * or truncated mid-sentence. This is the text of an agreement: a sanitiser that
 * quietly shortens a clause changes what somebody is agreeing to. The 20,000
 * character ceiling per paragraph is a sanity bound against a paste accident,
 * not an editorial limit — the longest real paragraph here is under 1,500.
 *
 * Stored as PLAIN TEXT and printed by React, so it is escaped on the way out.
 * No markup is interpreted, which is why there is no `sanitizeHtml` call: a
 * legal notice with an editor's stray `<script>` in it would be a stored XSS on
 * the one page every visitor is told to read.
 */
const cleanLegalSection = (input = {}) => ({
    heading: str(input.heading).slice(0, 200),
    body: asArray(input.body).map((p) => String(p ?? '').trim().slice(0, 20000)).filter(Boolean),
    bullets: asArray(input.bullets).map((p) => String(p ?? '').trim().slice(0, 20000)).filter(Boolean),
    links: cleanLinks(input.links),
});

const cleanLegalSections = (value) =>
    asArray(value)
        .map(cleanLegalSection)
        // A section with a heading and nothing under it is a heading somebody is
        // still writing; one with neither is an empty row left by the editor's
        // "add section" button. Both are dropped rather than rendered as a gap.
        .filter((s) => s.heading || s.body.length || s.bullets.length || s.links.length);

/** What a client is given for one document. */
const toLegalDocument = (doc = {}) => ({
    slug: doc.slug || '',
    title: doc.title || '',
    lede: doc.lede || '',
    // The footer's label falls back to the title HERE, once, rather than in each
    // of the three places that render a link. A footer that says "Untitled" for
    // a document whose title is right is a bug nobody would look for in a
    // fallback.
    footerLabel: doc.footerLabel || doc.title || '',
    sections: (doc.sections || []).map((s) => ({
        heading: (s && s.heading) || '',
        body: (s && s.body) || [],
        bullets: (s && s.bullets) || [],
        links: (s && s.links) || [],
    })),
    /* The editor's own fields. Filtered on the LABEL, because an unlabelled
       row is one their “Add field” button made and nothing was typed into. */
    extraFields: (doc.extraFields || []).map(servedField).filter((f) => f.label),
    status: doc.status || 'published',
    order: Number(doc.order || 0),
    effectiveFrom: doc.effectiveFrom || null,
    version: Number(doc.version || 1),
    updatedAt: doc.updatedAt || null,
    editedBy: doc.editedBy || null,
});

class CmsService {
    // ============================================================ legal documents

    /**
     * Put the supplied documents in the database the first time, and never again.
     *
     * INSERTS ONLY WHAT IS ABSENT. Once a slug exists, `legalSeed` is dead to it
     * — an editor's wording cannot be reverted by a restart, a redeploy or a
     * second call. It is the arrangement `membershipplan.service.ensureSeeded`
     * has with the price table, and for the same reason: without it, the first
     * deploy after the authority moved into this collection shows a visitor a
     * Privacy Policy page with nothing on it.
     *
     * Safe to call on every read, and it is. `insertMany` with `ordered: false`
     * lets the per-slug unique index refuse duplicates individually, so two
     * requests arriving together seed once between them rather than one failing.
     *
     * NEVER THROWS. Seeding is a convenience; a page that renders the documents
     * that ARE there is better than a 500 because one insert raced.
     */
    async ensureLegalSeeded() {
        try {
            const { LEGAL_SEED } = require('./legalSeed');

            const existing = await LegalDocument.find({}).select('slug').lean();
            const have = new Set((existing || []).map((d) => d.slug));
            const missing = LEGAL_SEED.filter((d) => !have.has(d.slug));
            if (!missing.length) return 0;

            await LegalDocument.insertMany(
                missing.map((d) => ({
                    ...d,
                    sections: cleanLegalSections(d.sections),
                    status: 'published',
                    version: 1,
                    effectiveFrom: null,
                    editedBy: { email: 'seed', at: new Date() },
                })),
                { ordered: false },
            );

            logger.info('Legal documents seeded', { slugs: missing.map((d) => d.slug) });
            return missing.length;
        } catch (error) {
            // E11000 here means another request seeded the same slug first,
            // which is the desired outcome reached by a different route.
            const raced = error && (error.code === 11000 || error.writeErrors);
            if (!raced) {
                logger.warn('Legal documents could not be seeded', { error: error && error.message });
            }
            return 0;
        }
    }

    /**
     * Every legal document, in footer order.
     *
     * `includeDrafts` is the admin's view. The public site gets published rows
     * only — a draft is a document being written, and half a refund policy on a
     * page a member is told to read is worse than no page.
     */
    async listLegalDocuments({ includeDrafts = false } = {}) {
        await this.ensureLegalSeeded();

        const query = includeDrafts ? {} : { status: 'published' };
        const rows = await LegalDocument.find(query)
            .sort({ order: 1, title: 1 })
            .lean()
            .catch(() => []);

        return (rows || []).map(toLegalDocument);
    }

    /**
     * The footer's list — label and href only.
     *
     * Its own method rather than the footer filtering `listLegalDocuments`,
     * because the footer is rendered on every page of the site and does not need
     * several thousand words of Terms to draw four links. The payload is the
     * difference between a few hundred bytes and a hundred kilobytes on every
     * page load.
     */
    async listLegalLinks() {
        const docs = await this.listLegalDocuments({ includeDrafts: false });
        return docs.map((d) => ({ label: d.footerLabel, href: `/${d.slug}` }));
    }

    /** One document. Throws 404 for a draft unless the caller may see drafts. */
    async getLegalDocument(slug, { includeDrafts = false } = {}) {
        await this.ensureLegalSeeded();

        const doc = await LegalDocument.findOne({ slug: cleanSlug(slug) }).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Policy not found');
        if (!includeDrafts && doc.status !== 'published') throw ApiError.notFound('Policy not found');

        return toLegalDocument(doc);
    }

    /**
     * Create or replace a legal document, keeping what it said before.
     *
     * THE PREVIOUS TEXT IS WRITTEN TO `web_legal_revisions` FIRST, and that
     * ordering is the whole guarantee. Saving the new text first and archiving
     * afterwards leaves a window — a crash, a dropped connection — in which the
     * old wording is gone and nothing recorded it. This is the question the
     * collection exists to answer ("what did the terms say on the day they
     * agreed?"), so the archive write is not best-effort: if it fails, the save
     * fails and the editor is told, rather than silently losing the history.
     */
    async saveLegalDocument(slug, payload = {}, user = {}) {
        const key = cleanSlug(slug || payload.slug);
        if (!key) throw ApiError.badRequest('A policy needs a web address (slug)');

        const existing = await LegalDocument.findOne({ slug: key }).lean().catch(() => null);

        if (existing) {
            await LegalRevision.create({
                slug: key,
                version: existing.version || 1,
                title: existing.title,
                lede: existing.lede,
                footerLabel: existing.footerLabel,
                sections: existing.sections,
                /* Archived with the rest of the wording. A statutory line
                   dropped from the revision is a line the history cannot
                   show the document ever carried. */
                extraFields: existing.extraFields,
                status: existing.status,
                effectiveFrom: existing.effectiveFrom,
                order: existing.order,
                savedBy: user.email || '',
                savedAt: new Date(),
                note: str(payload.changeNote).slice(0, 500),
            });
        }

        const set = {
            slug: key,
            title: str(payload.title).slice(0, 200),
            lede: str(payload.lede).slice(0, 500),
            footerLabel: str(payload.footerLabel).slice(0, 80),
            sections: cleanLegalSections(payload.sections),
            extraFields: asArray(payload.extraFields)
                /* `cleanNamedFields`' shape, inline, because this path caps the
                   label at 120 where that one does not. The icon and the
                   placement travel either way — dropping them here is how the
                   legal pages would have been the one screen that lost them. */
                .map((f) => ({
                    label: str(f && f.label).slice(0, 120),
                    value: String((f && f.value) ?? '').trim().slice(0, 8000),
                    icon: str(f && f.icon) || 'info',
                    placement: str(f && f.placement) === 'content' ? 'content' : 'card',
                }))
                .filter((f) => f.label)
                .slice(0, 40),
            status: payload.status === 'draft' ? 'draft' : 'published',
            order: Number.isFinite(Number(payload.order)) ? Number(payload.order) : (existing?.order ?? 999),
            /*
             * The EDITOR's date, and `null` when they have not given one.
             *
             * Not defaulted to now. "These terms took effect today" is a claim,
             * and one made by a form that was only ever used to fix a typo is a
             * false claim about an agreement. An unset date renders as nothing,
             * which is honest.
             */
            effectiveFrom: payload.effectiveFrom ? new Date(payload.effectiveFrom) : null,
            version: (existing?.version || 0) + 1,
            editedBy: actorOf(user),
        };

        if (set.effectiveFrom && Number.isNaN(set.effectiveFrom.getTime())) {
            throw ApiError.badRequest('That effective date could not be read');
        }

        const saved = await LegalDocument.findOneAndUpdate(
            { slug: key },
            { $set: set },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );

        logger.info('Legal document saved', { slug: key, version: saved.version, by: user.email });
        return toLegalDocument(saved.toObject ? saved.toObject() : saved);
    }

    /**
     * The history of one document, newest first.
     *
     * Headings and lengths rather than the whole text of every revision: a
     * history list is a list, and twelve full copies of the Terms is a megabyte
     * of JSON to render twelve rows. `getLegalRevision` fetches one in full.
     */
    async listLegalRevisions(slug, { limit = 50 } = {}) {
        const key = cleanSlug(slug);
        const rows = await LegalRevision.find({ slug: key })
            .sort({ version: -1 })
            .limit(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200))
            .select('slug version title status effectiveFrom savedBy savedAt note sections')
            .lean()
            .catch(() => []);

        return (rows || []).map((r) => ({
            slug: r.slug,
            version: r.version,
            title: r.title || '',
            status: r.status || '',
            effectiveFrom: r.effectiveFrom || null,
            savedBy: r.savedBy || '',
            savedAt: r.savedAt || r.createdAt || null,
            note: r.note || '',
            sectionCount: (r.sections || []).length,
            /* Roughly how much text, so an editor can tell a typo fix from a
               rewrite without opening both. */
            wordCount: (r.sections || []).reduce((n, s) => n
                + (s.body || []).join(' ').split(/\s+/).filter(Boolean).length
                + (s.bullets || []).join(' ').split(/\s+/).filter(Boolean).length, 0),
        }));
    }

    /** One revision, in full — for reading it, or for restoring it. */
    async getLegalRevision(slug, version) {
        const row = await LegalRevision.findOne({
            slug: cleanSlug(slug), version: Number(version),
        }).lean().catch(() => null);

        if (!row) throw ApiError.notFound('No such revision');
        return toLegalDocument(row);
    }

    /**
     * Put an earlier wording back.
     *
     * Restoring is a SAVE, not a rewind: it goes through `saveLegalDocument`, so
     * the text being replaced is archived and the version number goes UP. A
     * restore that reset the counter would make two different documents share a
     * version number, and the history would stop being a sequence.
     */
    async restoreLegalRevision(slug, version, user = {}) {
        const old = await this.getLegalRevision(slug, version);
        const current = await LegalDocument.findOne({ slug: cleanSlug(slug) }).lean().catch(() => null);

        return this.saveLegalDocument(slug, {
            ...old,
            /*
             * THE WORDING COMES BACK. THE ADDRESS AND THE FOOTER POSITION DO NOT.
             *
             * The button says "restore this wording", and that is what an editor
             * is asking for: the text as it stood. `order` is where the policy
             * sits in the footer and `slug` is its URL — both are decisions made
             * separately from the words, often long afterwards, and silently
             * reverting them would move a policy in the footer or change a live
             * URL as a side effect of a text restore.
             *
             * They are still SNAPSHOT on the revision, because the archive has
             * to be a complete record of the document at that version. Recording
             * a field and choosing not to replay it are different decisions and
             * this is the place that makes the second one.
             */
            slug: current?.slug || old.slug,
            order: current?.order ?? old.order,
            changeNote: `Restored version ${version}`,
        }, user);
    }

    /**
     * Take a document off the site.
     *
     * UNPUBLISHES rather than deleting, exactly as a retired membership plan is
     * deactivated rather than removed. A member agreed to a policy at a URL, and
     * deleting the row makes that reference point at nothing — while the editor
     * loses the one thing they would need to turn it back on.
     */
    async retireLegalDocument(slug, user = {}) {
        const key = cleanSlug(slug);
        const doc = await LegalDocument.findOne({ slug: key }).lean().catch(() => null);
        if (!doc) throw ApiError.notFound('Policy not found');

        return this.saveLegalDocument(key, {
            ...toLegalDocument(doc),
            status: 'draft',
            changeNote: 'Unpublished',
        }, user);
    }

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
            extraFields: (doc.extraFields || []).map(servedField),
            sections: doc.sections || [],
            acrossIndia: {
                ...EMPTY_SITE.acrossIndia,
                ...(doc.acrossIndia || {}),
                // Mongoose hands back a sub-array that is absent on any
                // document written before the field existed.
                hidden: (doc.acrossIndia || {}).hidden || [],
            },
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

        // Removed cards and their rows. Sent with whichever block is being
        // saved, because one card of each is on screen at the same time.
        if (payload.sections !== undefined) set.sections = cleanSections(payload.sections);

        /*
         * The band above the footer. Sent with whichever block is saved,
         * like `brand` and `extraFields`, because it is edited inside one of
         * these cards rather than in a block of its own.
         *
         * Blank falls back to the shipped wording. It is the heading over
         * the region tiles on seven pages, and an empty one is a band of
         * tiles with nothing saying what they are.
         */
        if (payload.acrossIndia !== undefined) {
            const band = payload.acrossIndia || {};
            set.acrossIndia = {
                enabled: boolOf(band.enabled, true),
                eyebrow: str(band.eyebrow) || EMPTY_SITE.acrossIndia.eyebrow,
                heading: str(band.heading) || EMPTY_SITE.acrossIndia.heading,
                subtitle: str(band.subtitle),
                // Region keys left out of the band. A deny list — see the schema.
                hidden: stringList(band.hidden).slice(0, 40),
            };
        }

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
            // On the document: its cards span both blocks.
            sections: doc.sections || [],
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

            set.carousel = {
                galleryPosters: {
                    enabled: boolOf(posters.enabled, true),
                    position: posters.position === 'before' ? 'before' : 'after',
                },
                // A slide with no media is not a slide — it renders as a blank
                // frame the visitor has to sit through.
                slides: asArray(c.slides)
                    .map(s => ({
                        media: cleanMedia(s.media || s),
                        caption: str(s.caption),
                        // Each slide's own words and side — see the model.
                        // Capped: a banner heading is a line, not a page — a
                        // paste of a whole document once filled the hero.
                        headline: str(s.headline).slice(0, 120),
                        headlineHighlight: str(s.headlineHighlight).slice(0, 60),
                        subheadline: str(s.subheadline).slice(0, 280),
                        align: s.align === 'right' ? 'right' : 'left',
                    }))
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

        // Keyed across BOTH blocks, so it rides along with either save.
        if (payload.sections !== undefined) set.sections = cleanSections(payload.sections);

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
            /* A document written before the quote existed has no sub-document
               at all, and the page would read `.text` off undefined. */
            quote: { ...EMPTY_QUOTE, ...(doc.quote || {}),
                photo: { ...EMPTY_MEDIA, ...((doc.quote || {}).photo || {}) } },
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
            /*
             * The chairman's words. Four fields, not one — see the schema.
             *
             * `sanitizeHtml` on the text and not `str`: an editor pasting from
             * a letter brings bold and line breaks with them, and stripping
             * those turns a paragraph into a wall. The same treatment `body`
             * gets, for the same reason.
             */
            quote: {
                text: sanitizeHtml((payload.quote || {}).text),
                author: str((payload.quote || {}).author),
                role: str((payload.quote || {}).role),
                photo: cleanMedia((payload.quote || {}).photo),
            },
            extraFields: cleanExtraFields(payload.extraFields),
            sections: cleanSections(payload.sections),
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
            pastLink: { ...EMPTY_EVENTS_SETTINGS.pastLink, ...(doc.pastLink || {}) },
            stats: doc.stats || [],
            categories: doc.categories || [],
        };
    }

    updateEventsSettings(payload = {}, user = {}) {
        const badge = payload.heroBadge || {};
        const banner = payload.banner || {};
        const pastLink = payload.pastLink || {};

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

            banner: {
                enabled: boolOf(banner.enabled, true),
                icon: icon(banner.icon, 'calendar-days'),
                title: str(banner.title),
                subtitle: str(banner.subtitle),
                ctaLabel: str(banner.ctaLabel),
                ctaHref: str(banner.ctaHref),
            },

            /*
             * Blank falls back to the shipped wording rather than to an
             * empty strip. This is the only thing telling a visitor where the
             * past events went, and a half-saved document that drops it
             * leaves that question unanswered on a live page.
             */
            pastLink: {
                enabled: boolOf(pastLink.enabled, true),
                icon: icon(pastLink.icon, 'image'),
                title: str(pastLink.title) || EMPTY_EVENTS_SETTINGS.pastLink.title,
                subtitle: str(pastLink.subtitle) || EMPTY_EVENTS_SETTINGS.pastLink.subtitle,
                label: str(pastLink.label) || EMPTY_EVENTS_SETTINGS.pastLink.label,
                href: str(pastLink.href) || '/gallery',
            },

            extraFields: cleanExtraFields(payload.extraFields),
            sections: cleanSections(payload.sections),
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
            pastEvents: { ...EMPTY_GALLERY_SETTINGS.pastEvents, ...(doc.pastEvents || {}) },
        };
    }

    updateGallerySettings(payload = {}, user = {}) {
        const size = Number(payload.pageSize);
        const detail = payload.detail || {};
        const pastEvents = payload.pastEvents || {};

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

            /* Blank falls back to the shipped wording — see `pastLink` on the
               events settings, which is the other half of the same sentence. */
            pastEvents: {
                enabled: boolOf(pastEvents.enabled, true),
                icon: icon(pastEvents.icon, 'calendar-days'),
                title: str(pastEvents.title) || EMPTY_GALLERY_SETTINGS.pastEvents.title,
                subtitle: str(pastEvents.subtitle) || EMPTY_GALLERY_SETTINGS.pastEvents.subtitle,
            },
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
            sections: cleanSections(payload.sections),
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
            ...(i.photos ? { photos: i.photos.map(servedPhoto) } : {}),
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
            photos: (doc.photos || []).map(servedPhoto),
            highlights: doc.highlights || [],
            customFields: (doc.customFields || []).map(servedField),
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
            /*
             * WHICH STATE THIS PHOTOGRAPH BELONGS TO.
             *
             * The state and region pages read their strip from these two
             * fields, and neither was written here — so a photograph added
             * through the CMS could never appear on a state page, and nothing
             * said why. `region` is DERIVED from the state and never taken
             * from the payload: a photograph whose state and region disagree
             * shows up in one gallery and claims another.
             */
            state: galleryState(payload).name,
            region: galleryState(payload).regionKey || str(payload.region),
            sector: str(payload.sector),
            eventDate: str(payload.eventDate),
            location: str(payload.location),
            description: cleanDescription(payload.description),
            highlights: stringList(payload.highlights),
            photos: cleanPhotos(payload.photos),
            customFields: cleanNamedFields(payload.customFields),
            featured: boolOf(payload.featured, false),
            pinned: boolOf(payload.pinned, false),
            showOnHome: boolOf(payload.showOnHome, true),
            bannerHeadline: str(payload.bannerHeadline).slice(0, 120),
            bannerHighlight: str(payload.bannerHighlight).slice(0, 60),
            bannerSubheadline: str(payload.bannerSubheadline).slice(0, 280),
            bannerAlign: payload.bannerAlign === 'right' ? 'right' : 'left',
            fromEventId: str(payload.fromEventId),
            sortOrder,
            visible: boolOf(payload.visible, true),
            editedBy: actorOf(user),
        });
    }

    async updateGalleryItem(id, payload = {}, user = {}) {
        const update = { editedBy: actorOf(user) };
        if (payload.media || payload.url || payload.imageUrl) update.media = cleanMedia(payload.media || payload);

        ['title', 'caption', 'category', 'sector', 'eventDate', 'location',
            'bannerHeadline', 'bannerHighlight', 'bannerSubheadline'].forEach((field) => {
            if (payload[field] !== undefined) update[field] = str(payload[field]);
        });
        // The same caps as the create path.
        if (update.bannerHeadline !== undefined) update.bannerHeadline = update.bannerHeadline.slice(0, 120);
        if (update.bannerHighlight !== undefined) update.bannerHighlight = update.bannerHighlight.slice(0, 60);
        if (update.bannerSubheadline !== undefined) update.bannerSubheadline = update.bannerSubheadline.slice(0, 280);
        if (payload.bannerAlign !== undefined) update.bannerAlign = payload.bannerAlign === 'right' ? 'right' : 'left';

        /* The state, and the region it implies — see the note on the create
           path. An absent key leaves both untouched, as every other field. */
        if (payload.state !== undefined) {
            const resolved = galleryState(payload);
            update.state = resolved.name;
            update.region = resolved.regionKey || str(payload.region);
        } else if (payload.region !== undefined) {
            update.region = str(payload.region).toLowerCase();
        }

        // Not in the loop above: the write-up is long-form and carries its own
        // length cap, and the other two are lists rather than strings.
        if (payload.description !== undefined) update.description = cleanDescription(payload.description);
        if (payload.highlights !== undefined) update.highlights = stringList(payload.highlights);
        if (payload.photos !== undefined) update.photos = cleanPhotos(payload.photos);
        if (payload.customFields !== undefined) update.customFields = cleanNamedFields(payload.customFields);

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
            regionsBand: { ...EMPTY_CONTACT.regionsBand, ...(doc.regionsBand || {}) },
            extraFields: doc.extraFields || [],
        };
    }

    async updateContactInfo(payload = {}, user = {}) {
        const social = payload.social || {};
        const form = payload.formCard || {};
        const info = payload.infoCard || {};
        const banner = payload.banner || {};
        const band = payload.regionsBand || {};
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

            /* The regions band as the Contact page draws it — see the schema. */
            regionsBand: {
                enabled: boolOf(band.enabled, true),
                eyebrow: str(band.eyebrow),
                heading: str(band.heading),
                subtitle: str(band.subtitle),
            },

            extraFields: cleanExtraFields(payload.extraFields),
            sections: cleanSections(payload.sections),
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
    async listEvents({ includeDrafts = false, limit = 100, privileged = false } = {}) {
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
        /* An event is over when it ENDS. A three-day conclave on its second
           morning is still upcoming; reading `startAt` alone filed it as past. */
        const over = e => {
            const finish = e.endAt || e.startAt;
            return !!finish && new Date(finish).getTime() < now;
        };

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
            .filter(e => undated(e) || !over(e))
            .sort((a, b) => {
                if (undated(a) !== undated(b)) return undated(a) ? -1 : 1;
                if (undated(a)) return 0;
                return at(a) - at(b);
            });

        const past = events.filter(e => !undated(e) && over(e)).sort((a, b) => at(b) - at(a));

        // `privileged` carries the join link; `includeDrafts` is the same
        // question asked of a different field, and the controller derives both
        // from `canSeeDrafts`.
        return this.mapEvents([...upcoming, ...past], { privileged });
    }

    /**
     * The website shape of an event.
     *
     * Its own method so the listing and the single-event page below map through
     * exactly one function. Two copies of this is how a card and the page it
     * opens end up disagreeing about the same row.
     */
    mapEvents(list = [], { privileged = false } = {}) {
        return (list || []).map(e => ({
            id: String(e._id),
            slug: e.slug || '',
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
            ...withJoinLink(pickEventDetail(toEvent(e)), e, privileged),
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
    async listEvent(id, { includeDrafts = false, privileged = false } = {}) {
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
        const [mapped] = this.mapEvents([doc], { privileged });
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
        /*
         * ==================================================================
         * EVERY SCREEN IN THE SIDEBAR, NOT FOUR OF THEM
         * ==================================================================
         *
         * This answered for the header, the home page, About and Contact.
         * Membership, Events, Gallery, News, Regions, Legal and the two
         * inboxes were all missing, so an Overview whose subtitle reads
         * "every section is authored" was making that claim about a third
         * of the site. An editor with an unfinished Membership page was
         * told everything was ready.
         *
         * Counted rather than loaded wherever a count is the whole answer:
         * eleven `findOne`s would be eleven documents fetched to look at
         * one array length each.
         */
        const [
            site, home, about, contact, membership, eventsSettings, gallerySettings,
            newsSettings, gallery, galleryHidden, events, eventsPublished,
            news, schemes, regionPages, statePages, legal,
            messages, unread, leaderMessages, leaderUnread,
        ] = await Promise.all([
            SiteSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            Home.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            About.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            ContactSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            Membership.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            EventsSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            GallerySettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            NewsSettings.findOne({ key: SINGLETON_KEY }).lean().catch(() => null),
            GalleryItem.countDocuments().catch(() => 0),
            GalleryItem.countDocuments({ visible: false }).catch(() => 0),
            Event.countDocuments().catch(() => 0),
            Event.countDocuments({ status: 'published' }).catch(() => 0),
            NewsArticle.countDocuments().catch(() => 0),
            Scheme.countDocuments().catch(() => 0),
            RegionPage.countDocuments().catch(() => 0),
            StatePage.countDocuments().catch(() => 0),
            LegalDocument.countDocuments().catch(() => 0),
            ContactMessage.countDocuments().catch(() => 0),
            ContactMessage.countDocuments({ status: 'new' }).catch(() => 0),
            LeaderMessage.countDocuments().catch(() => 0),
            LeaderMessage.countDocuments({ status: 'new' }).catch(() => 0),
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
            /*
             * The seven screens this used not to answer for.
             *
             * `configured` is the same question everywhere: has an editor put
             * anything in it that the public page needs. A screen whose
             * content is a LIST is configured when the list is not empty; a
             * screen of copy is configured when the copy that leads it exists.
             */
            membership: {
                configured: !!(membership && (membership.title || (membership.advantages || []).length)),
                advantages: ((membership || {}).advantages || []).length,
                steps: ((membership || {}).journey || []).length,
                updatedAt: membership && membership.updatedAt,
            },
            eventsPage: {
                configured: !!(eventsSettings && (eventsSettings.heading || eventsSettings.badgeText)),
                published: eventsPublished,
                categories: ((eventsSettings || {}).categories || []).length,
                updatedAt: eventsSettings && eventsSettings.updatedAt,
            },
            galleryPage: {
                configured: !!(gallerySettings && (gallerySettings.heading || gallerySettings.badgeText)),
                categories: ((gallerySettings || {}).categories || []).length,
                updatedAt: gallerySettings && gallerySettings.updatedAt,
            },
            newsPage: {
                configured: !!(news || schemes),
                articles: news,
                schemes,
                categories: ((newsSettings || {}).categories || []).length,
                updatedAt: newsSettings && newsSettings.updatedAt,
            },
            regions: {
                configured: !!(regionPages || statePages),
                regionPages,
                statePages,
            },
            legalPage: { configured: !!legal, documents: legal },

            gallery: { total: gallery, hidden: galleryHidden },
            events: { total: events },
            messages: { total: messages, unread },
            leaderMessages: { total: leaderMessages, unread: leaderUnread },
        };
    }
}

const service = new CmsService();

/**
 * A seam for the unit tests, and only for them.
 *
 * The cleaners in this file are internal and stay that way — exporting a
 * dozen of them would invite a caller to sanitise on its own and diverge
 * from the write path. `cleanSections` gets one because its rule is a
 * DECISION rather than a format: which rows earn storage, and which are a
 * card the editor merely scrolled past. That rule is worth pinning where it
 * can be read, and a round trip through Mongo is not where anybody reads it.
 */
service.cleanSectionsForTest = cleanSections;

module.exports = service;
