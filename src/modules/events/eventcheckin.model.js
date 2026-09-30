const mongoose = require('mongoose');

/**
 * One person let in at the door — the attendance record.
 *
 * ------------------------------------------------ why its own collection
 *
 * Not a field on the booking's participant line. That subdocument is
 * `_id: false` and REWRITTEN WHOLESALE whenever a booker changes a name
 * (`updateParticipants`), so attendance stored on it would be wiped by an
 * edit the booker is entitled to make. It would also put a write on the
 * booking on every scan, racing the payment and cancellation paths that
 * already write it.
 *
 * ------------------------------------------------ idempotent by index
 *
 * `(bookingId, participantIndex)` is UNIQUE. Two staff at two gates scanning
 * the same pass at the same moment both try to insert; one wins and the other
 * gets E11000, which the service reads back as "already checked in at <time>
 * by <staff>". No read-then-write window, on one server or ten.
 *
 * The attendee's name and contact are COPIED at the moment of entry, like the
 * booking copies the event: the booker may rename seat 2 afterwards, and the
 * record of who walked in must not rewrite itself.
 */
const eventCheckinSchema = new mongoose.Schema({
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'EventBooking', required: true },
    bookingRef: { type: String, trim: true, uppercase: true, default: '' },
    /** 0-based seat on the booking; the pass names this seat. */
    participantIndex: { type: Number, min: 0, required: true },
    /** `<bookingRef>-P<n>` — what the email prints. */
    registrationNo: { type: String, trim: true, uppercase: true, default: '' },

    attendeeName: { type: String, trim: true, default: '' },
    attendeeEmail: { type: String, trim: true, lowercase: true, default: '' },
    attendeePhone: { type: String, trim: true, default: '' },

    admittedAt: { type: Date, default: Date.now },
    admittedBy: {
        id: { type: String, trim: true, default: '' },
        name: { type: String, trim: true, default: '' },
        email: { type: String, trim: true, lowercase: true, default: '' },
        role: { type: String, trim: true, default: '' }
    },
    /** 'qr' when the pass was scanned, 'manual' when staff typed the reference. */
    method: { type: String, enum: ['qr', 'manual'], default: 'qr' },
    /** Free text from the scanning app ("Android · Pixel 7"), for the audit trail only. */
    device: { type: String, trim: true, default: '' }
}, {
    collection: 'event_checkins',
    timestamps: true
});

eventCheckinSchema.index({ bookingId: 1, participantIndex: 1 }, { unique: true });
/** The attendance list: one event, most recent entry first. */
eventCheckinSchema.index({ eventId: 1, admittedAt: -1 });

module.exports = mongoose.model('EventCheckin', eventCheckinSchema);
