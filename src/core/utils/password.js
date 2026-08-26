const crypto = require('crypto');

/**
 * Password generation for accounts a super admin creates on someone else's
 * behalf — bulk CSV onboarding in particular, where a thousand admins each need
 * a credential nobody has ever typed.
 */

// Ambiguous glyphs are excluded on purpose. These passwords get read off a
// screen and retyped from a welcome email, and `l` / `1` / `I` and `O` / `0`
// are where that goes wrong.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*?';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

/**
 * A uniformly random character from `alphabet`.
 *
 * `crypto.randomInt` is rejection-sampled internally, so unlike
 * `randomBytes()[0] % alphabet.length` it does not bias the first few
 * characters of the alphabet.
 */
const pick = (alphabet) => alphabet[crypto.randomInt(0, alphabet.length)];

/**
 * A random password guaranteed to satisfy the platform's 8-character minimum
 * plus one character from each class, so a generated credential can never be
 * rejected by the same validator that accepted the request.
 */
const generatePassword = (length = 14) => {
    const size = Math.max(12, Number(length) || 14);

    const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
    const rest = Array.from({ length: size - required.length }, () => pick(ALL));
    const chars = [...required, ...rest];

    // Fisher-Yates with a CSPRNG, so the guaranteed classes are not always in
    // the first four positions.
    for (let i = chars.length - 1; i > 0; i -= 1) {
        const j = crypto.randomInt(0, i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
};

module.exports = { generatePassword };
