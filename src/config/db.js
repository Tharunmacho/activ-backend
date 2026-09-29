const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

/**
 * ============================================================================
 * CONNECTING IS RETRIED — one bad DNS answer must not kill the server
 * ============================================================================
 *
 * This made a single attempt and called `process.exit(1)` on any failure. The
 * failure that actually happens is not "the database is down", it is this:
 *
 *     MongoDB connection failed: querySrv ECONNREFUSED
 *                                _mongodb._tcp.cluster1.gf7usct.mongodb.net
 *
 * A `mongodb+srv://` URI has to resolve a DNS **SRV** record before it can
 * reach anything, so the very first thing every start does is a DNS query. On
 * a laptop tethered to a phone, or anywhere the first resolver in the list is
 * an IPv6 address that is not currently reachable, that query is refused —
 * and the process died, with a message that reads as though Atlas were down.
 * Seconds later the same lookup succeeds; it was verified doing exactly that.
 *
 * So the connection is retried with a widening gap. Five attempts over about
 * half a minute covers a resolver blip, a laptop waking up, and a container
 * that started before its network did — which is the same fault on a server,
 * where it shows up as a restart loop rather than as one error.
 *
 * IT STILL GIVES UP. A wrong password or a cluster that is genuinely gone
 * must not leave the process sitting in a retry loop pretending to boot, so
 * after the last attempt it exits as it always did. The difference is that it
 * exits having actually tried.
 */
const ATTEMPTS = 5;

/** 1s, 2s, 4s, 8s — capped, so the last wait is not half a minute. */
const backoffMs = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 8000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this worth trying again?
 *
 * A network or DNS fault is transient by nature. An authentication failure is
 * not: retrying a wrong password four more times only delays the message the
 * operator needs to read, and hammers the cluster while doing it.
 */
const isTransient = (error) => {
    const code = String((error && error.code) || '');
    const message = String((error && error.message) || '');

    if (/AuthenticationFailed|bad auth|not authorized/i.test(message)) return false;

    return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ECONNRESET/.test(code)
        || /querySrv|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|getaddrinfo/i.test(message);
};

const connectDB = async() => {
    const uri = config.env === 'test' ? config.db.testUri : config.db.uri;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
            await mongoose.connect(uri, config.db.options);

            logger.info(`MongoDB connected: ${mongoose.connection.host}`);

            mongoose.connection.on('error', (err) => {
                logger.error('MongoDB connection error:', err);
            });

            mongoose.connection.on('disconnected', () => {
                logger.warn('MongoDB disconnected');
            });

            process.on('SIGINT', async() => {
                await mongoose.connection.close();
                logger.info('MongoDB connection closed through app termination');
                process.exit(0);
            });

            return;
        } catch (error) {
            const last = attempt === ATTEMPTS;
            const retryable = isTransient(error);

            if (last || !retryable) {
                logger.error(
                    `MongoDB connection failed after ${attempt} attempt(s): ${error && error.message}`
                );
                /*
                 * Named explicitly, because "connection failed" on an SRV URI
                 * sends people to check the cluster when the thing that failed
                 * was a DNS query on their own machine.
                 */
                if (retryable) {
                    logger.error(
                        'This looks like a network or DNS fault rather than a database one. '
                        + 'A mongodb+srv:// URI resolves a DNS SRV record first, so check '
                        + 'connectivity and the resolver before checking Atlas.'
                    );
                }
                process.exit(1);
            }

            const pause = backoffMs(attempt);
            logger.warn(
                `MongoDB connection attempt ${attempt}/${ATTEMPTS} failed `
                + `(${error && error.message}). Retrying in ${pause}ms…`
            );
            await wait(pause);
        }
    }
};

module.exports = connectDB;
