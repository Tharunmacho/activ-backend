const mongoose = require('mongoose');
const { getConnection } = require('../admin/adminsDb');

/**
 * Content for the public onboarding site, stored in `adminsdb`.
 *
 * One collection per page, so a page's content is one document you can read,
 * export or roll back on its own. `activ-db` holds member and application data;
 * marketing copy has a different lifecycle and different editors, and mixing
 * them makes both harder to reason about.
 *
 * Every collection here carries a `web_` prefix. That is not decoration: this
 * database also holds the four admin-account collections, and a client listing
 * collections sorts them alphabetically. Unprefixed, `about` and `home` and
 * `gallery` interleave with `blockadmins` and `stateadmins`, so telling site
 * content apart from staff records means reading the list twice. `web_` sorts
 * after every admin collection, which groups the two sets on screen.
 *
 * The connection falls back to the default one when `adminsdb` cannot be
 * opened, exactly as the admin models do — requiring this file must never throw
 * and take the API down at boot.
 */
const db = getConnection() || mongoose;

/**
 * Singleton key.
 *
 * The site, home, about, gallery, events and contact documents are each
 * one-of-a-kind. Keying them on a constant gives `upsert` something to match,
 * so the first save creates and every later one replaces. Without it a second
 * save creates a second document and the site renders whichever the query
 * happens to return first.
 */
const SINGLETON_KEY = 'default';

const singletonKey = {
    type: String,
    default: SINGLETON_KEY,
    unique: true,
    immutable: true,
};

/** Who last edited, denormalised so the trail survives their account's deletion. */
const editedBy = {
    email: { type: String, default: '' },
    at: { type: Date },
};

/**
 * A picture or a video, plus how it should sit in its frame.
 *
 * `type` is stored rather than guessed from the extension: a CDN URL often has
 * none at all, and rendering a video into an `<img>` shows nothing with no
 * error. `fit` is the editor's answer to "this image is the wrong shape" —
 * `cover` fills and crops, `contain` shows all of it and pads.
 *
 * A factory, not a shared literal: Mongoose takes ownership of the object it is
 * handed, and this one is now used in a dozen places across six schemas.
 */
const media = () => ({
    url: { type: String, trim: true, default: '' },
    type: { type: String, enum: ['image', 'video'], default: 'image' },
    alt: { type: String, trim: true, default: '' },
    fit: { type: String, enum: ['cover', 'contain'], default: 'cover' },
    /** Focal point for `cover`, so a crop does not cut off the subject. */
    position: { type: String, trim: true, default: 'center' },
});

const text = (fallback = '') => ({ type: String, trim: true, default: fallback });

/** A label paired with where it goes. Used by both nav bars and every button. */
const link = () => ({
    label: text(),
    href: text(),
});

/**
 * Fields this schema does not know about, named by the editor.
 *
 * Every page carries one of these lists. The fields a page declares are the ones
 * its LAYOUT depends on — a heading is set in the heading's type, a hero image
 * fills the hero — and no schema can enumerate what an association will want to
 * say next. Rather than guess, each page ends with whatever the editor chose to
 * add: a label and its content, rendered as a plain list in the order entered.
 *
 * A factory for the same reason `media()` is one: Mongoose takes ownership of
 * the object it is handed, and this is now used in six schemas.
 */
const customFields = () => ([{
    label: text(),
    value: { type: String, default: '' },
}]);

/** A figure with a caption and the icon drawn beside it. */
const statItem = () => ({
    icon: text('users'),
    value: text(),
    label: text(),
});

// ============================================================ site chrome

/**
 * The header and footer, which appear on every public page.
 *
 * Separate from the pages because they are not part of any one of them: editing
 * the nav on the Home screen and having it silently differ on Contact is the
 * failure this avoids.
 */
const siteSettingsSchema = new mongoose.Schema({
    key: singletonKey,

    /*
     * The mark and wording. Shared, because the header and the footer show the
     * same organisation — one logo, edited once.
     *
     * `name` (a short form) used to sit here and was rendered by nothing: not
     * the header, not the footer, not a single page. It was a field the CMS
     * asked an editor to fill in and then discarded, so it is gone.
     */
    brand: {
        logo: media(),
        /** The long-form lockup beside the mark, e.g. the full expansion. */
        fullName: text(),
        /** Footer only, under the logo. */
        tagline: text(),
    },

    header: {
        navLinks: [link()],
        ctaLabel: text(),
        ctaHref: text(),
        /*
         * The bar's own colours.
         *
         * Hardcoded in `HeaderSection` as `bg-white` with `#1c2e68` text, so
         * changing them meant a code change and a deploy — which is the one
         * thing a CMS exists to avoid. Stored as hex and applied inline.
         */
        background: text('#ffffff'),
        textColor: text('#1c2e68'),
    },

    footer: {
        addressLines: [{ type: String, trim: true }],
        /** Each rendered as its own column, so a column can be added or dropped. */
        linkColumns: [{
            heading: text(),
            links: [link()],
        }],
        contactHeading: text(),
        phones: [{ type: String, trim: true }],
        email: text(),
        socials: [{
            icon: text('facebook'),
            href: text(),
        }],
        /** `{year}` is substituted at render time so the notice never goes stale. */
        copyright: text(),
        legalLinks: [link()],
        note: text(),
    },

    /** Anything else the editor wants in the footer, as a labelled list. */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_site_settings', timestamps: true });

// ================================================================= home page

/**
 * The home page, as the two blocks it is built from.
 *
 * Sub-documents of one page rather than two collections because they are edited
 * together and rendered together — a half-saved home page with a new carousel
 * and an old About block is not a state worth being able to reach.
 *
 * A `stats` array and a `features` array used to live here. Nothing on the
 * public page rendered them: the figures it shows are `about.statsBar`. Fields
 * with no place on the page are edits that appear to do nothing, so they are
 * gone. Existing documents keep the data harmlessly; it is simply never read.
 */
const homeSchema = new mongoose.Schema({
    key: singletonKey,

    // ---- carousel ----------------------------------------------------------
    carousel: {
        slides: [{
            media: media(),
            caption: text(),
        }],
        headline: text(),
        /** Rendered in the accent colour after the headline, on the same line. */
        headlineHighlight: text(),
        subheadline: text(),
        ctaLabel: text(),
        ctaHref: text(),
        ctaIcon: text('heart'),
        secondaryCtaLabel: text(),
        secondaryCtaHref: text(),
        secondaryCtaIcon: text('play'),

        /**
         * Recent gallery posters, carried by the banner itself.
         *
         * The banner is the first thing on the site and the thing a visitor
         * actually clicks, so the posters belong IN it, not only in the strip
         * further down. These slides are not stored here: they are the gallery's
         * own items, read at render time, and each one links to its own page.
         * Nothing is uploaded twice and nothing can fall out of step — deleting
         * an image in the gallery removes it from the banner in the same act.
         *
         * `limit` is how many join the rotation. `position` decides whether they
         * come before or after the slides authored above, because which one a
         * visitor sees first is an editorial choice: the association's message,
         * or what it has just been doing.
         */
        galleryPosters: {
            enabled: { type: Boolean, default: true },
            limit: { type: Number, default: 6 },
            position: { type: String, enum: ['after', 'before'], default: 'after' },
        },

        /** The card that overlaps the bottom edge of the banner. */
        highlightCard: {
            enabled: { type: Boolean, default: true },
            icon: text('users'),
            eyebrow: text(),
            value: text(),
            caption: text(),
            stats: [statItem()],
        },
    },

    // ---- about block -------------------------------------------------------
    about: {
        badgeIcon: text('users'),
        badgeText: text(),
        heading: text(),
        /** The second line, rendered in the accent colour. */
        headingHighlight: text(),
        /** Kept: older documents wrote the small tracked label here. */
        eyebrow: text(),
        body: { type: String, default: '' },
        /** Each carries its own icon, which is why this is not a string array. */
        bullets: [{
            icon: text('users'),
            text: { type: String, default: '' },
        }],
        media: media(),
        /** The mark that floats over the top-right corner of the photograph. */
        logoOverlay: media(),
        linkLabel: text(),
        linkHref: text(),
        /** The four-figure bar beneath the split layout. */
        statsBar: [statItem()],
        /** Anything else the editor wants said in this block. */
        extraFields: customFields(),
    },

    editedBy,
}, { collection: 'web_home', timestamps: true });

// ================================================================= about page

/**
 * The dedicated About page.
 *
 * Deliberately the same shape as the home page's About block and deliberately
 * its own document: the two render the same layout but are not the same content,
 * and sharing one document would make editing either overwrite the other.
 */
const aboutSchema = new mongoose.Schema({
    key: singletonKey,

    badgeIcon: text('users'),
    badgeText: text(),
    heading: text(),
    headingHighlight: text(),
    body: { type: String, default: '' },
    bullets: [{
        icon: text('users'),
        text: { type: String, default: '' },
    }],
    /** Kept: documents written before bullets carried icons. */
    bulletPoints: [{ type: String, trim: true }],
    media: media(),
    logoOverlay: media(),
    statsBar: [statItem()],

    /** Anything else the editor wants said on this page. */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_about', timestamps: true });

// ================================================================= events page

/** The copy around the events grid; the events themselves live in `Event`. */
const eventsSettingsSchema = new mongoose.Schema({
    key: singletonKey,

    badgeText: text(),
    heading: text(),
    /**
     * The tail of the heading, set in the accent colour.
     *
     * Split from `heading` rather than derived from it. The Events page renders
     * "Our" in white and "Events & Conclaves" in the accent, and the only way
     * to get that from a single string is to guess where to cut — a rule that
     * happens to work for this heading and produces nonsense for the next one
     * an editor types. Gallery, About and Contact already store the two halves
     * separately; this brings Events onto the same shape.
     */
    headingHighlight: text(),
    /** The paragraph under the heading, on the hero band. */
    lede: text(),
    /** Kept: the small centred caption between rules on the HOME page's grid. */
    subtitle: text(),

    /** The photograph in the hero. Empty renders no frame rather than a hole. */
    heroMedia: media(),
    /** The small badge pinned to the hero photograph. */
    heroBadge: {
        enabled: { type: Boolean, default: true },
        icon: text('calendar-days'),
        title: text(),
        subtitle: text(),
    },
    /** The figures across the hero band. */
    stats: [statItem()],

    /** Placeholder for the search box above the grid. */
    searchPlaceholder: text('Search events...'),
    /**
     * The filter chips above the grid. `All` is prepended by the page, so
     * listing it here would render it twice. Each label is matched against an
     * event's `category`.
     */
    categories: [{
        label: text(),
        icon: text('calendar-days'),
    }],

    viewAllLabel: text(),
    viewAllHref: text(),
    /** Shown in place of the grid when nothing is published. */
    emptyText: text(),
    /** Shown when a filter matches nothing. `{query}` is substituted. */
    emptyFilterText: text(),
    /** How many appear on the home page before "see all" takes over. */
    homeLimit: { type: Number, default: 3 },

    /** The call-to-action strip under the grid. */
    banner: {
        enabled: { type: Boolean, default: true },
        icon: text('calendar-days'),
        title: text(),
        subtitle: text(),
        ctaLabel: text(),
        ctaHref: text(),
    },

    /** Anything else the editor wants said on this page. */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_events_settings', timestamps: true });

// ================================================================= gallery

/** The copy around the gallery grid, and the filter chips above it. */
const gallerySettingsSchema = new mongoose.Schema({
    key: singletonKey,

    badgeIcon: text('image'),
    badgeText: text(),
    heading: text(),
    headingHighlight: text(),
    description: text(),
    /** The handwritten note beside the collage, one line per entry. */
    noteLines: [{ type: String, trim: true }],
    /**
     * The filter chips. `All` is prepended by the page, so listing it here
     * would render it twice.
     */
    categories: [{
        label: text(),
        icon: text('image'),
    }],
    viewMoreLabel: text(),
    /** Cards shown before "view more"; 0 shows every one. */
    pageSize: { type: Number, default: 8 },

    /*
     * A `homeSection` block lived here — heading, badge and description for a
     * strip of recent posters between the events grid and the footer. That strip
     * is gone: the posters are carried by the landing BANNER itself
     * (`home.carousel.galleryPosters`), which is the first and largest image on
     * the site and the one a visitor actually clicks. Nothing rendered these
     * fields any more, and a field the CMS asks an editor to fill in and then
     * discards is worse than no field at all.
     */

    /**
     * The copy on a single poster's own page (`/gallery/:id`).
     *
     * Stored, not hardcoded, for the same reason every other label on this site
     * is: "Back to Gallery" is text a visitor reads, and the next editor may
     * want it to say something else in another language.
     */
    detail: {
        backLabel: text('Back to Gallery'),
        aboutHeading: text('About this event'),
        highlightsHeading: text('Highlights'),
        photosHeading: text('More photographs'),
        relatedHeading: text('More from the gallery'),
        ctaLabel: text(),
        ctaHref: text(),
        /** Shown when a link points at an image that is gone or hidden. */
        missingText: text('This item is no longer available.'),
    },

    /** Shown in place of the grid when nothing is published. */
    emptyText: text(),
    /**
     * Shown when a filter matches nothing. `{category}` is replaced with the
     * chip the visitor picked, so one line covers every filter.
     */
    emptyFilterText: text(),

    /** Anything else the editor wants said on this page. */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_gallery_settings', timestamps: true });

const galleryItemSchema = new mongoose.Schema({
    media: media(),
    title: text(),
    caption: text(),
    /** Matches a chip in `gallerySettings.categories`; blank means All only. */
    category: text(),
    /** Free text, not a Date: these read "20 Jan 2024" and are not sorted on. */
    eventDate: text(),
    location: text(),

    /**
     * The write-up shown on the poster's own page.
     *
     * A card in the grid shows a title and a date; this is what the visitor came
     * to read once they clicked it. Long-form, so no `trim`-only helper: an
     * editor's paragraph breaks are content.
     */
    description: { type: String, default: '' },
    /** Short bullet points beside the write-up. One line each. */
    highlights: [{ type: String, trim: true }],
    /**
     * Further photographs from the same event, shown under the poster.
     *
     * These belong to the item rather than to the grid — an event has one
     * poster and a dozen photographs, and putting all thirteen in the grid is
     * what makes a gallery unreadable.
     */
    photos: [media()],

    /**
     * Details this schema does not know about, named by the editor.
     *
     * The fields above are the ones the LAYOUT depends on: the date and the
     * place have their own icons in the side card, the title is the heading, the
     * poster is the picture. Everything else an association wants to record
     * about an event — the chief guest, the host chapter, who sponsored it, how
     * many attended — is theirs to name, and a schema that tried to enumerate
     * them would be wrong by the next event.
     *
     * A pair rather than a free-text blob, because the page renders them as a
     * labelled list. An entry with no label and no value is dropped rather than
     * stored: the editor's list starts each new row empty.
     */
    customFields: [{
        label: text(),
        value: { type: String, default: '' },
    }],

    /** The three collage frames at the top of the page draw from these. */
    featured: { type: Boolean, default: false, index: true },

    /**
     * Goes to the front of the queue — in the banner AND in the gallery grid.
     *
     * Distinct from `featured`, which fills a collage frame on the gallery page
     * and nothing else, and from `showOnHome`, which decides *whether* an item
     * is in the banner rather than *where*. This is "the event we want people to
     * see first", and it is the only one of the three that affects both
     * surfaces, so a newly finished conclave leads the site everywhere at once.
     *
     * Several pinned items keep their normal order relative to one another —
     * newest first — so pinning everything is the same as pinning nothing,
     * which is the right failure mode for a flag an editor will forget to unset.
     */
    pinned: { type: Boolean, default: false, index: true },
    /**
     * Rides in the landing page's banner.
     *
     * Defaults to true, so posting to the gallery puts an event on the home
     * page without a second step — which is the behaviour that was asked for.
     * An editor turns it off for the ones that should live on the gallery page
     * only.
     */
    showOnHome: { type: Boolean, default: true, index: true },

    /** Explicit, so the grid can be rearranged without deleting and re-adding. */
    sortOrder: { type: Number, default: 0, index: true },
    /** Hidden rather than deleted, so a removed image can come back. */
    visible: { type: Boolean, default: true, index: true },

    editedBy,
}, { collection: 'web_gallery', timestamps: true });

galleryItemSchema.index({ visible: 1, sortOrder: 1, createdAt: -1 });
/** The landing banner's query: visible, flagged for home, newest first. */
galleryItemSchema.index({ visible: 1, showOnHome: 1, createdAt: -1 });

// ================================================================= contact

const contactSettingsSchema = new mongoose.Schema({
    key: singletonKey,

    // ---- page heading ------------------------------------------------------
    badgeIcon: text('users'),
    badgeText: text(),
    heading: text(),
    headingHighlight: text(),
    description: text(),
    /** The two overlapping frames beside the heading. */
    heroMedia: [media()],

    // ---- the two cards -----------------------------------------------------
    formCard: {
        icon: text('send'),
        title: text(),
        subtitle: text(),
        submitLabel: text(),
        successMessage: text(),

        /**
         * The wording inside the form.
         *
         * The FIELDS are fixed — they are what the API accepts, and letting an
         * admin add one would build a form the backend rejects. What each field
         * is CALLED is a different matter: it is text a visitor reads, so it is
         * text an admin can change.
         */
        namePlaceholder: text(),
        emailPlaceholder: text(),
        phonePlaceholder: text(),
        subjectPlaceholder: text(),
        messagePlaceholder: text(),

        /** Shown when a required field is left empty, before anything is sent. */
        validationMessage: text(),
        /** Shown when the request itself fails, in place of a raw error. */
        failureMessage: text(),
    },
    infoCard: {
        icon: text('users'),
        title: text(),
        subtitle: text(),
        /** The heading above each detail, so they are not frozen in the markup. */
        addressLabel: text(),
        phoneLabel: text(),
        emailLabel: text(),
        hoursLabel: text(),
    },

    // ---- the details themselves --------------------------------------------
    addressLines: [{ type: String, trim: true }],
    phone: text(),
    alternatePhone: text(),
    email: { type: String, trim: true, lowercase: true, default: '' },
    workingHours: [{ type: String, trim: true }],
    mapEmbedUrl: text(),

    social: {
        facebook: text(),
        instagram: text(),
        linkedin: text(),
        youtube: text(),
    },

    // ---- the strip at the foot of the page ---------------------------------
    banner: {
        enabled: { type: Boolean, default: true },
        icon: text('users'),
        title: text(),
        subtitle: text(),
        ctaLabel: text(),
        ctaHref: text(),
    },

    /** Extra contact rows the editor named themselves. */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_contact_settings', timestamps: true });

// ================================================================= messages

const contactMessageSchema = new mongoose.Schema({
    name: { type: String, trim: true, required: true },
    email: { type: String, trim: true, lowercase: true, required: true },
    phone: text(),
    subject: text(),
    message: { type: String, trim: true, required: true },

    status: { type: String, enum: ['new', 'read', 'archived'], default: 'new', index: true },

    /** Kept for abuse triage: the one endpoint anyone at all can write to. */
    meta: {
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
    },
}, { collection: 'web_contact_messages', timestamps: true });

contactMessageSchema.index({ status: 1, createdAt: -1 });
contactMessageSchema.index({ createdAt: -1 });

/**
 * Every icon the public pages can draw.
 *
 * One list rather than one per block: an editor choosing an icon for a footer
 * social link and one choosing for a stat are making the same kind of choice,
 * and a name the renderer does not know falls back rather than rendering a
 * hole. Adding a name here also requires adding it to the website's `ICONS`
 * map — the fallback is what keeps that mismatch harmless.
 */
const ICON_NAMES = [
    // people and organisations
    'users', 'user', 'handshake', 'heart-handshake', 'building', 'briefcase',
    // growth and outcomes
    'trending-up', 'award', 'target', 'lightbulb', 'star', 'heart', 'rocket',
    // trust
    'shield', 'shield-check', 'scale',
    // place and time
    'globe', 'map-pin', 'calendar', 'calendar-days', 'clock',
    // events and media
    'image', 'images', 'monitor-play', 'play', 'tent', 'book-open', 'hard-hat',
    'grid', 'party-popper', 'mic',
    // contact
    'phone', 'mail', 'message-square', 'send', 'file-text',
    // navigation
    'arrow-right', 'external-link', 'home',
    // social — used by the footer
    'facebook', 'instagram', 'linkedin', 'twitter', 'youtube',
];

/** Kept as its own export: the feature cards were shipped against this name. */
const FEATURE_ICONS = ICON_NAMES;

module.exports = {
    SINGLETON_KEY,
    ICON_NAMES,
    FEATURE_ICONS,
    SiteSettings: db.model('CmsSiteSettings', siteSettingsSchema),
    Home: db.model('CmsHome', homeSchema),
    About: db.model('CmsAbout', aboutSchema),
    EventsSettings: db.model('CmsEventsSettings', eventsSettingsSchema),
    GallerySettings: db.model('CmsGallerySettings', gallerySettingsSchema),
    GalleryItem: db.model('CmsGalleryItem', galleryItemSchema),
    ContactSettings: db.model('CmsContactSettings', contactSettingsSchema),
    ContactMessage: db.model('CmsContactMessage', contactMessageSchema),
};
