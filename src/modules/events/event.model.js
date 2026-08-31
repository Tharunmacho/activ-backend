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
const eventSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true,
        default: ''
    },
    startAt: {
        type: Date,
        required: true,
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
    // Optional geographic targeting. Empty means "everywhere".
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

module.exports = mongoose.model('Event', eventSchema);
