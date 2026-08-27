/**
 * The one place password hashing is obtained from.
 *
 * `bcryptjs` is a pure-JavaScript bcrypt. It produces correct, interoperable
 * hashes, but it does the whole key-expansion on the single JS thread, so every
 * hash and every compare freezes the entire process for its duration. Measured
 * on this codebase at cost 10: eight concurrent hashes stall the event loop for
 * ~730ms with `bcryptjs` and ~12ms with the native binding, because the native
 * one runs on the libuv threadpool and the eight overlap instead of queueing.
 *
 * That stall is what made one registration slow down every unrelated request
 * around it — a burst of 1.4s profile reads and a 3.7s event list sitting
 * either side of a 9.4s POST /auth/register in the production log.
 *
 * The two implementations are hash-compatible in both directions (verified:
 * native verifies a `bcryptjs` $2a$ hash and vice versa), so switching is
 * transparent to every credential already stored.
 *
 * The native module is a compiled addon and can fail to load on a host whose
 * build step did not produce a binary for its platform. Falling back keeps such
 * a deployment working — slowly, and saying so — instead of refusing to boot.
 */

let impl;
let native = false;

try {
    impl = require('bcrypt');
    native = true;
} catch (err) {
    impl = require('bcryptjs');
    // eslint-disable-next-line no-console
    console.warn(
        '[passwordHash] native bcrypt unavailable, falling back to bcryptjs. ' +
        'Hashing will block the event loop and slow every concurrent request. ' +
        'Reason:', err && err.message
    );
}

/** Work factor. Kept at 10 so existing hashes verify without a rehash. */
const ROUNDS = 10;

module.exports = {
    isNative: native,
    ROUNDS,
    genSalt: (rounds = ROUNDS) => impl.genSalt(rounds),
    hash: (data, saltOrRounds = ROUNDS) => impl.hash(data, saltOrRounds),
    compare: (data, encrypted) => impl.compare(data, encrypted)
};
