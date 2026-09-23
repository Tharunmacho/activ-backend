/**
 * What counts as a real Indian mobile number, and what is obviously made up.
 *
 * Written once, here, because three things need the same answer and must not
 * disagree about it: the registration validator, the WhatsApp field on the
 * member profile, and anything that later messages that number. Two copies of
 * a rule like this drift, and the drift shows up as a number the form accepted
 * and the messaging layer cannot use.
 *
 * ------------------------------------------------------------- what it checks
 *
 * 1. SHAPE. Ten digits, first digit 6-9. That is the whole of the Indian mobile
 *    numbering plan: 2-5 are landline trunk prefixes and 0/1 are reserved, so a
 *    "mobile" starting with any of them cannot be dialled, let alone reached on
 *    WhatsApp. `5551234567`, the American film convention, fails here.
 *
 * 2. FILLER. A number every digit of which is the same (`9999999999`), or which
 *    counts up or down (`9876543210`, `1234567890`), or which is one pair
 *    repeated five times (`9090909090`). These are what a person types when a
 *    form demands a number they do not want to give. They are all technically
 *    well-formed, which is exactly why a shape check alone lets them through.
 *
 * ------------------------------------------------ what it deliberately is NOT
 *
 * This does NOT prove the number is on WhatsApp, and nothing available can.
 * Meta's contacts endpoint was the lookup that used to answer that question and
 * it now returns "valid" for every number given to it, so it answers nothing;
 * BotBee publishes no contact-check endpoint of its own. The only real proof is
 * sending a code to the number and having it typed back, which is a decision
 * about the registration flow rather than about this file.
 *
 * So this is an honest filter and not a guarantee: it rejects numbers that
 * cannot be real, and accepts numbers that could be. `9876543210` is caught as
 * a descending run — which is the one legitimate-looking number people reach for
 * first — but a stranger's real number still passes, because from here it is
 * indistinguishable from the registrant's own.
 */

const {
    E164_MAX,
    DEFAULT_MIN,
    DEFAULT_COUNTRY,
    countryByIso2,
    countryFromDial
} = require('./countryCodes');

/** Digits only. `+91 98765-43210` and `919876543210` both reduce to ten. */
const digitsOnly = (value) => String(value === null || value === undefined ? '' : value).replace(/\D/g, '');

/**
 * The national ten digits, or '' if there aren't any.
 *
 * Strips a `+91`/`91`/`0091` country code and a domestic trunk `0` before
 * judging the length, so the same number is the same number however it was
 * typed. The trunk zero has to go BEFORE the length test or `09876543210`
 * reads as eleven digits and is rejected for being too long.
 */
const toNational = (value) => {
    let digits = digitsOnly(value);
    if (!digits) return '';

    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

    return digits;
};

/** Every digit the same: 9999999999. */
const isAllSameDigit = (n) => /^(\d)\1{9}$/.test(n);

/**
 * A run of consecutive digits in either direction.
 *
 * `9876543210` and `1234567890` are the two numbers people type most when they
 * want a form to stop asking. Checked as a walk rather than with a literal list
 * so that `4567890123` is caught too.
 */
const isSequential = (n) => {
    let up = true;
    let down = true;
    for (let i = 1; i < n.length; i += 1) {
        const step = Number(n[i]) - Number(n[i - 1]);
        if (step !== 1) up = false;
        if (step !== -1) down = false;
    }
    return up || down;
};

/** One two-digit pair repeated: 9090909090, 1212121212. */
const isRepeatedPair = (n) => n.length === 10 && n.slice(0, 2).repeat(5) === n;

/**
 * Judge one number.
 *
 * Returns `{ ok, national, e164, reason }` rather than throwing, so a caller can
 * decide whether a bad number is a 400 or a field-level message. `reason` is
 * written for the person who typed it, not for a log.
 */
const validateIndianMobile = (value, { label = 'Phone number' } = {}) => {
    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (!raw) {
        return { ok: false, national: '', e164: '', reason: `${label} is required` };
    }

    const national = toNational(raw);

    if (national.length !== 10) {
        return {
            ok: false,
            national: '',
            e164: '',
            reason: `${label} must be a 10-digit Indian mobile number`
        };
    }

    if (!/^[6-9]/.test(national)) {
        return {
            ok: false,
            national,
            e164: '',
            // Naming the rule beats "invalid": a person who typed their landline
            // needs to know it is the KIND of number that is wrong.
            reason: `${label} must start with 6, 7, 8 or 9 — that is what an Indian mobile number begins with`
        };
    }

    if (isAllSameDigit(national) || isSequential(national) || isRepeatedPair(national)) {
        return {
            ok: false,
            national,
            e164: '',
            reason: `${national} is not a real mobile number. Please enter the number you actually use.`
        };
    }

    return { ok: true, national, e164: `91${national}`, reason: '' };
};

/** True/false, for a validator chain that only wants a predicate. */
const isValidIndianMobile = (value) => validateIndianMobile(value).ok;

/* ---------------------------------------------------------------- worldwide */

/**
 * The same question, asked of a number that may not be Indian.
 *
 * WHY THIS EXISTS SEPARATELY. `validateIndianMobile` above is unchanged and
 * still the authority for Indian numbers — every existing caller, every stored
 * row and the mobile app all depend on its exact answer. This wraps it rather
 * than replacing it: an Indian number goes through the identical code path and
 * comes back with the identical `national`, so nothing about today's data
 * moves. Only numbers that are NOT Indian take the new branch, and before this
 * they were all rejected. It is a widening, not a change.
 *
 * ------------------------------------------------------------ how a country
 * is decided, and why no client has to send one
 *
 * A leading `+` is the discriminator. Every client that exists today posts a
 * bare ten digits, which has no `+`, so it resolves to India exactly as before
 * — this deploys without a coordinated client release. A client that means a
 * foreign number says so the only way a phone number can: `+44...`.
 *
 * An explicit `country` beats the prefix, for a caller that holds the answer
 * from a dropdown and should not have to re-encode it into the string.
 *
 * ------------------------------------------------------------ what is stored
 *
 * `stored` is what belongs in the column, and it is deliberately NOT uniform:
 *
 *   India  -> the bare ten national digits, no prefix   (9876543210)
 *   others -> full E.164 with the plus                  (+442071234567)
 *
 * Uniform E.164 would have been tidier and would have rewritten the format of
 * every number already in `users`, breaking `botbeeWebhook.findMemberByPhone`
 * and every lookup keyed on ten digits. The leading `+` is an unambiguous flag
 * for "this one is foreign", and a bare ten digits keeps meaning what it has
 * always meant.
 */
const validateMobile = (value, { country, label = 'Phone number' } = {}) => {
    const raw = String(value === null || value === undefined ? '' : value).trim();
    if (!raw) {
        return { ok: false, country: '', dial: '', national: '', e164: '', stored: '', reason: `${label} is required` };
    }

    // Explicit country wins; otherwise a '+' prefix speaks for itself; otherwise
    // India, which is what every un-updated client is sending.
    const chosen = countryByIso2(country)
        || (raw.startsWith('+') ? countryFromDial(raw) : undefined)
        || countryByIso2(DEFAULT_COUNTRY);

    if (chosen.iso2 === DEFAULT_COUNTRY) {
        const indian = validateIndianMobile(raw, { label });
        return {
            ...indian,
            country: DEFAULT_COUNTRY,
            dial: '91',
            stored: indian.ok ? indian.national : ''
        };
    }

    let digits = digitsOnly(raw);
    if (digits.startsWith('00')) digits = digits.slice(2);
    // Strip the dialling code only when it is actually there. Somebody who picks
    // a country and then types the national number alone has typed a valid
    // number, and chopping its first two digits off would make it invalid.
    if (digits.startsWith(chosen.dial) && digits.length > chosen.dial.length) {
        digits = digits.slice(chosen.dial.length);
    }
    // A domestic trunk '0' — how the number is printed in most of Europe and
    // Africa. Removed before the length is judged, for the same reason India's
    // is: otherwise the number as it appears on the handset reads as too long.
    if (digits.length > 1 && digits.startsWith('0')) digits = digits.slice(1);

    const national = digits;
    const min = chosen.min || DEFAULT_MIN;
    const max = chosen.max || Math.max(DEFAULT_MIN, E164_MAX - chosen.dial.length);

    if (national.length < min || national.length > max) {
        const expected = min === max ? `${min} digits` : `${min}–${max} digits`;
        return {
            ok: false,
            country: chosen.iso2,
            dial: chosen.dial,
            national: '',
            e164: '',
            stored: '',
            reason: `${label} must be ${expected} for ${chosen.name} (+${chosen.dial})`
        };
    }

    // The same filler test as India's, generalised off the fixed length of ten.
    // These are what gets typed when a form demands a number nobody wants to
    // give, and they are well-formed in every country, not just this one.
    const allSame = /^(\d)\1+$/.test(national);
    const pair = national.length >= 6 && national.length % 2 === 0
        && national.slice(0, 2).repeat(national.length / 2) === national;
    if (allSame || isSequential(national) || pair) {
        return {
            ok: false,
            country: chosen.iso2,
            dial: chosen.dial,
            national,
            e164: '',
            stored: '',
            reason: `${national} is not a real mobile number. Please enter the number you actually use.`
        };
    }

    return {
        ok: true,
        country: chosen.iso2,
        dial: chosen.dial,
        national,
        e164: `${chosen.dial}${national}`,
        stored: `+${chosen.dial}${national}`,
        reason: ''
    };
};

/**
 * The stored value, or `undefined` when the number cannot be used.
 *
 * `undefined` rather than `''` because every caller here writes into an update
 * object where a blank overwrites a good number with nothing, and `undefined`
 * is the value those loops already skip.
 */
const storedMobile = (value, country) => {
    const result = validateMobile(value, { country });
    return result.ok ? result.stored : undefined;
};

/**
 * Whether a number belongs to a member outside India, and which country.
 *
 * THE ONE PLACE THAT DECIDES IT. Registration, the profile form and the
 * application all ask this, from the stored number, so a member cannot be
 * "international" on one path and filed under an Indian block on another —
 * and a client cannot opt out of the region rules by sending a flag.
 *
 * An unusable number is NOT international: the Indian rules, which have
 * always applied, stay the default.
 */
const internationalFromPhone = (value) => {
    const result = validateMobile(value);
    if (!result.ok || result.country === DEFAULT_COUNTRY) return { international: false, country: '' };
    const entry = countryByIso2(result.country);
    return { international: true, country: (entry && entry.name) || result.country.toUpperCase() };
};

module.exports = {
    internationalFromPhone,
    digitsOnly,
    toNational,
    isAllSameDigit,
    isSequential,
    isRepeatedPair,
    validateIndianMobile,
    isValidIndianMobile,
    validateMobile,
    storedMobile
};
