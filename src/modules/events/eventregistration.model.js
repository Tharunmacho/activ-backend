const mongoose = require('mongoose');

/**
 * A member's seat at an event.
 *
 * A separate collection rather than an array of attendee ids on the event: an
 * event with a few thousand registrations would otherwise be a few thousand
 * subdocuments loaded on every read of the event list, and cancelling a seat
 * would be a write to a document every other member is reading.
 *
 * The member's name, email and phone are COPIED here rather than joined at read
 * time. That is deliberate denormalisation: an attendee list is a record of who
 * signed up and how to reach them on the day, and a member who later changes
 * their phone number has not changed the number they gave the organiser. It
 * also means the list still renders for a member whose record has since been
 * deleted.
 */
const eventRegistrationSchema = new mongoose.Schema({
    eventId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Event',
        required: true,
        index: true
    },
    /**
     * `MemberDetails._id` as a string.
     *
     * A string and not an ObjectId ref, matching `Company.userId` and the rest
     * of the member-owned collections — the token carries it as a string and
     * every comparison in this codebase is `String(a) === String(b)`. Declaring
     * it as an ObjectId here would mean one collection casting where the others
     * do not, and a lookup that silently matches nothing when it fails to cast.
     */
    userId: {
        type: String,
        required: true,
        index: true
    },

    memberName: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, lowercase: true, default: '' },
    phone: { type: String, trim: true, default: '' },
    organization: { type: String, trim: true, default: '' },

    /** Where the member was when they registered — for the organiser's list. */
    state: { type: String, trim: true, default: '' },
    district: { type: String, trim: true, default: '' },
    block: { type: String, trim: true, default: '' },

    /**
     * `cancelled` rather than deleting the row.
     *
     * A cancelled seat has to stay visible to the organiser, and re-registering
     * has to reuse the same row — the unique index below means an insert would
     * fail on the second attempt anyway. Cancelling frees the seat because the
     * capacity count only counts `registered`.
     */
    status: {
        type: String,
        enum: ['registered', 'waitlist', 'cancelled'],
        default: 'registered',
        index: true
    },

    note: { type: String, trim: true, default: '' },
    registeredAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date, default: null }
}, {
    collection: 'event_registrations',
    timestamps: true
});

/**
 * One seat per member per event.
 *
 * Enforced in the database and not only in the service: two taps on a slow
 * connection are two concurrent requests, and both would pass a "have you
 * already registered?" check before either had written. The service catches the
 * resulting E11000 and treats it as "already registered", which is the truth.
 */
eventRegistrationSchema.index({ eventId: 1, userId: 1 }, { unique: true });
eventRegistrationSchema.index({ eventId: 1, status: 1 });

module.exports = mongoose.model('EventRegistration', eventRegistrationSchema);
