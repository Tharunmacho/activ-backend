const mongoose = require('mongoose');
const config = require('../../config');
const logger = require('../../config/logger');

/**
 * The single connection to the legacy `adminsdb` database.
 *
 * Four admin models each used to call `mongoose.createConnection()` themselves,
 * so requiring all of them opened four sockets to the same database — and one
 * of them read `config.mongodb.uri`, a key that does not exist, so merely
 * requiring it threw. Both problems are fixed by having exactly one place that
 * knows how to reach `adminsdb`.
 *
 * This database exists because admin accounts were originally kept apart from
 * application data. Login authenticates against the *main* database's `admins`
 * collection, so anything living only here is invisible to sign-in — which is
 * why `admin.repository` reads both and treats them as one namespace.
 */

const uri = String(config.db.uri || '').replace(/\/activ-db(\?|$)/, '/adminsdb$1');

let connection = null;

const getConnection = () => {
    if (connection) return connection;

    try {
        connection = mongoose.createConnection(uri, {
            maxPoolSize: 5,
            serverSelectionTimeoutMS: 5000
        });

        connection.on('error', (err) => {
            // Never fatal. The main database holds the authoritative `admins`
            // collection; this one is a legacy mirror, and the platform has to
            // keep working when it is unreachable.
            logger.warn('adminsdb connection error', { error: err && err.message });
        });
    } catch (err) {
        logger.warn('Could not open the adminsdb connection', { error: err && err.message });
        connection = null;
    }

    return connection;
};

/** True once the connection is usable, so callers can skip it rather than hang. */
const isReady = () => !!connection && connection.readyState === 1;

/**
 * Open the connection and wait for it, once.
 *
 * `isReady()` alone is a trap: it is false both when the connection has failed
 * *and* when it has never been opened, and a caller that checks it before
 * calling `getConnection()` never opens anything. Since this database is now
 * where admin accounts are written, that silently turned every create into
 * "adminsdb is unavailable".
 *
 * Resolves to a boolean rather than throwing, so a caller can degrade instead of
 * failing a request the main database could have served. The promise is
 * memoised, so a hundred concurrent requests wait on one connection attempt
 * rather than starting a hundred.
 */
let readyPromise = null;

const ensureReady = async() => {
    if (isReady()) return true;

    if (!readyPromise) {
        const connectionToAwait = getConnection();
        if (!connectionToAwait) return false;

        readyPromise = connectionToAwait.asPromise()
            .then(() => true)
            .catch((err) => {
                logger.warn('adminsdb did not become ready', { error: err && err.message });
                // Cleared so a later request retries rather than being stuck with
                // a cached failure for the life of the process.
                readyPromise = null;
                return false;
            });
    }

    return readyPromise;
};

module.exports = { getConnection, isReady, ensureReady, uri };
