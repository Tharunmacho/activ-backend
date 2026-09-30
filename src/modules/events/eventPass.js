const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../config/logger');

/**
 * ============================================================================
 * EVENT ENTRY PASSES — one signed token per SEAT on a booking
 * ============================================================================
 *
 * Every participant on a confirmed booking gets a QR code in their
 * confirmation email. The QR carries a URL — `https://activ.org.in/checkin/<token>`
 * — so an ordinary phone camera opens a harmless website page ("this is an
 * ACTIV event pass, show it at the entrance") and nothing else. Only the events
 * staff, signed in to the ACTIV app, can turn the token into a name and admit
 * the holder. Scanning never marks anything; the "Allow entry" button does.
 *
 * -------------------------------------------------------------- the token
 *
 *   base64url( version(1) | bookingId(12) | seatIndex(1) | HMAC-SHA256(...)[0..16] )
 *
 * 30 bytes, 40 characters. The MAC is 128 bits over the version, booking id and
 * seat index, keyed by a server secret, so:
 *
 *   - it cannot be guessed or forged: knowing a booking id, a booking
 *     reference, or somebody else's pass does not let you compute another;
 *   - it needs NO STORAGE. Every booking ever taken already has its passes —
 *     there is nothing to backfill, and nothing a booking edit can lose. (The
 *     participant subdocument is `_id: false` and rewritten wholesale when a
 *     booker changes a name, so a token stored on it would be wiped by the very
 *     edit the booker is allowed to make.)
 *
 * A pass names a SEAT, not a person: "seat 2 of booking X". A booker may change
 * who sits in seat 2 until the event starts; the staff screen shows the name on
 * the booking NOW, which is why the email tells the attendee to carry a
 * government ID. Revocation is by the booking: a cancelled booking's passes are
 * refused at the door.
 *
 * -------------------------------------------------------------- the secret
 *
 * `EVENT_PASS_SECRET` when set. Otherwise one derived from `JWT_SECRET`, so a
 * deployment works without a new variable — but rotating the JWT secret would
 * then void every pass already emailed, so production should set its own.
 */

const VERSION = 1;
const MAC_BYTES = 16;
const TOKEN_BYTES = 1 + 12 + 1 + MAC_BYTES;
const TOKEN_RE = /^[A-Za-z0-9_-]{40}$/;

let warned = false;
const secret = () => {
    const own = String(process.env.EVENT_PASS_SECRET || '').trim();
    if (own) return own;
    if (!warned && process.env.NODE_ENV === 'production') {
        warned = true;
        logger.warn('EVENT_PASS_SECRET is not set — event passes are keyed off JWT_SECRET. '
            + 'Rotating JWT_SECRET would void every pass already emailed.');
    }
    return crypto.createHmac('sha256', String(config.jwt.secret || '')).update('activ-event-pass-v1').digest('hex');
};

const macOf = (id, index) => crypto
    .createHmac('sha256', secret())
    .update(Buffer.concat([Buffer.from([VERSION]), id, Buffer.from([index])]))
    .digest()
    .subarray(0, MAC_BYTES);

const isObjectIdHex = (value) => /^[a-f0-9]{24}$/i.test(String(value || ''));

/** The pass token for seat `index` (0-based) of booking `bookingId`. '' when it cannot be made. */
const signPass = (bookingId, index) => {
    const idHex = String(bookingId || '');
    const seat = Number(index);
    if (!isObjectIdHex(idHex) || !Number.isInteger(seat) || seat < 0 || seat > 255) return '';
    const id = Buffer.from(idHex, 'hex');
    return Buffer.concat([Buffer.from([VERSION]), id, Buffer.from([seat]), macOf(id, seat)]).toString('base64url');
};

/** `{ bookingId, index }` for a genuine token, `null` for anything else. Never throws. */
const verifyPass = (token) => {
    try {
        const raw = String(token || '').trim();
        if (!TOKEN_RE.test(raw)) return null;
        const buf = Buffer.from(raw, 'base64url');
        if (buf.length !== TOKEN_BYTES || buf[0] !== VERSION) return null;
        const id = buf.subarray(1, 13);
        const index = buf[13];
        const expected = macOf(id, index);
        const given = buf.subarray(14);
        if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
        return { bookingId: id.toString('hex'), index };
    } catch (error) {
        return null;
    }
};

/**
 * The token out of whatever the scanner read: the full pass URL (any host —
 * a staging build scanning a production pass should still find the token),
 * a URL with a query string or trailing slash, or the bare token.
 */
const extractToken = (input) => {
    const text = String(input || '').trim();
    if (!text) return '';
    const fromUrl = text.match(/\/checkin\/([A-Za-z0-9_-]{40})(?:[/?#]|$)/);
    if (fromUrl) return fromUrl[1];
    return TOKEN_RE.test(text) ? text : '';
};

/** The address the QR opens: the website's harmless pass page. */
const passUrl = (token) => {
    if (!token) return '';
    const base = String(config.frontendUrl || '').replace(/\/+$/, '');
    return `${base}/checkin/${token}`;
};

/**
 * The human number for one seat: `<bookingRef>-P<n>`, n from 1.
 *
 * `-P` rather than a bare `-2` because a booking reference already ends in a
 * hex segment that can be all digits (`ACTIVB-MF3K2L-1234`), and a suffix that
 * could be part of the reference cannot be parsed back apart.
 */
const registrationNo = (bookingRef, index) => {
    const ref = String(bookingRef || '').trim().toUpperCase();
    return ref ? `${ref}-P${Number(index) + 1}` : '';
};

/** `{ bookingRef, index }` from a registration number, or from a bare reference (`index: null`). */
const parseRegistrationNo = (value) => {
    const text = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!text) return null;
    const match = text.match(/^(.+)-P(\d{1,3})$/);
    if (match) {
        const n = parseInt(match[2], 10);
        return n >= 1 ? { bookingRef: match[1], index: n - 1 } : null;
    }
    return { bookingRef: text, index: null };
};

module.exports = {
    signPass,
    verifyPass,
    extractToken,
    passUrl,
    registrationNo,
    parseRegistrationNo,
    TOKEN_RE
};
