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

/**
 * ============================================================================
 * A FIELD THE EDITOR NAMED — ON ANY PAGE IN THE CMS
 * ============================================================================
 *
 * One shape for every "Your own fields" list on the site: the gallery album
 * and each of its photographs, the zone and state pages, the schemes, the
 * events, the news, the membership prospectus and each removable section.
 * `customFields()` below is this, as a list.
 *
 * It started as the gallery's alone. Rolling it out is a one-line change here
 * because every one of those schemas already went through `customFields()` —
 * and that is the whole reason it was a factory.
 *
 * The fields a page DECLARES are the ones its layout depends on — the date
 * and the place have their own icons, the title is the heading, the picture is
 * the picture. This is everything else an association wants to record, named
 * by them, and a schema that tried to enumerate it would be wrong by the next
 * event.
 *
 * `icon`      a name from `ICON_NAMES`, chosen by the editor.
 *
 *             It is asked for rather than guessed. These are drawn in a card
 *             beside Date and Location, which are illustrated, so a field with
 *             no mark left an empty circle next to it — reported twice, on the
 *             album card and on the photograph's. A glyph cannot be inferred
 *             from a label somebody typed a moment ago; `info` is the default
 *             and it is a real mark rather than a hole.
 *
 * `placement` WHERE on the page it goes, and this is the one that was missing.
 *
 *             Every named field went into the side card, so an editor who
 *             wanted to add a section of writing — a note on the venue, a list
 *             of sponsors, a paragraph of thanks — could only put a paragraph
 *             into a card built for one-line facts. Reported as "the custom
 *             fields are created only for the cards, not the content".
 *
 *               `card`    a labelled fact in the side card, with its icon.
 *               `content` a section of its own in the body, the label as the
 *                         heading and the value as the prose under it — the
 *                         same treatment the scheme page gives its own fields.
 *
 *             Defaulted to `card`, because that is where every existing row
 *             already appears and a default that moved them would rearrange
 *             live pages nobody had edited.
 */
const namedField = () => ({
    label: text(),
    value: { type: String, default: '' },
    icon: text('info'),
    placement: { type: String, enum: ['card', 'content'], default: 'card' },
});


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
const customFields = () => ([namedField()]);

/**
 * ==========================================================================
 * WHAT THE EDITOR DID TO A SECTION — removed it, or added fields to it
 * ==========================================================================
 *
 * `customFields` above answers "what else does this PAGE want to say". This
 * answers the same question one card down: what else does this SECTION want to
 * say, and does the editor want this section at all.
 *
 * Both were asked for, and by the same reasoning. A CMS screen is a fixed run
 * of cards — Headline, Buttons, Slides — and an association that does not run
 * a Buttons row had no way to say so: they could blank the two labels and
 * learn from the public page that blanking is what hides it. "Remove" is the
 * word for that, and it belongs on the card.
 *
 * An ARRAY keyed by `key`, not a Map or a free object:
 *
 *   - Mongoose validates each entry, so a malformed row cannot reach disk;
 *     a `Mixed` object would accept anything and silently keep it forever.
 *   - The key is a slug this repo writes (`carousel.buttons`), never editor
 *     input, so there is no escaping question and no key collision.
 *   - An unknown key is simply a row nothing reads. That is what makes this
 *     safe to remove a card in code later: the override is inert, not an
 *     error, and the section it named can come back under the same key with
 *     its fields intact.
 *
 * `hidden` is the ONLY thing that takes a section off the public page. The
 * fields inside a removed section are kept, not deleted — an editor who
 * removes a card and restores it the next morning should find their work.
 */
const sectionOverrides = () => ([{
    /** A slug this code owns, e.g. `carousel.slides`. Never editor input. */
    key: text(),
    /** Off the public page. The card stays on the CMS screen, collapsed. */
    hidden: { type: Boolean, default: false },
    /**
     * THE EDITOR'S OWN NAME FOR THIS SECTION, where they gave one.
     *
     * Blank means "use the heading this code ships", which is every row that
     * has ever been written — so an absent value can never be mistaken for a
     * deliberately blank heading, and nothing has to be migrated.
     *
     * It renames the CARD, on the CMS screen — not the public page. Every
     * heading a visitor reads is already its own field on that card ("Heading",
     * "Eyebrow", "Badge"), and having two places that both set one heading is
     * the arrangement where they disagree. This is the editor's own label for
     * the part of the screen, so a card called "Filter chips" can be called
     * what the association calls it.
     *
     * `key` is NOT derived from it and never changes: the key is the slug this
     * repo owns, and it is what ties the card to the part of the page it
     * controls. Deriving it from a title would orphan the card's hidden flag
     * and its fields the first time somebody corrected a typo.
     */
    title: text(),
    /** The editor's own rows, rendered where this section renders. */
    fields: customFields(),
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

    /**
     * ======================================================================
     * THE BAND ABOVE THE FOOTER, ON EVERY PAGE
     * ======================================================================
     *
     * "Across India / Find ACTIV where you are", over the region tiles. The
     * TILES are built from the region pages and are not authored here — a
     * region appears in them the moment its page is published. The WORDING
     * over them was two string literals in the component, on seven pages,
     * which is the one thing this CMS exists to stop.
     *
     * It lives on the site settings rather than on the home page because it
     * is not the home page's: About, Membership, Events, News, Gallery and
     * Contact all draw it, directly above the footer. The Home screen shows
     * it and says where it is edited, the way the header's Regions menu
     * does — an editor should be able to see everything a page holds from
     * the screen named after that page, even what another screen owns.
     */
    acrossIndia: {
        enabled: { type: Boolean, default: true },
        eyebrow: text('Across India'),
        heading: text('Find ACTIV where you are'),
        subtitle: text(''),
        /**
         * Region keys the band does NOT draw.
         *
         * A deny list, not an allow list, and the direction is load-bearing.
         * The tiles are derived: a region appears the moment its page is
         * published, which is the behaviour the association asked for. An
         * allow list would make every new region invisible until somebody
         * remembered to tick it — a publish that silently does nothing.
         *
         * It is on the SITE settings rather than on each region page
         * because it is a fact about this BAND, not about the region: a
         * region left out here still has its page, its menu entry and its
         * own leadership. Only the tile is gone.
         */
        hidden: [{ type: String, trim: true }],
    },

    /** Anything else the editor wants in the footer, as a labelled list. */
    extraFields: customFields(),
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

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
            /*
             * `limit` used to cap this at six.
             *
             * Gone for the reason `homeLimit` is: the per-image switch on
             * the gallery item answers the same question, and an editor
             * switching nine images on saw six with nothing saying which
             * three were dropped. `position` stays — where the posters sit
             * against the authored slides is a layout choice, not a cap.
             */
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

    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

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

    /**
     * ======================================================================
     * THE CHAIRMAN’S WORDS — the one thing on the page written by a person
     * ======================================================================
     *
     * Every other field here describes the association in the third person:
     * what it is, how many members, which sectors. This is the one place it
     * speaks in the first, and it is what a visitor should read before any
     * of the rest — an association is people, and a paragraph of prose
     * about "a non-government, non-profit business association" is not.
     *
     * A quote is FOUR fields and not one. A blob of text with the name typed
     * into the end of it cannot be drawn as a pull-quote: the page sets the
     * words large and the attribution small, and it cannot tell them apart
     * if they arrive as one string. It is also how the same words end up on
     * a card, in a meta tag or in a newsletter later without being re-typed.
     *
     * ALL OPTIONAL, like everything else on these pages. A quote with no
     * portrait is a quote; a page with no quote simply does not draw the
     * block. Nothing here is required and nothing is invented to fill it.
     */
    quote: {
        /** The words themselves, without quotation marks — the page draws those. */
        text: { type: String, default: '' },
        /** Who said them. */
        author: text(),
        /** "National Chairman, ACTIV" — printed under the name. */
        role: text(),
        photo: media(),
    },

    /** Anything else the editor wants said on this page. */
    extraFields: customFields(),
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

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
        /**
         * WHICH KIND OF EVENT THIS CATEGORY IS FOR.
         *
         * `both` unless somebody says otherwise, which is the honest default: a
         * Workshop or a Conference happens in a room or on a link, and most of
         * the list is like that.
         *
         * The two narrower values are what stop a category being offered where
         * it makes no sense — "ZOOM" and "Webinars" on an event people are
         * driving to, "Tea party" and "Club House" on a video call. Those four
         * are in the live list today, and an editor with no way to say which
         * kind a category belongs to is how they got there: `mode` on the EVENT
         * answers "is there a room", and `mode` on the CATEGORY answers "may
         * this label be offered for that kind of event".
         *
         * It narrows what the form OFFERS. It never rewrites what an event
         * already carries — the same rule the chip list already follows for a
         * label it no longer lists.
         */
        mode: {
            type: String,
            enum: ['both', 'online', 'offline'],
            default: 'both',
        },
    }],

    viewAllLabel: text(),
    viewAllHref: text(),
    /** Shown in place of the grid when nothing is published. */
    emptyText: text(),
    /** Shown when a filter matches nothing. `{query}` is substituted. */
    emptyFilterText: text(),
    /** How many appear on the home page before "see all" takes over. */
    /*
     * `homeLimit` used to live here and capped the home strip at three.
     *
     * It is gone because the per-event switch answers the same question
     * and answers it better: an editor who turned five events on saw
     * three, with nothing on either screen explaining which two had been
     * dropped or why. Two controls for one decision, and the one being
     * used lost. The strip now carries every upcoming event with
     * `showOnHome` set — see the note on that field.
     */

    /**
     * Where a visitor is sent for events that have already happened.
     *
     * The events page is upcoming events only now. A visitor who came
     * looking for last year's conclave finds nothing and no explanation,
     * which reads as a page that lost its content rather than as one that
     * never held it — so the page says where it went, in the editor's own
     * words and pointing wherever they choose.
     */
    pastLink: {
        enabled: { type: Boolean, default: true },
        icon: text('image'),
        title: text('Looking for an event that has already happened?'),
        subtitle: text('Every conclave, seminar and meeting we have held is in the gallery, with its photographs.'),
        label: text('Open the gallery'),
        href: text('/gallery'),
    },

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
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

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

    /**
     * The band saying what this page IS.
     *
     * The gallery reads as decoration — pictures from things that happened —
     * until somebody says that is exactly the point: this is the record of
     * every past event, and it is where the events page now sends people
     * looking for one. A visitor cannot infer that from a grid of
     * photographs, so the page states it.
     */
    pastEvents: {
        enabled: { type: Boolean, default: true },
        icon: text('calendar-days'),
        title: text('Our past events'),
        subtitle: text('Every conclave, seminar and meeting we have held — open one for its photographs, the write-up and where it was.'),
    },

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
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

    editedBy,
}, { collection: 'web_gallery_settings', timestamps: true });

const galleryItemSchema = new mongoose.Schema({
    media: media(),
    title: text(),
    caption: text(),
    /** Matches a chip in `gallerySettings.categories`; blank means All only. */
    category: text(),

    /**
     * WHERE THIS PHOTOGRAPH BELONGS, for the region and state pages.
     *
     * Both optional, and both blank on every row that predates them — an
     * untagged photograph appears in the unfiltered gallery and in no region or
     * state filter, which is the honest answer for a photograph nobody has said
     * anything about.
     *
     * `region` is DERIVED from `state` when a state is given. Asking an editor
     * for both invites the pair that disagree, and then the photograph is in
     * Kerala's gallery and the North's.
     */
    state: text(),
    region: text(),
    /** Free text beside `category`, as the reference's second dropdown. */
    sector: text(),
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
     * THE ALBUM'S PHOTOGRAPHS.
     *
     * A gallery item is an album: `media` is its cover — the one picture the
     * gallery grid shows — and these are the photographs inside it, each with
     * its own description. Opening the album shows them all; opening one shows
     * it large with its description, and the reader steps through the rest.
     *
     * `caption` is per photograph, added for exactly that viewer; rows saved
     * before it existed simply have none.
     */
    /**
     * ======================================================================
     * ONE PHOTOGRAPH OF THE ALBUM, AND IT IS A RECORD OF ITS OWN
     * ======================================================================
     *
     * Each has a page at `/gallery/:id/photo/:n`, so it needs what a page
     * needs: a name, something to read, and whatever else the association
     * wants recorded about THAT picture.
     *
     * `title`  what to call it — the heading on its page and the label in
     *          the album's row. Absent, the `caption` stands in; absent
     *          both, the page says "Untitled photograph" rather than
     *          borrowing the album's name and claiming to be the whole event.
     *
     * `caption` the one line under the heading. It predates `title` and every
     *          existing row has one, which is why it is not renamed: a
     *          migration that moved this into `title` would have to guess
     *          whether a paragraph an editor wrote was meant as a heading.
     *
     * `description` the write-up, printed as "About this photograph". The same
     *          three tiers the ALBUM carries — name, one line, then the body —
     *          because a photograph's page is the album's page one level down
     *          and an editor who has filled in one already knows the other.
     *
     * `customFields` the SAME pairs the album itself carries — "Photographer",
     *          "Chief Guest", "Sponsor" — but about this one picture. The
     *          fields above are the ones the LAYOUT depends on; everything
     *          else an association wants to say is theirs to name, and a
     *          schema that tried to enumerate them would be wrong by the next
     *          event. Exactly the reasoning on the album's own `customFields`,
     *          one level down.
     *
     *          See `namedField` for the icon and for where each one goes.
     */
    photos: [{
        ...media(),
        title: { type: String, trim: true, default: '' },
        caption: { type: String, trim: true, default: '' },
        description: { type: String, default: '' },
        customFields: [namedField()],
    }],

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
    customFields: [namedField()],

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

    /**
     * The event this was made from, where it was made from one.
     *
     * Set by “Send to the gallery” on a finished event. It is what makes a
     * second press an UPDATE rather than a duplicate — an editor who fixes
     * the event's write-up and presses again should get the correction,
     * not a second copy of the same afternoon.
     *
     * Sparse, because almost every gallery item is posted directly and has
     * no event behind it.
     */
    fromEventId: { type: String, default: '', index: true, sparse: true },

    /** Explicit, so the grid can be rearranged without deleting and re-adding. */
    sortOrder: { type: Number, default: 0, index: true },
    /** Hidden rather than deleted, so a removed image can come back. */
    visible: { type: Boolean, default: true, index: true },

    editedBy,
}, { collection: 'web_gallery', timestamps: true });

galleryItemSchema.index({ visible: 1, sortOrder: 1, createdAt: -1 });
/** The landing banner's query: visible, flagged for home, newest first. */
galleryItemSchema.index({ visible: 1, showOnHome: 1, createdAt: -1 });

// ============================================================= membership

/**
 * ============================================================================
 * THE MEMBERSHIP PROSPECTUS — the last page that was typed into the bundle
 * ============================================================================
 *
 * "ACTIV Membership Advantage" lived in `membershipContent.ts`, as a typed
 * table, and the reason given there was a real one: it is a fixed document
 * the association approved, with a shape no generic editor expresses —
 * fifteen numbered advantages, each with a lead-in, a list, an emphasised
 * one-liner and paragraphs on either side; a seven-step journey; a closing
 * call. Flattening that into headings and bullets would lose it.
 *
 * That note also said what to do when the association wanted to revise the
 * copy themselves: "a CMS document SHAPED LIKE `ADVANTAGES` — not a looser
 * one". This is that document, field for field, so the page renders from the
 * database exactly as it rendered from the table and nothing about the
 * layout has to be re-decided.
 *
 * NOTHING IS REQUIRED and nothing is invented. An advantage with a title and
 * no bullets is an advantage part-way written, which is the normal state of
 * a document being revised.
 */

/** One of the fifteen numbered advantages. */
const advantageSchema = () => ({
    /** The anchor the contents list at the top of the page links to. */
    slug: text(),
    /** "01" … "15", printed as typed — not derived from the position, so a
        section can be reordered without renumbering the whole document. */
    number: text(),
    icon: text('award'),
    title: text(),
    /** The line under the title. */
    subtitle: text(),
    /** Paragraphs above the list. */
    body: [{ type: String, trim: true }],
    /** The sentence that introduces the list. Blank when there is none. */
    listLead: text(),
    bullets: [{ type: String, trim: true }],
    /**
     * The emphasised one-liner, drawn BEFORE `after` — section 6 is the only
     * one carrying both and has them in that order in the document.
     */
    closing: { type: String, default: '' },
    /** Paragraphs below the list. */
    after: [{ type: String, trim: true }],
    displayOrder: { type: Number, default: 0 },
    isHidden: { type: Boolean, default: false },
});

/** A step of the membership journey, and an entry in "why it matters". */
const stepSchema = () => ({
    /** "Step 01" — printed as typed, on the journey only. */
    step: text(),
    icon: text('circle-check'),
    title: text(),
    text: { type: String, default: '' },
    displayOrder: { type: Number, default: 0 },
    isHidden: { type: Boolean, default: false },
});

/** A heading, a sub-heading, a lead-in and a list — three sections share it. */
const blurbSchema = () => ({
    heading: text(),
    subtitle: text(),
    lead: { type: String, default: '' },
    bullets: [{ type: String, trim: true }],
});

const membershipSchema = new mongoose.Schema({
    key: singletonKey,

    /* ---------------------------------------------------- the opening */
    eyebrow: text(),
    title: text(),
    tagline: text(),
    /**
     * The opening heading, in two halves.
     *
     * Set like the About page’s: the first clause in near-black and the rest
     * in the brand colour. Two fields and not one, because a `.split()` in
     * the page would be this sentence’s punctuation deciding the layout.
     */
    subtitleLead: text(),
    subtitleRest: text(),
    body: [{ type: String, trim: true }],

    /* ------------------------------------------------- the four blocks */
    whyJoin: blurbSchema(),
    whoShouldJoin: blurbSchema(),

    advantages: [advantageSchema()],

    journeyEyebrow: text(),
    journeyHeading: text(),
    journeySubtitle: text(),
    journey: [stepSchema()],

    mattersHeading: text(),
    mattersSubtitle: text(),
    whyItMatters: [stepSchema()],

    /*
     * ----------------------------------------------------- the closing
     *
     * ELEVEN FIELDS, and every one of them is on the page.
     *
     * The closing is not a heading and a button. It is a heading in two
     * halves, two short lines set as a couplet, a note under them, a
     * call with five lines of its own, a statement of what the
     * association is, an invitation, and the two ways to enquire.
     *
     * A schema with `closingHeading` and `closingBody` would have taken
     * the other nine and dropped them on the first save — silently, the
     * way Mongoose strict mode always does. They are listed because they
     * exist, not because a generic "closing block" needed filling out.
     */
    closingHeading: text(),
    /** The second half, set in the brand colour. */
    closingHeadingHighlight: text(),
    closingBody: [{ type: String, trim: true }],
    closingNote: { type: String, default: '' },

    callHeading: text(),
    /** "Connect with Entrepreneurs." … each on its own line. */
    callLines: [{ type: String, trim: true }],

    /** What the association is, in one sentence. */
    statement: { type: String, default: '' },
    invitation: { type: String, default: '' },

    enquiriesHeading: text(),
    website: text(),
    email: text(),

    ctaLabel: text(),
    ctaHref: text(),

    /** Anything else the association wants on this page. */
    extraFields: customFields(),
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

    editedBy,
}, { collection: 'web_membership', timestamps: true });

// =================================================================== news

/**
 * ============================================================================
 * NEWS AND SCHEMES — two collections, because they are two different things
 * ============================================================================
 *
 * A NEWS ARTICLE is something that happened, on a date, with a photograph and
 * a headline. It ages: the newest is the one a reader wants and last year’s is
 * archive.
 *
 * A SCHEME is something a member can apply to. It does not age the same way —
 * a scheme open since 2019 is as current as one announced yesterday — and the
 * question a reader asks of it is not "what is new" but "which of these apply
 * to ME", which is a question about WHERE they are.
 *
 * Sharing one collection with a `type` field would mean every list query
 * filtering on it, every index carrying it, and a scheme sorted by date into
 * the middle of the news. They are separate.
 */

/**
 * ONE NEWS ARTICLE.
 *
 * The shape a newspaper uses: a picture, a headline, a standfirst, a body, a
 * date and where it happened. Nothing here is required — an article is
 * written over several sittings and a form that refuses to save without a
 * date is a form with "TBC" typed into it. `status` carries readiness.
 */
const newsArticleSchema = new mongoose.Schema({
    /** The URL segment. Derived from the title on save; never sent by a client. */
    slug: { type: String, trim: true, unique: true, index: true },

    title: text(),
    /**
     * The standfirst — the bold paragraph under a headline.
     *
     * Printed on the card in the grid AND at the top of the article, so it is
     * the one line that has to work out of context.
     */
    summary: { type: String, default: '' },
    /** The article itself. Paragraph breaks are content; not trimmed per line. */
    body: { type: String, default: '' },

    image: media(),
    /** Further pictures, shown under the article. */
    photos: [media()],

    /**
     * ======================================================================
     * A LINK OFF THE SITE, AND WHAT IT DOES TO THE CARD
     * ======================================================================
     *
     * An association posts two kinds of news: what it wrote, and what
     * somebody else published about it. The second is a headline, a
     * photograph and a link — a video, a newspaper, a ministry notice — and
     * the reader wants to land THERE, not on a page here that says "read
     * more at".
     *
     * So an article with `externalUrl` opens it, in a new tab, and never
     * renders a detail page of its own. One field decides both, which is why
     * it is one field: a separate "open externally" switch could be set
     * without a URL, or a URL left with the switch off, and both of those are
     * a card that does nothing when it is clicked.
     */
    externalUrl: text(),
    /** "The Hindu", "PIB", "YouTube" — printed on the card so the link is honest. */
    sourceName: text(),

    /** Free text, as the galleries use: "20 Jan 2026". Printed, never sorted on. */
    displayDate: text(),
    /**
     * What the list is ORDERED by, and the one date that is a real date.
     *
     * `null`, never the epoch: an article nobody has dated is undated, and a
     * missing date standing in as 1970 files it at the far end of the past.
     * Undated articles lead the list — something with no date has just been
     * written.
     */
    publishedAt: { type: Date, default: null, index: true },

    category: text(),
    location: text(),

    /**
     * WHERE THIS IS NEWS, on the same three tiers the schemes use.
     *
     * All blank means national — news about the association as a whole — and
     * that is the common case, so it is the default rather than something an
     * editor has to select.
     */
    state: text(),
    district: text(),

    /** Leads the page, in the tall card at the top. */
    featured: { type: Boolean, default: false, index: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    sortOrder: { type: Number, default: 0 },

    /**
     * Fields the editor named themselves — “Photographer”, “First published
     * in”, “Correction”. Printed as labelled rows under the article.
     *
     * The fixed fields above are the ones the LAYOUT knows: the headline is
     * the heading, the date orders the list. Anything the layout has no
     * opinion about belongs here rather than in a new column nobody else
     * will ever fill in.
     */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_news', timestamps: true });

/** The list query: published, newest first, undated at the front. */
newsArticleSchema.index({ status: 1, publishedAt: -1, createdAt: -1 });
newsArticleSchema.index({ status: 1, featured: 1 });
newsArticleSchema.index({ state: 1, district: 1 });

/**
 * ONE SCHEME, at one of three tiers.
 *
 * `tier` is the field everything reads, and it is stored rather than derived
 * from whether `state` is filled in. A national scheme administered from
 * Chennai has a state on it and is still national; deriving the tier would
 * file it under Tamil Nadu and hide it from everybody else.
 */
const schemeSchema = new mongoose.Schema({
    slug: { type: String, trim: true, unique: true, index: true },

    title: text(),
    summary: { type: String, default: '' },
    body: { type: String, default: '' },

    tier: {
        type: String,
        enum: ['national', 'state', 'district'],
        default: 'national',
        index: true,
    },
    /** Read only when the tier says to. See the note on `tier`. */
    state: text(),
    district: text(),

    /** The ministry, department or council that runs it. */
    authority: text(),
    /** One line: "Registered MSMEs with under 50 employees". */
    eligibility: { type: String, default: '' },
    /** Free text: "Open", "Closes 31 Mar 2026". Not a date, and not sorted on. */
    deadline: text(),

    /** Where to apply. Opens in a new tab, like a news article’s link. */
    applyUrl: text(),
    /** A downloadable notification or form. */
    documentUrl: text(),
    icon: text('file-text'),

    /*
     * THE DETAIL PAGE's fields. The card prints the summary and eligibility;
     * "View more" opens `/schemes/view/:slug`, which prints these as their
     * own sections. Each is a separate field rather than one long body
     * because they answer different questions a reader scans for — "what do
     * I get", "how do I apply", "what must I bring" — and a single text box
     * leaves the editor to invent that structure again for every scheme.
     */
    /** A sector tag: "Credit", "Subsidy", "Skills". Printed as a chip. */
    category: text(),
    /** What the member receives. Blank lines separate paragraphs. */
    benefits: { type: String, default: '' },
    /** The steps, one per line. Printed as a numbered list. */
    howToApply: { type: String, default: '' },
    /** One document per entry. Printed as a checklist. */
    documentsRequired: [{ type: String, trim: true }],
    /** A helpline or office to ask — free text, printed as written. */
    helpline: text(),
    /** A picture across the top of the detail page. Optional. */
    image: media(),
    /** Pinned to the top of its list. */
    featured: { type: Boolean, default: false },

    status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
    sortOrder: { type: Number, default: 0 },

    /**
     * Fields the editor named themselves — “Circular no.”, “Sanctioned by”,
     * “Subsidy”, “Superseded by”. Printed as labelled rows on the scheme.
     *
     * A scheme is a government instrument and every department describes
     * one differently; a fixed set of columns is a set that is wrong for
     * the next one.
     */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_schemes', timestamps: true });

schemeSchema.index({ status: 1, tier: 1, sortOrder: 1 });

/**
 * The Schemes page's own copy — `/schemes`.
 *
 * Its own singleton, not more keys on the news settings: the schemes left the
 * newsroom and have their own screen in the CMS, and a page whose wording is
 * edited on another page's screen is a page an editor cannot find.
 */
const schemeSettingsSchema = new mongoose.Schema({
    key: { type: String, default: SINGLETON_KEY, unique: true },

    badgeIcon: text('landmark'),
    badgeText: text('Schemes'),
    heading: text('Government schemes for'),
    headingHighlight: text('our members'),
    description: { type: String, default: '' },
    heroImage: media(),

    /** The two cards on the landing page. */
    centralLabel: text('Central schemes'),
    centralDescription: text('Run by the Government of India, open to members in every state.'),
    stateLabel: text('State schemes'),
    stateDescription: text('Run by a state government, with district schemes inside each state.'),

    /** The line printed where a list has nothing in it yet. */
    emptyMessage: text(),

    sections: sectionOverrides(),
    editedBy,
}, { collection: 'web_scheme_settings', timestamps: true });

/** The page’s own copy — the band, the headings, the empty states. */
const newsSettingsSchema = new mongoose.Schema({
    key: { type: String, default: SINGLETON_KEY, unique: true },

    badgeIcon: text('newspaper'),
    badgeText: text('Newsroom'),
    heading: text('What is happening at'),
    headingHighlight: text('ACTIV'),
    description: { type: String, default: '' },
    heroImage: media(),

    /** The chips over the grid. Blank list means no filter row is drawn. */
    categories: [{ type: String, trim: true }],

    schemesHeading: text('Schemes & Benefits'),
    schemesDescription: { type: String, default: '' },

    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

    editedBy,
}, { collection: 'web_news_settings', timestamps: true });

// ================================================================= contact

galleryItemSchema.index({ state: 1 });
galleryItemSchema.index({ region: 1 });

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

    /*
     * THE REGIONS BAND, as the Contact page draws it.
     *
     * The same six tiles as every other page's "Across India" band, with two
     * differences: its own wording, and each tile opens that region's or
     * state's GET IN TOUCH section rather than the top of its leadership page.
     * A reader on the Contact page is looking for somebody to call.
     */
    regionsBand: {
        enabled: { type: Boolean, default: true },
        eyebrow: text(),
        heading: text(),
        subtitle: text(),
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
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),

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


// ====================================================== a message to a leader

/**
 * ==========================================================================
 * SOMEBODY IN A DISTRICT ASKING TO BE PUT IN TOUCH WITH THEIR LEADER
 * ==========================================================================
 *
 * Not the contact form, and it is worth being clear why they are two
 * collections rather than one with a flag.
 *
 * The contact form is one destination: the association. This is addressed to
 * a PERSON, and the whole value of the record is the pair — who wrote, and
 * whom they were reading about — plus the geography that put those two on
 * the same page. A member in Tiruvannamalai writing to the Tiruvannamalai
 * chairman is a lead for a Tiruvannamalai scheme; the same words with the
 * leader and the district stripped out are an enquiry nobody can act on.
 *
 * NOTHING HERE REACHES THE LEADER DIRECTLY. The super admin holds every one
 * of these and decides what is sent on, which is the point: the association
 * asked for a channel it could see, not a mailbox on each office-bearer's
 * card. An office-bearer's own email and telephone are still printed on
 * their panel for anyone who wants to write directly.
 *
 * THE WORDS ARE NOT THE SENDER'S. `purpose` picks one of a fixed list and
 * the SERVER composes `body` from it — see `composeBody` in the service. A
 * visitor cannot post 'hi' to a state chairman, which is exactly what the
 * association asked to prevent. `note` is the one free field, short and
 * optional, and it is stored apart from the composed message so that
 * anything read out of it is known to be the visitor's own typing.
 */
const leaderMessageSchema = new mongoose.Schema({

    /* ------------------------------------------------ who it is addressed to */

    /**
     * A COPY of the leader, not a reference.
     *
     * Office-bearers are sub-documents of a region or state page and are
     * rewritten wholesale on every save of it, so an id is not a durable
     * handle: re-order the council and the id points at somebody else, remove
     * a bearer and it points at nobody. The message has to say who it was
     * addressed to a year later, so the name and role are written down here
     * at the moment it was sent. `id` is kept as a hint, never as the truth.
     */
    leader: {
        id: text(),
        name: text(),
        role: text(),
        designation: text(),
        organisation: text(),
    },

    /* -------------------------------------------------------- the geography */

    /**
     * Which page the leader was on, and where that page sits.
     *
     * This is what the super admin sorts by, and it is the reason the feature
     * exists: a screen of enquiries grouped by district is a list of the
     * places worth taking a scheme or an event to next.
     */
    tier: {
        type: String,
        enum: ['national', 'region', 'state', 'district'],
        default: 'state',
        index: true,
    },
    region: text(),
    state: text(),
    district: text(),
    /** The URL they were reading, so a reply can start where they were. */
    pagePath: text(),

    /* ------------------------------------------------------------ who wrote */

    sender: {
        name: text(),
        /**
         * Required in the service, not here.
         *
         * A telephone number is the whole point — the association's standard
         * reply is that somebody will ring back — but `required` on the schema
         * would throw a validation error at a visitor rather than the sentence
         * the form should show them.
         */
        phone: text(),
        email: text(),
        organisation: text(),
        district: text(),
    },

    /* ---------------------------------------------------------- the message */

    /** One of the fixed purposes. The service owns the list. */
    purpose: text('callback'),
    /** What the purpose reads as, stored so a later re-wording cannot rewrite history. */
    purposeLabel: text(),
    /** Composed by the server from the purpose. Never taken from the client. */
    body: { type: String, default: '' },
    /** The sender's own words. Short, optional, and kept apart from `body`. */
    note: { type: String, default: '' },

    /* ----------------------------------------------------- what happened next */

    status: {
        type: String,
        enum: ['new', 'read', 'contacted', 'closed'],
        default: 'new',
        index: true,
    },
    /** The super admin's own note — what was sent, what was promised. */
    adminNote: { type: String, default: '' },
    handledBy: editedBy,

    /** Kept for abuse triage: another endpoint anyone at all can write to. */
    meta: {
        ip: { type: String, default: '' },
        userAgent: { type: String, default: '' },
    },
}, { collection: 'web_leader_messages', timestamps: true });

leaderMessageSchema.index({ status: 1, createdAt: -1 });
leaderMessageSchema.index({ tier: 1, state: 1, district: 1, createdAt: -1 });
leaderMessageSchema.index({ createdAt: -1 });
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
    // industry and environment — the regional pages' hero and vision bands
    'factory', 'leaf', 'graduation-cap', 'ship',
    // trust
    /* `landmark` was in the renderer's table and NOT here, so an editor who
       named it got `star` written to the database instead and nothing said
       so — `icon()` swaps an unknown name for the fallback silently. The two
       lists have to hold the same names or one of them is a trap. */
    'shield', 'shield-check', 'scale', 'landmark',
    // place and time
    'globe', 'map-pin', 'calendar', 'calendar-days', 'clock',
    // events and media
    'image', 'images', 'monitor-play', 'play', 'tent', 'book-open', 'hard-hat',
    'grid', 'party-popper', 'mic',
    // contact
    'phone', 'mail', 'message-square', 'send', 'file-text',
    // a photograph's own fields — see the note on `customFields[].icon`
    'info', 'camera', 'tag', 'users-2', 'quote',
    // navigation
    'arrow-right', 'external-link', 'home',
    // social — used by the footer
    'facebook', 'instagram', 'linkedin', 'twitter', 'youtube',
];

/** Kept as its own export: the feature cards were shipped against this name. */
const FEATURE_ICONS = ICON_NAMES;

// ============================================================ legal documents

/**
 * One headed block of a legal document.
 *
 * `body` is an ARRAY OF PARAGRAPHS rather than one blob with newlines in it.
 * A legal notice is quoted, amended and compared clause by clause, and a single
 * string means every such operation is a search-and-replace inside prose. It
 * also means the renderer decides paragraph spacing from the data instead of
 * from `white-space: pre-line`, which collapses differently in every browser.
 *
 * `_id: false` — a section is a line in a document, not something anything else
 * points at. Giving each one an id would invite code that edits a section by it,
 * and the whole document is replaced on every save.
 */
const legalSectionSchema = new mongoose.Schema({
    heading: text(),
    body: { type: [String], default: [] },
    bullets: { type: [String], default: [] },
    links: { type: [new mongoose.Schema({ label: text(), href: text() }, { _id: false })], default: [] },
}, { _id: false });

/**
 * A legal document — Privacy, Terms, Return, Cancellation, or any other.
 *
 * ========================================================================
 * NOT A SINGLETON, AND NOT HARDCODED
 * ========================================================================
 *
 * One row per document, keyed on `slug`, which is also its URL. The Super Admin
 * adds, edits, reorders, publishes and unpublishes them; the public site reads
 * this collection and holds no copy of the text. A fifth document is a row here
 * and needs no deploy.
 *
 * ========================================================================
 * VERSION HISTORY IS THE POINT, NOT A FEATURE
 * ========================================================================
 *
 * The reason legal text is usually kept out of a CMS is not that editors cannot
 * be trusted with it — it is that "what did the terms say on the day this
 * member agreed to them?" is a question an ordinary content box cannot answer.
 * A rich-text field overwritten in place destroys the only evidence of what was
 * agreed.
 *
 * So every save writes the PREVIOUS text to `web_legal_revisions` before the new
 * text lands, `version` counts up, and `effectiveFrom` records the date the
 * wording took effect. That makes this collection safer than the code it
 * replaced: a file in git has a history too, but the history of a deployed file
 * is a history of commits, not of what was live on a given date.
 *
 * `status` is `published` or `draft`. A draft is invisible to the public site
 * and to the footer — it is a document being written, and a half-written refund
 * policy is worse than none.
 */
const legalDocumentSchema = new mongoose.Schema({
    /**
     * The URL, and the identity. `privacy-policy` serves `/privacy-policy`.
     *
     * Immutable after creation would be wrong — an association renaming
     * "Return Policy" to "Refund Policy" is an ordinary thing to want — but a
     * changed slug is a changed URL, so the service refuses one that collides
     * and the old path stops resolving. That is the editor's decision to make,
     * with the consequence stated on the form.
     */
    slug: {
        type: String, trim: true, lowercase: true, required: true, unique: true, index: true,
    },

    /** The page's heading, and its browser title. */
    title: text(),
    /** The line under the title. */
    lede: text(),
    /**
     * What the FOOTER calls it, when that differs from the page's own title.
     *
     * "Terms & Conditions" is the heading and "Terms" may be what fits on a
     * footer rule beside three others. Empty means "use the title", so an
     * editor who does not care never sees the distinction.
     */
    footerLabel: text(),

    sections: { type: [legalSectionSchema], default: [] },

    status: {
        type: String, enum: ['published', 'draft'], default: 'published', index: true,
    },

    /** Position in the footer and in the page's own policy sidebar. */
    order: { type: Number, default: 0 },

    /**
     * The date this WORDING took effect — the editor's answer, not the clock's.
     *
     * Distinct from `updatedAt`, which is when the row was touched. Correcting a
     * typo does not change the date the terms took effect, and a document whose
     * effective date moved every time somebody fixed a comma would be useless
     * as evidence of anything.
     */
    effectiveFrom: { type: Date, default: null },

    /** Counts up on every save. `1` is the seeded text. */
    version: { type: Number, default: 1 },

    /**
     * Fields the editor named themselves — “Governing law”, “Grievance
     * officer”, “Registered address”, “Last reviewed by”.
     *
     * Printed as labelled rows at the foot of the policy. A notice often
     * has to carry one statutory line that is not a clause and does not
     * belong inside a numbered section.
     */
    extraFields: customFields(),

    editedBy,
}, { collection: 'web_legal_documents', timestamps: true });

/** The footer and the sidebar read them in this order, published only. */
legalDocumentSchema.index({ status: 1, order: 1 });

/**
 * What a legal document said before the last save.
 *
 * A SEPARATE COLLECTION, not an array on the document. These hold the full text
 * of a policy — the Terms run to several thousand words — and twenty revisions
 * embedded in one row is a document that grows without limit toward Mongo's
 * 16MB ceiling, on the one collection whose whole job is to still be readable
 * in five years. A separate row per revision also means reading the current
 * document never loads a decade of history it does not need.
 */
const legalRevisionSchema = new mongoose.Schema({
    slug: { type: String, trim: true, lowercase: true, required: true, index: true },
    /** The version this row IS — the text as it stood at that version. */
    version: { type: Number, required: true },

    title: text(),
    lede: text(),
    footerLabel: text(),
    sections: { type: [legalSectionSchema], default: [] },
    /* The editor's own fields, snapshot with the wording — see the note below
       on `order`, which is the same trap: a field the revision does not name is
       a field `restore` silently blanks. */
    extraFields: customFields(),
    status: text(),
    effectiveFrom: { type: Date, default: null },
    /**
     * SNAPSHOT EVERY FIELD, INCLUDING THE ONES NOBODY READS BACK.
     *
     * `order` was missing here, and the omission was not harmless: `restore`
     * rebuilds the document from the revision, a revision with no `order` maps
     * to `order: 0`, and restoring an old wording silently moved the policy to
     * the front of the footer. An archive with a hole in it is an archive that
     * quietly rewrites what it restores.
     */
    order: { type: Number, default: 0 },

    /** Who replaced it, and when — the trail this collection exists for. */
    savedBy: text(),
    savedAt: { type: Date, default: Date.now },
    /** The editor's own note about what changed, when they left one. */
    note: text(),
}, { collection: 'web_legal_revisions', timestamps: true });

/** One row per version of a document, and the history reads newest first. */
legalRevisionSchema.index({ slug: 1, version: -1 }, { unique: true });

// ==================================================== regions and states

/**
 * One person in a leadership panel.
 *
 * `designation` and `organisation` are TWO FIELDS, not one, because the panel
 * prints them as two stacked lines joined by the word "and" — and asking an
 * editor to type a line break into a name field is how a name ends up with a
 * stray "and" in the middle of it on every other screen that shows it.
 */
const leaderSchema = () => ({
    name: text(),
    /**
     * The two-word badge under the photograph — "Chairman", "Vice Chairman".
     *
     * Separate from `designation`, which is the full line ("Chairman, ACTIV
     * Tamil Nadu State Council"). A badge has to be short enough to sit in a
     * pill, and deriving one by cutting the designation at its first comma
     * works until somebody writes "Chairman and Convenor, Skills Panel".
     */
    role: text(),
    designation: text(),
    organisation: text(),
    photoUrl: text(),
    /** One or two sentences. Shown on the leader's own panel, not on the card. */
    bio: { type: String, default: '' },

    /**
     * HOW TO REACH THIS PERSON — theirs, not the office's.
     *
     * The page used to carry one contact per tier: a state office, a regional
     * office, a district office. That answers "who do I write to about this
     * council" and not "how do I reach the Convenor of the skills panel", which
     * is the question a member on a leadership page actually has.
     *
     * All three are optional and every one of them is drawn only when it is
     * filled, so a council that publishes a single shared address is unchanged
     * and one that publishes a line per office-bearer gets a directory.
     *
     * `address` is free text with line breaks kept, not an array: unlike the
     * office's, this is usually one line — a company's address the editor
     * already has on a letterhead — and asking them to split it into an array
     * to write one line is a form fighting its own content.
     */
    email: text(),
    phone: text(),
    address: { type: String, default: '' },

    displayOrder: { type: Number, default: 0 },
    /** Hidden without being deleted — the retire-never-delete rule. */
    isHidden: { type: Boolean, default: false },
});

/**
 * ONE SHAPE FOR EVERY FEED.
 *
 * Sector updates, news, media releases, events, projects, policy advocacy,
 * consulting notes and publications are the same object wearing eight labels.
 * Eight near-identical schemas would be eight places to fix the next bug and
 * eight mappers to keep in step, and the differences between them are entirely
 * in how the VIEW draws them.
 *
 * Every field is optional. These pages are written over several sittings — the
 * same rule the event form follows — so an item with a title and nothing else
 * is a legitimate thing to save.
 */
const feedItemSchema = () => ({
    title: text(),
    /** Two or three lines. The card clamps it; the detail page prints it whole. */
    summary: { type: String, default: '' },
    /** Long-form, for the item's own page. Paragraph breaks are content. */
    body: { type: String, default: '' },
    /**
     * Free text, not a Date.
     *
     * These read "Oct 08, 2026" or "Nov 12, 2026 to Nov 13, 2026" and are
     * printed, never sorted on or compared. A Date here would force every
     * editor to pick a single day for a three-day summit and would file an
     * undated entry in 1970 — the trap `startAt` documents on the event model.
     */
    date: text(),
    location: text(),
    /** Internal path or external URL. The view decides how to render each. */
    href: text(),
    imageUrl: text(),
    /** For a publication: the file a reader downloads. */
    fileUrl: text(),
    category: text(),
    sector: text(),
    /**
     * The glyph drawn beside this row, for the lists that are drawn as icons —
     * key achievements and consulting services.
     *
     * A NAME from `ICON_NAMES`, not a URL and not an emoji. A name can be
     * re-skinned when the site's icon set changes; a pasted URL is an image
     * that will one day 404 on somebody else's server, and an emoji renders
     * differently on every operating system the association's members use.
     */
    icon: text(),
    displayOrder: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false },
});

/**
 * A section the association invented, with its own items.
 *
 * The built-in sections are named fields because they are part of the design.
 * This is for everything else: an editor adds "Scholarships" or "Trade
 * Delegations" from the CMS, picks a layout, and the page draws it with the
 * same components — so it lands aligned with the sections around it rather than
 * looking like something bolted on.
 *
 *   key      the URL segment its "View All" screen lives at. Derived from the
 *            title when blank, and de-duplicated on write, because two sections
 *            sharing a key would share a screen.
 *   layout   HOW it is drawn, from a fixed set the site knows how to render.
 *            Free text here would let an editor save "fancy" and get nothing.
 *   items    the same feed rows every other section holds, so the row editor,
 *            the card and the detail screen are all reused.
 *   text     for `layout: 'text'`, which is a paragraph rather than a list.
 */
const CUSTOM_LAYOUTS = ['list', 'tiles', 'dated', 'figures', 'text'];

const customSectionSchema = () => ({
    key: text(),
    title: text(),
    icon: text(),
    layout: { type: String, enum: CUSTOM_LAYOUTS, default: 'list' },
    /** One sentence under the heading. */
    intro: { type: String, default: '' },
    /** The body, for a text section. Paragraph breaks are content. */
    text: { type: String, default: '' },
    items: [feedItemSchema()],
    displayOrder: { type: Number, default: 0 },
    isHidden: { type: Boolean, default: false },
});

/**
 * A slide, with its caption.
 *
 * `media()` alone is not enough: the reference layout prints a sentence UNDER
 * the photograph naming who is in it and when it was taken, and that sentence
 * is the most-read text on the page.
 */
const slideSchema = () => ({
    media: media(),
    caption: { type: String, default: '' },
    href: text(),
    displayOrder: { type: Number, default: 0 },
    isHidden: { type: Boolean, default: false },
});

/**
 * The office a visitor writes to.
 *
 * `addressLines` is an ARRAY, exactly as the editor types it. The reference
 * prints six lines; joining them into one string loses the shape, and splitting
 * a joined string back out guesses at where the breaks were.
 */
/**
 * ==========================================================================
 * A NAMED CONTACT ON A TIER — not the office, and not an office-bearer.
 * ==========================================================================
 *
 * Get in Touch was built from exactly two things: ONE office per tier, and
 * every office-bearer who happened to have an email or a telephone of their
 * own. That covers the two common cases and misses a third the association
 * actually has — somebody a reader should be able to write to who is not on
 * the leadership bench and is not the office itself. A membership registrar,
 * an events coordinator, the person who answers the skills programme.
 *
 * There was no way to add one. Making that person a "leader" to get them into
 * the contact list would also put their portrait in the leadership grid,
 * which says something untrue about who runs the council.
 *
 * So: a list, on every tier that has a contact block — the state page, the
 * region page, and each `stateRegions` and `districts` entry. Same shape
 * everywhere, because `contactEntries` renders all of them through one path
 * and a tier differing by a field is how three lists become three components.
 *
 * `photoUrl` is here and `bio` is not. The contact card shows a face and a way
 * to reach somebody; a paragraph about them belongs on a leader panel, which
 * is a different thing and already has one.
 */
const contactPersonSchema = () => ({
    name: text(),
    /** The line under the name — "Membership Registrar". */
    designation: text(),
    organisation: text(),
    photoUrl: text(),
    email: text(),
    phone: text(),
    /** Free text, line breaks kept — as on a leader, and for the same reason. */
    address: { type: String, default: '' },
    displayOrder: { type: Number, default: 0 },
    /** Retired without being deleted — the rule every list here follows. */
    isHidden: { type: Boolean, default: false },
});

/**
 * ==========================================================================
 * A GROUP OF CONTACTS — its own list, not a leadership tier.
 * ==========================================================================
 *
 * Get in Touch prints one group per heading: "North Region", "Chennai
 * District". Those headings used to be READ OFF the leadership tiers —
 * `stateRegions` and `districts` — which meant the contacts screen could only
 * name a group that already had a leadership panel, and adding one from there
 * created a panel as a side effect. An editor adding a contact for
 * Tiruvannamalai got an empty district chapter on the leadership board.
 *
 * THE TWO ARE DIFFERENT THINGS and the association has said so repeatedly. A
 * leadership tier is a bench of portraits with a region, a member count and a
 * shape on the map. A contact group is a heading and some people to write to.
 * The association may want a contact group for a district it has no chapter
 * in yet, and a chapter it publishes no contact for.
 *
 * So: their own array. Nothing here touches `districts` or `stateRegions`,
 * and nothing there creates one of these.
 */
const contactGroupSchema = () => ({
    /** The heading in Get in Touch — "Chennai District", "North Region". */
    name: text(),
    contacts: [contactPersonSchema()],
    displayOrder: { type: Number, default: 0 },
    isHidden: { type: Boolean, default: false },
});

const officeSchema = () => ({
    personName: text(),
    /** The director's photograph, on the contact card. */
    photoUrl: text(),
    designation: text(),
    addressLines: [{ type: String, trim: true }],
    city: text(),
    state: text(),
    country: text('India'),
    pincode: text(),
    email: text(),
    phone: text(),
    mapUrl: text(),
});

/**
 * ONE DISTRICT OF A STATE — the third tier of the leadership board.
 *
 * =========================================================================
 * WHY THIS LIVES ON THE STATE PAGE AND NOT IN ITS OWN COLLECTION
 * =========================================================================
 *
 * A district has no page of its own and is not asked for by name anywhere: it
 * is read only as part of the state it belongs to, and it is written only by
 * the editor who is already editing that state. A separate collection would
 * buy a second round trip on every state page and a second screen in the CMS,
 * and would let a district exist with no state — which is not a thing.
 *
 * `leaders` is the SAME shape as the state's and the region's, so the one
 * board component draws all three tiers. Districts differing from the tiers
 * above them by a field is how three boards end up as three components.
 *
 * `contact` is the same `officeSchema` as the state office for the same
 * reason: the contact strip prints a district row with the phone and email it
 * finds, and a district whose editor has filled in only a phone number prints
 * a phone number rather than a blank row.
 */
const districtSchema = () => ({
    name: text(),
    /**
     * One line under the district's name — what its members actually make.
     *
     * "Pumps, motors, foundries and textile machinery" is the difference
     * between a heading a reader skims and a heading that tells them whether
     * this is their chapter. Optional: a district with no line drawn gets its
     * name alone, not an empty rule.
     */
    description: { type: String, default: '' },
    /**
     * WHICH OF THE STATE'S REGIONS THIS DISTRICT SITS IN — by name.
     *
     * The map used to colour every district by a zone the BUILD SCRIPT worked
     * out from its latitude and longitude: four fixed bands, north/east/south/
     * west, baked into the generated boundary file. So an association that
     * organises Tamil Nadu into its own regions saw a map coloured by geometry
     * instead, and creating a fifth region in the CMS changed nothing on it.
     *
     * A NAME, NOT AN ID. These region rows are subdocuments of the page and
     * are rewritten wholesale on every save, so their `_id`s are not stable
     * across an edit — a stored id would silently detach the moment somebody
     * reordered the regions. The name is what the editor picked from a list of
     * the names that exist, and `regionMatch`-style normalisation is what
     * reconciles a rename.
     *
     * ON THE DISTRICT, NOT A LIST ON THE REGION. A district belongs to exactly
     * one region; a list on the region side lets the same district appear in
     * two, and then the map has to decide which colour wins. One field on the
     * owned side makes that state unrepresentable.
     *
     * Empty means "not assigned", and the map falls back to the geographic
     * zone for that district — which is what every page shows until somebody
     * starts assigning them.
     */
    regionName: text(),
    leaders: [leaderSchema()],
    contact: officeSchema(),
    /** Named contacts on this tier, beyond the office and the bench. */
    contacts: [contactPersonSchema()],

    /**
     * HOW MANY ACTIVE MEMBERS THIS TIER HAS — the figure on the map marker.
     *
     * The marker used to mean one thing only: "there is a chapter here". A
     * reader looking at six identical rings across Tamil Nadu could not tell
     * a district of four hundred members from one of nine.
     *
     * TYPED BY AN EDITOR, NOT COUNTED FROM THE MEMBERS COLLECTION, and that
     * is deliberate. The members database is the association's own record —
     * it counts applications in every state of approval, people who have
     * lapsed, and duplicates nobody has merged. What belongs on a public page
     * is the figure the council is willing to publish, which is a decision
     * rather than a query. `cms.regionPages.service` reads no other module's
     * collections, and that rule is in its header for the same reason.
     *
     * `0` means "no figure published" and draws the plain ring the map has
     * always drawn. There is no way to say "a chapter with zero members",
     * which is not a thing anybody needs to say.
     */
    activeMembers: { type: Number, default: 0, min: 0 },
    displayOrder: { type: Number, default: 0 },
    /** Retired without being deleted — the rule every list here follows. */
    isHidden: { type: Boolean, default: false },
});

/**
 * ONE REGION **OF A STATE** — and not the national region of the same name.
 *
 * =========================================================================
 * TWO DIFFERENT THINGS ARE CALLED A REGION, AND THEY ARE NOT RELATED
 * =========================================================================
 *
 * The NATIONAL region is one of the five the country is divided into — South,
 * North, East, West, North East. It CONTAINS states. It lives in
 * `web_region_pages`, it has its own public page at `/regions/south`, and Tamil
 * Nadu belongs to it.
 *
 * A STATE's region is a zone INSIDE one state — Tamil Nadu's own North, South,
 * East and West, each covering a handful of its districts, each with its own
 * chairman and secretary. It belongs to the state and exists nowhere else.
 *
 * They collide by name and by nothing else: "South Region" on the Tamil Nadu
 * page means the southern districts of Tamil Nadu, and "South Region" in the
 * menu means eight states. Drawing the second where the first belongs is the
 * bug this field exists to fix — the state page was showing its national
 * parent's bench under a heading that promised the state's own zones.
 *
 * Same shape as `districtSchema`, deliberately: a zone and a chapter are the
 * same object at two scales, and one board component draws both.
 */
const stateRegionSchema = () => ({
    name: text(),
    /** One line under the name — which districts the zone covers. */
    description: { type: String, default: '' },
    leaders: [leaderSchema()],
    contact: officeSchema(),
    /** Named contacts on this tier, beyond the office and the bench. */
    contacts: [contactPersonSchema()],

    /**
     * HOW MANY ACTIVE MEMBERS THIS TIER HAS — the figure on the map marker.
     *
     * The marker used to mean one thing only: "there is a chapter here". A
     * reader looking at six identical rings across Tamil Nadu could not tell
     * a district of four hundred members from one of nine.
     *
     * TYPED BY AN EDITOR, NOT COUNTED FROM THE MEMBERS COLLECTION, and that
     * is deliberate. The members database is the association's own record —
     * it counts applications in every state of approval, people who have
     * lapsed, and duplicates nobody has merged. What belongs on a public page
     * is the figure the council is willing to publish, which is a decision
     * rather than a query. `cms.regionPages.service` reads no other module's
     * collections, and that rule is in its header for the same reason.
     *
     * `0` means "no figure published" and draws the plain ring the map has
     * always drawn. There is no way to say "a chapter with zero members",
     * which is not a thing anybody needs to say.
     */
    activeMembers: { type: Number, default: 0, min: 0 },
    displayOrder: { type: Number, default: 0 },
    /** Retired without being deleted — the rule every list here follows. */
    isHidden: { type: Boolean, default: false },
});

/**
 * THE BAND ACROSS THE TOP OF THE PAGE.
 *
 * A photograph, a headline, one paragraph and four short claims with icons —
 * the thing that makes a page about a state look like somewhere rather than
 * like a list of committee members.
 *
 * Every field is optional and the band is not drawn at all without a headline
 * or a background: a page whose editor has not reached this yet shows the plain
 * heading it has always shown, rather than an empty blue rectangle.
 */
const heroSchema = () => ({
    /** The line above the headline — "Industry · Innovation · Growth". */
    eyebrow: text(),
    headline: text(),
    /** One sentence under the headline. */
    tagline: text(),
    blurb: { type: String, default: '' },
    /** The photograph behind it all. */
    backgroundUrl: text(),
    /** An optional graphic beside the words — a map, a crest, a monogram. */
    sideImageUrl: text(),
    /** Four short claims, each with an icon. More than four wraps badly. */
    features: [{
        icon: text(),
        label: text(),
    }],

    /**
     * The fact chips under the headline — Capital, Area, Population, Languages.
     *
     * A LABEL AND A VALUE, which is why these cannot be `features`: "Capital"
     * and "Chennai" are two pieces of text set at two different weights, and a
     * single label field would force an editor to type "Capital: Chennai" and
     * lose the typography that makes the chip readable at a glance.
     */
    facts: [{
        icon: text(),
        label: text(),
        value: text(),
    }],

    /**
     * The "at a glance" card beside the headline.
     *
     * Three claims, each a bold line and a quieter qualifier — "2nd Largest
     * Economy" / "in India". Same reasoning as `facts`: two fields because the
     * design sets them differently.
     */
    glance: [{
        icon: text(),
        title: text(),
        subtitle: text(),
    }],
});

/**
 * The closing band — what the council is for, in one sentence.
 *
 * Last on the page because it is the thing a reader leaves with, and because
 * everything above it is evidence for it.
 */
const visionSchema = () => ({
    title: text(),
    text: { type: String, default: '' },
    pillars: [{
        icon: text(),
        label: text(),
    }],
});

/** Per-page title and description for search results and shared links. */
const seoSchema = () => ({
    metaTitle: text(),
    metaDescription: text(),
    ogImageUrl: text(),
});

/**
 * A REGION's landing page.
 *
 * Keyed on `regionKey` — `south`, never "South". The label is editable content
 * and an association that renames a region must not break every stored page and
 * every link. See `cms.regionMap.js`.
 */

/**
 * ==========================================================================
 * THE DASHBOARD'S OWN HEADINGS — words a visitor reads, so words an editor owns
 * ==========================================================================
 *
 * "State / Tamil Nadu Leaders", "Districts / District-wise Leadership",
 * "Contact / Get in Touch". Every heading a visitor reads on a zone page or a
 * state page was a string literal in `RegionPage` and `StatePage`, drawn on
 * every one of those pages, and reachable from no CMS screen.
 *
 * NOT the cards in `StateDashboard`. That file exports a GalleryCard, a
 * ContactCard and a ContactStrip with headings of their own, and nothing
 * renders any of them — the two live pages are built from `RegionUI`
 * instead. Giving an editor fields that drive dead markup would be worse than
 * leaving them alone: they would type a heading, save it, and never find it.
 *
 * That is the same fault the site has already been through twice — "Across
 * India" was hardcoded on seven pages, and the contact band's three sentences
 * were shown on the page while the CMS box sat empty. The rule the association
 * asked for is simple: if a visitor reads it, an editor can change it.
 *
 * ALL OPTIONAL, AND BLANK MEANS THE SHIPPED WORDING. Every one of these pages
 * predates the field, so an absent value has to keep drawing what it drew
 * yesterday. The client carries the same defaults, and
 * `scripts/seed-shown-defaults.js` fills the stored fields with them so the
 * CMS is never empty while the page has words.
 */
const dashboardLabels = () => ({
    /* Over the page's own bench of office-bearers. The TITLE carries the
       region's name ("Tamil Nadu Leaders"), so only the eyebrow is stored;
       a stored title would freeze one region's name onto every page. */
    ownTierEyebrow: text(),
    /* Over the tier below — a zone's states, a state's regions. */
    tierBelowEyebrow: text(),
    tierBelowHeading: text(),
    /* A state page has a third band the zone page does not: its districts. */
    districtsEyebrow: text(),
    districtsHeading: text(),
    /* The contact band at the foot of both pages. */
    contactEyebrow: text(),
    contactHeading: text(),
});

const regionPageSchema = new mongoose.Schema({
    regionKey: { type: String, required: true, unique: true, trim: true, lowercase: true },
    /** What a reader sees. Defaults to the map's label; editable. */
    regionName: text(),

    /** The dashboard's own headings — see `dashboardLabels`. */
    labels: dashboardLabels(),

    /** The paragraph above "Read More". */
    shortDescription: { type: String, default: '' },
    /** What "Read More" expands to. */
    fullDescription: { type: String, default: '' },

    hero: heroSchema(),
    vision: visionSchema(),

    heroCarousel: [slideSchema()],
    leaders: [leaderSchema()],

    /**
     * WHAT THE REGION HAS ACHIEVED.
     *
     * A feed like the others, but read as a band of figures: `title` carries
     * the number ("1,200 members") and `summary` says what it counts. Stored as
     * text and not as a Number, because half of these are not numbers —
     * "First state council to publish a skills charter" is an achievement too,
     * and a numeric field would have no way to hold it.
     */
    achievements: [feedItemSchema()],

    /**
     * The ticked list in the rail — see the note on the state's.
     *
     * A region page is drawn with the same components as a state page, so it
     * needs the same two fields: FIGURES in `achievements`, SENTENCES here. A
     * region with only the first has a rail with a hole in it where the state
     * pages beneath it have a card.
     */
    keyAchievements: [feedItemSchema()],

    /*
     * THE SAME WORK A STATE PUBLISHES, RUN ACROSS SEVERAL STATES.
     *
     * These five were on the state page only, which made the region page a
     * different kind of object drawn with different components — and a reader
     * moving from South to Tamil Nadu met two designs. A region runs events,
     * projects, consulting and advocacy exactly as a state does.
     */
    events: [feedItemSchema()],
    projects: [feedItemSchema()],
    policyAdvocacy: [feedItemSchema()],
    consultingServices: [feedItemSchema()],
    publications: [feedItemSchema()],
    mediaCoverages: [feedItemSchema()],

    /* The region's own feeds, which no single state owns. */
    sectorUpdates: [feedItemSchema()],
    newsUpdates: [feedItemSchema()],
    mediaReleases: [feedItemSchema()],
    speakInMedia: [feedItemSchema()],

    /** Editor-controlled rail links, beneath Focus States. */
    relatedLinks: [link()],

    /** Sections the association added itself — see `customSectionSchema`. */
    customSections: [customSectionSchema()],

    /**
     * ======================================================================
     * THE TIER BELOW, OWNED BY THIS PAGE
     * ======================================================================
     *
     * A state page stores its regions and its districts as rows of its own.
     * This is the same field at the tier above: the states under a region,
     * and the regions under the national page.
     *
     * OWNED, AND NOT SHARED. The association asked for this explicitly, and
     * it is the right answer: editing the South’s board on the national page
     * must not rewrite the South’s own page, and a national council that
     * wants to show a regional convenor who is not on that region’s public
     * bench must be able to. Two pages, two records, one editor each.
     *
     * The same sub-schema the state page uses, because it is the same thing
     * at a different scale — a name, a bench, a member count, some contacts.
     * A second schema would be a second place to add the next field.
     *
     * `districts` is deliberately NOT here. A region page is one level up
     * from a state, so its tier below is states and there is no tier below
     * that on this page; a third level would be a district board on a
     * national page, which is a page nobody would read.
     */
    stateRegions: [stateRegionSchema()],

    /**
     * ======================================================================
     * THE ORDER THE TIER BELOW IS DRAWN IN, AS AN EDITOR CHOSE IT
     * ======================================================================
     *
     * Slugs on a zone page (its states), region keys on the national page
     * (the zones). The pages themselves are NOT stored here — only which
     * order to read them in, which is the one fact about the tier below that
     * belongs to the page above.
     *
     * It is a HINT, not the list. `statePanelsOf` still decides which pages
     * exist and still sorts them by name; this only lifts the ones named
     * here to the front, in this order. That matters because the two lists
     * drift on their own: a state page is created, renamed or deleted
     * without this field hearing about it. An entry naming a page that is
     * gone is ignored, and a page this field has never heard of sorts after
     * the ones it has — alphabetically, as before — rather than vanishing.
     *
     * A `sortOrder` on each state page would have been the other design, and
     * it is the wrong one: the order of the South’s states is a fact about
     * the South’s page, and the same state can sit in a different place on
     * the national map without contradicting it.
     */
    tierOrder: { type: [String], default: [] },

    contact: officeSchema(),
    /** Named contacts for the page itself, beyond the office and the bench. */
    contacts: [contactPersonSchema()],
    /**
     * The other groups in Get in Touch, each with its own heading.
     *
     * Independent of `stateRegions` / `districts` — see `contactGroupSchema`.
     */
    regionContactGroups: [contactGroupSchema()],
    districtContactGroups: [contactGroupSchema()],

    /**
     * The picture card at the top of the rail — "Explore the South".
     *
     * The state page has had one since it was written and the region page had
     * not, which is the whole reason the two rails did not match: the region's
     * began with a figures card where the state's began with a photograph. Same
     * four fields, same card, same place.
     */
    explore: {
        imageUrl: text(),
        title: text(),
        subtitle: text(),
        href: text(),
    },

    /** The sentence over the consulting list, and the button under it. */
    consultingIntro: { type: String, default: '' },
    consultingCta: link(),

    /** The banner cards an editor may place on the page. */
    promoCards: [{
        imageUrl: text(),
        title: text(),
        subtitle: text(),
        href: text(),
        _id: false,
    }],

    /** Where "Follow Us" points. */
    socialLinks: [{
        icon: text(),
        href: text(),
        _id: false,
    }],

    /** Whether the Contact Us card shows the message form. */
    feedbackEnabled: { type: Boolean, default: true },

    seo: seoSchema(),

    /**
     * `draft` is withheld from every public route.
     *
     * Not a `published` boolean: a third state (scheduled) is the obvious next
     * request, and a boolean cannot grow one without a migration.
     */
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    updatedBy: editedBy,
    extraFields: customFields(),
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),
}, { collection: 'web_region_pages', timestamps: true });

/**
 * A STATE's landing page.
 *
 * `regionKey` is DERIVED from the map on every write and never accepted from a
 * client. A page whose state and region disagree is a page the menu shows in
 * one place and the breadcrumb claims is in another.
 */
const statePageSchema = new mongoose.Schema({
    /** The canonical spelling from the map. Validated on write. */
    stateName: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    regionKey: { type: String, default: '', trim: true, lowercase: true },

    /** The dashboard's own headings — see `dashboardLabels`. The state page
        draws the same component as the zone page, so it carries the same
        fields: a state that calls its photographs something else should be
        able to say so without the zone above it changing too. */
    labels: dashboardLabels(),

    shortDescription: { type: String, default: '' },
    fullDescription: { type: String, default: '' },

    hero: heroSchema(),
    vision: visionSchema(),

    heroCarousel: [slideSchema()],
    leaders: [leaderSchema()],

    /**
     * The SECOND tier of the leadership board — the state's OWN regions.
     *
     * Not the national region this state belongs to; see `stateRegionSchema`
     * for why the two are different things that share a word.
     */
    stateRegions: [stateRegionSchema()],

    /**
     * The third tier of the leadership board — see `districtSchema`.
     *
     * The state page draws State, then its own Regions, then Districts, in that
     * order and with no filter between them.
     */
    districts: [districtSchema()],

    /** The state's own achievements — see the note on the region's. */
    achievements: [feedItemSchema()],

    /**
     * THE TICKED LIST IN THE RAIL — and NOT the same thing as `achievements`.
     *
     * `achievements` are FIGURES: a number in `title` and what it counts in
     * `summary`, drawn as the Highlights card. These are SENTENCES — "First
     * orders in eleven new export markets" — drawn as a ticked list beside it.
     * The design carries both, one above the other, because they answer two
     * questions a member asks in turn: how big is this council, and what has it
     * actually done.
     *
     * They were one field for about an hour. Every sentence then rendered in
     * the figures card at the size a number is set at, three lines deep, and
     * the card stopped reading as figures at all.
     */
    keyAchievements: [feedItemSchema()],

    /* The tabbed section. A tab with nothing in it is not drawn. */
    events: [feedItemSchema()],
    projects: [feedItemSchema()],
    policyAdvocacy: [feedItemSchema()],
    consultingServices: [feedItemSchema()],
    publications: [feedItemSchema()],

    /* The right rail. */
    mediaReleases: [feedItemSchema()],
    mediaCoverages: [feedItemSchema()],
    relatedLinks: [link()],

    /** Sections the association added itself — see `customSectionSchema`. */
    customSections: [customSectionSchema()],

    contact: officeSchema(),
    /** Named contacts for the page itself, beyond the office and the bench. */
    contacts: [contactPersonSchema()],
    /**
     * The other groups in Get in Touch, each with its own heading.
     *
     * Independent of `stateRegions` / `districts` — see `contactGroupSchema`.
     */
    regionContactGroups: [contactGroupSchema()],
    districtContactGroups: [contactGroupSchema()],
    /** The line above the consulting icons, and the button under them. */
    consultingIntro: { type: String, default: '' },
    consultingCta: link(),

    /**
     * The picture card in the rail — "Explore Tamil Nadu".
     *
     * One image, two lines and a link. Its own object rather than a `promoCard`
     * because it has a fixed place in the layout and the promos do not.
     */
    explore: {
        imageUrl: text(),
        title: text(),
        subtitle: text(),
        href: text(),
    },

    /**
     * Whatever the association wants in the rail beneath the quick links.
     *
     * The reference has that organisation's app and marketplace banners there.
     * Those are THEIR products; ours would be a different set, and a different
     * set again next year — so this is a list an editor fills, not two blocks
     * written into the page.
     */
    promoCards: [{
        imageUrl: text(),
        title: text(),
        subtitle: text(),
        href: text(),
    }],

    /** The Follow Us row on the contact card. */
    socialLinks: [{
        icon: text(),
        href: text(),
    }],

    /** Whether the "Write to us" form is offered on this page. */
    feedbackEnabled: { type: Boolean, default: true },

    seo: seoSchema(),
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
    updatedBy: editedBy,
    extraFields: customFields(),
    /** Sections the editor removed, and the rows they added to each. */
    sections: sectionOverrides(),
}, { collection: 'web_state_pages', timestamps: true });

/** The menu asks "which states have a page", once, for every visitor. */
statePageSchema.index({ regionKey: 1, status: 1 });

module.exports = {
    SINGLETON_KEY,
    ICON_NAMES,
    FEATURE_ICONS,
    LegalDocument: db.model('CmsLegalDocument', legalDocumentSchema),
    LegalRevision: db.model('CmsLegalRevision', legalRevisionSchema),
    SiteSettings: db.model('CmsSiteSettings', siteSettingsSchema),
    Home: db.model('CmsHome', homeSchema),
    About: db.model('CmsAbout', aboutSchema),
    EventsSettings: db.model('CmsEventsSettings', eventsSettingsSchema),
    GallerySettings: db.model('CmsGallerySettings', gallerySettingsSchema),
    GalleryItem: db.model('CmsGalleryItem', galleryItemSchema),
    ContactSettings: db.model('CmsContactSettings', contactSettingsSchema),
    RegionPage: db.model('CmsRegionPage', regionPageSchema),
    StatePage: db.model('CmsStatePage', statePageSchema),
    ContactMessage: db.model('CmsContactMessage', contactMessageSchema),
    LeaderMessage: db.model('CmsLeaderMessage', leaderMessageSchema),
    NewsArticle: db.model('CmsNewsArticle', newsArticleSchema),
    Scheme: db.model('CmsScheme', schemeSchema),
    SchemeSettings: db.model('CmsSchemeSettings', schemeSettingsSchema),
    NewsSettings: db.model('CmsNewsSettings', newsSettingsSchema),
    Membership: db.model('CmsMembership', membershipSchema),
};
