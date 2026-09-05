const mongoose = require('mongoose');

/**
 * One line of the hourly agenda.
 *
 * `startAt`/`endAt` are strings — "09:30", not instants — because an agenda row
 * is a time OF the event day, and the day is already fixed by the event's own
 * `startAt`. Storing a full instant per row would let the two disagree, and
 * moving an event to a different date would silently leave every agenda row
 * pointing at the old one.
 */
const agendaItemSchema = new mongoose.Schema({
    startTime: { type: String, trim: true, default: '' },
    endTime: { type: String, trim: true, default: '' },
    title: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    /** The speaker's NAME, not an id: a session may name someone not listed. */
    speaker: { type: String, trim: true, default: '' },
    location: { type: String, trim: true, default: '' }
}, { _id: true });

const speakerSchema = new mongoose.Schema({
    name: { type: String, trim: true, default: '' },
    role: { type: String, trim: true, default: '' },
    organization: { type: String, trim: true, default: '' },
    bio: { type: String, trim: true, default: '' },
    photoUrl: { type: String, trim: true, default: '' }
}, { _id: true });

/**
 * Platform-wide events, authored by the super admin.
 *
 * `status` is the publish gate: a draft is visible only to admins, a published
 * event is visible to everyone. Members never see drafts.
 *
 * `audience` is the second gate and a different question — not "is this ready"
 * but "who is it for". `paid` restricts an event to members with an active
 * membership, which is what makes the paid dashboard's event feed worth having.
 * The two are independent: an event can be a published members-only event, or a
 * draft that will eventually go out to everyone.
 */
/*
 * NOTHING ON THIS SCHEMA IS REQUIRED, INCLUDING THE TITLE AND THE DATE.
 *
 * An event is written over several sittings — the venue is confirmed after the
 * date, the date after the speaker agrees — and a schema that refused to store a
 * half-filled one forced the editor to invent placeholder values, which then
 * shipped. `status: 'draft'` is what says "not ready"; the individual fields say
 * what is known so far, and an unknown field is empty rather than a lie.
 *
 * The cost is that every reader must handle a missing title and a missing date.
 * They already do: `toEvent` falls back to `''` and `null` on every field, and
 * the listings treat a dateless event as undated rather than as ancient. Both of
 * those were true before this change; requiring the fields never removed the
 * need for the guards, it only meant they were never exercised.
 */
const eventSchema = new mongoose.Schema({
    title: {
        type: String,
        trim: true,
        default: ''
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    /**
     * When it starts, or `null` for an event whose date is not settled.
     *
     * `null` and not "the epoch": the listings sort on this, and a missing date
     * standing in as 1970 would file an unscheduled announcement at the far end
     * of the past where nobody scrolls. Undated events lead the upcoming list
     * instead — see `cms.service.listEvents`.
     */
    startAt: {
        type: Date,
        default: null,
        index: true
    },
    endAt: {
        type: Date
    },
    venue: {
        type: String,
        trim: true,
        default: ''
    },
    /*
     * Legacy single-region targeting. Empty means "everywhere".
     *
     * Superseded by `targets` below, and KEPT — not removed — for two reasons.
     * The mobile app reads these three fields and knows nothing about the
     * array, and every event written before this change carries only these. So
     * they stay, mirrored from the FIRST entry of `targets` on every write.
     *
     * Mirroring the first target rather than clearing them is the safe
     * direction to be wrong in: a reader that knows only these fields shows the
     * event to one of its intended regions instead of to all of them. Clearing
     * them would read as "everywhere" and broadcast a block's event nationally.
     */
    state: {
        type: String,
        trim: true,
        default: '',
        index: true
    },
    district: {
        type: String,
        trim: true,
        default: ''
    },
    block: {
        type: String,
        trim: true,
        default: ''
    },

    /**
     * Every region this event is aimed at (EVT-003).
     *
     * An event is announced to the union of these, and to nobody else. An empty
     * array means everywhere — the same contract the three fields above state,
     * so "no targeting" needs no special value.
     *
     * A LIST, because the single set of fields above could express exactly one
     * region and the association does not work that way: a conclave is held for
     * eight blocks across two districts, and posting it eight times produced
     * eight events, eight registration lists and eight attendee counts for one
     * afternoon.
     *
     * Each entry is a SCOPE, not a coordinate, and it is read left to right:
     *
     *   { state: 'Tamil Nadu' }                                  the whole state
     *   { state: 'Tamil Nadu', district: 'Ariyalur' }            that district
     *   { state: 'Tamil Nadu', district: 'Ariyalur',
     *     block: 'Andimadam' }                                    that block
     *
     * So one event can be aimed at two whole states plus three named blocks in
     * a third, which is what `regionMatch.multiTargetClause` resolves against a
     * viewer's own region. Entries are independent: they widen the audience,
     * never narrow it, and a member matching any one of them sees the event.
     */
    targets: {
        type: [new mongoose.Schema({
            state: { type: String, trim: true, default: '' },
            district: { type: String, trim: true, default: '' },
            block: { type: String, trim: true, default: '' }
        }, { _id: false })],
        default: []
    },

    /**
     * "Everyone in the association", as a field of its own.
     *
     * WHY THIS IS NOT JUST `targets.length === 0`. It was, and that made the
     * editor's two options destroy each other. The form offers "Everyone in the
     * association" and "Only chosen regions" as two boxes that may BOTH be
     * ticked; with an empty list standing in for "everyone", ticking the first
     * had to save `targets: []`, which threw away every region the second had
     * collected. Reopening the event showed an empty tree and the editor was
     * asked to pick their regions from scratch — every time.
     *
     * So the two answers are stored separately. `targets` is what was ticked in
     * the tree, kept whether or not it is currently narrowing anything, and this
     * says whether the event goes out to everybody regardless:
     *
     *     reachEveryone: true   -> every member. `targets` is remembered, and is
     *                             not consulted while this is on.
     *     reachEveryone: false  -> `targets` decides; an empty list still means
     *                             everyone, which is what it has always meant.
     *
     * DEFAULT `false`, NOT `true`. Every event already in the collection
     * expresses its audience through `targets` alone, and defaulting to true
     * would publish every regionally-targeted event to the whole association on
     * deploy. False leaves all of them reading exactly as they read today.
     */
    reachEveryone: {
        type: Boolean,
        default: false,
        index: true
    },
    bannerUrl: {
        type: String,
        trim: true,
        default: ''
    },
    /**
     * What kind of event this is — "Conference", "Workshop", "Networking".
     *
     * Free text matched against the chips in `eventsSettings.categories`, the
     * same arrangement `galleryItem.category` already uses against
     * `gallerySettings.categories`. Deliberately not an enum: the chip list is
     * authored in the CMS, and an enum here would mean a schema change every
     * time an editor invents a category.
     *
     * Additive and optional. A row created before this existed comes back with
     * an empty string, which the public site reads as "no badge, matches only
     * the All chip" rather than as a missing field.
     */
    category: {
        type: String,
        trim: true,
        default: '',
        index: true
    },
    /**
     * How the banner sits in its frame, and what it depicts.
     *
     * Additive and optional, so the mobile app — which reads this same
     * collection and knows only `bannerUrl` — is unaffected. Without them an
     * uploaded portrait photograph is cropped to a strip in the website's wide
     * event card with no way for the editor to say otherwise, which is the one
     * media control every other CMS screen already offers.
     */
    bannerAlt: {
        type: String,
        trim: true,
        default: ''
    },
    bannerFit: {
        type: String,
        enum: ['cover', 'contain'],
        default: 'cover'
    },
    bannerPosition: {
        type: String,
        trim: true,
        default: 'center'
    },
    status: {
        type: String,
        enum: ['draft', 'published'],
        default: 'draft',
        index: true
    },

    /**
     * Who the event is for. `all` is every signed-in member; `paid` is members
     * with an active membership only. Enforced in the service — see the note on
     * the schema above for why this is separate from `status`.
     *
     * Defaults to `all` so that every event already in the collection keeps the
     * visibility it has today. Making `paid` the default would have retired the
     * entire existing programme behind a paywall on deploy.
     */
    audience: {
        type: String,
        enum: ['all', 'paid'],
        default: 'all',
        index: true
    },

    /**
     * WHICH SITE this event was posted for. A third gate, and a different
     * question again from the two above.
     *
     *   public   the onboarding site's events page — the marketing programme,
     *            authored in the CMS.
     *   members  the association's own programme, authored in the super admin's
     *            Events screen, for the member dashboards and the app.
     *
     * It exists because `audience: 'paid'` was doing this job by accident: the
     * public listing dropped members-only events, so posting from the super
     * admin screen kept an event off the marketing site only for as long as it
     * was ALSO restricted to paying members. The moment an event was aimed at a
     * block and opened to everyone there — which is the normal case — it
     * appeared on a national marketing page that has no viewer to filter by.
     * Who may see an event and which site it belongs on are not the same
     * question and no longer share a field.
     *
     * `public` is the default so every event already in the collection keeps the
     * visibility it has today.
     */
    channel: {
        type: String,
        enum: ['public', 'members'],
        default: 'public',
        index: true
    },

    /**
     * ALSO SHOW THIS ON THE ONBOARDING SITE'S EVENTS SECTION.
     *
     * `channel` says where an event was authored for; this says whether the
     * association additionally wants it advertised on the public pages. The two
     * are separate because the answer differs event by event: a district's
     * training day is internal, while the same district's trade expo is exactly
     * what the onboarding site exists to show.
     *
     * It is an OPT-IN, and only the super admin's Events screen offers it. A
     * `channel: 'public'` event authored in the CMS is already onboarding
     * content and does not need the flag — see `cms.service.listEvents`, which
     * treats "public channel" and "opted in" as two ways of being listed.
     *
     * OPTING IN DOES NOT DISCARD THE TARGETING. The event keeps its regions and
     * the onboarding events page filters by them, so a visitor sees which state,
     * district or block it belongs to and can narrow to their own. That is the
     * difference from the old behaviour, where a targeted event was withheld
     * from the public page because that page had no way to say where the event
     * was for.
     *
     * `false` by default so nothing already in the collection changes visibility
     * on deploy.
     */
    showOnOnboarding: {
        type: Boolean,
        default: false,
        index: true
    },

    // ---- the detail an event page needs (EVT-001)
    agenda: { type: [agendaItemSchema], default: [] },
    speakers: { type: [speakerSchema], default: [] },

    /** The street address under the venue name, and a map link if there is one. */
    venueAddress: { type: String, trim: true, default: '' },
    venueMapUrl: { type: String, trim: true, default: '' },
    contactName: { type: String, trim: true, default: '' },
    contactPhone: { type: String, trim: true, default: '' },
    contactEmail: { type: String, trim: true, default: '' },

    // ---- registration (EVT-002)
    registrationEnabled: {
        type: Boolean,
        default: false
    },
    /**
     * After this instant the event stops accepting registrations. Null means
     * "up until the event starts", which the service applies — not the schema,
     * because the cutoff has to move when the event's own date does.
     */
    registrationDeadline: { type: Date, default: null },
    /** 0 means unlimited. A cap of zero attendees is not a thing anyone means. */
    capacity: { type: Number, min: 0, default: 0 },
    registrationNote: { type: String, trim: true, default: '' },

    /**
     * What a seat costs, in rupees. 0 is a free event (EVT-002).
     *
     * Zero is the default and means free — NOT "unset". There is no third
     * state, deliberately: a nullable fee would put every screen in the
     * position of deciding what a missing fee means, and half of them would
     * decide differently. A free event and an event whose organiser has not
     * thought about money yet are the same thing to a member pressing Register.
     *
     * A fee turns registration into two steps rather than one — see
     * `EventService.register`: the seat is held with a pending payment and only
     * becomes a confirmed registration once that payment settles. It is stored
     * on the EVENT and copied onto each registration at the moment it is taken,
     * so raising the fee later does not retrospectively rewrite what somebody
     * already paid.
     */
    registrationFee: { type: Number, min: 0, default: 0 },

    /**
     * The registration form, as the super admin designed it (EVT-004).
     *
     * Every event asks something different. A conclave needs a delegate
     * category and a dietary preference; a factory visit needs a vehicle
     * number and an ID proof; a training day needs a T-shirt size. Hard-coding
     * a union of every field any event might want produces a form that is
     * mostly irrelevant to every event, which members then fill in wrongly.
     *
     * So the form is DATA. The super admin builds it per event and the member
     * screen renders whatever it finds — no client-side list of known fields,
     * because a client that knows the fields is a client that has to ship
     * before a new one can be asked for.
     *
     * FOUR STANDING FIELDS ARE NOT IN HERE: name, phone, organisation and the
     * note. They are columns on the registration itself, the attendee list has
     * headings for them, and the reminder and contact flows read them by name.
     * They are what running an event requires; everything else is what THIS
     * event requires, and that is what this list holds.
     *
     * `key` is the stable identifier an answer is stored against and is never
     * regenerated from the label. Renaming "T-shirt size" to "Shirt size" after
     * forty people have registered must not orphan forty answers.
     */
    registrationFields: {
        type: [new mongoose.Schema({
            key: { type: String, trim: true, required: true },
            label: { type: String, trim: true, default: '' },
            type: {
                type: String,
                enum: ['text', 'textarea', 'number', 'email', 'phone', 'date', 'select', 'checkbox'],
                default: 'text'
            },
            required: { type: Boolean, default: false },
            placeholder: { type: String, trim: true, default: '' },
            helpText: { type: String, trim: true, default: '' },
            /** For `select` only. Ignored, and cleared, for every other type. */
            options: { type: [String], default: [] }
        }, { _id: false })],
        default: []
    },

    /**
     * How many hours before the start a member is reminded.
     *
     * Stored as offsets rather than instants for the same reason the agenda
     * stores times: moving the event must move the reminders with it, and
     * absolute timestamps would have to be recomputed on every date change.
     * The dashboard reads these to show "Reminder 24h before"; delivery is not
     * wired up yet and this is the field it will read when it is.
     */
    reminderOffsetsHours: { type: [Number], default: [] },

    createdBy: {
        type: String,
        trim: true,
        default: ''
    }
}, {
    collection: 'events',
    timestamps: true
});

eventSchema.index({ status: 1, startAt: -1 });
eventSchema.index({ status: 1, audience: 1, startAt: 1 });

/*
 * Targeting is queried with `$elemMatch` on every member-facing list, so the
 * array is indexed on the two fields that narrow it most. A multikey index on a
 * subdocument array is one entry per element, which is what makes "any target
 * matches" answerable without reading the collection.
 */
eventSchema.index({ 'targets.state': 1, 'targets.district': 1 });

module.exports = mongoose.model('Event', eventSchema);
