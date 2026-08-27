const redis = require('redis');
const config = require('./index');
const logger = require('./logger');

let redisClient = null;

/**
 * Whether Redis should be used at all.
 *
 * `REDIS_ENABLED` is the explicit switch. With it unset the connection is still
 * attempted when a host is configured, because a configured host is the clearest
 * statement of intent there is — the previous behaviour was to return `null`
 * before reaching any of the connection code, with the whole body commented out,
 * so `REDIS_HOST=localhost` in `.env` bought nothing and every `cacheClient`
 * call silently fell through to a per-process `Map`. That fallback is invisible:
 * it works, it just does not survive a restart and is not shared between
 * workers, so "we have Redis" and "we have no cache" look identical from
 * outside.
 */
const redisEnabled = () => {
    const flag = String(process.env.REDIS_ENABLED || '').trim().toLowerCase();
    if (flag === 'false' || flag === '0' || flag === 'no') return false;
    if (flag === 'true' || flag === '1' || flag === 'yes') return true;
    // `config.redis.host` defaults to 'localhost', so it is never empty and
    // cannot be the signal. The raw environment variable is what says a Redis
    // was actually provisioned — otherwise every production boot would spend
    // its connect timeout dialling a localhost that isn't there.
    return !!String(process.env.REDIS_HOST || '').trim();
};

const connectRedis = async() => {
    if (!redisEnabled()) {
        logger.info('Redis disabled - using in-process memory cache', {
            hint: 'set REDIS_HOST (and REDIS_ENABLED=true) to enable'
        });
        return null;
    }

    try {
        redisClient = redis.createClient({
            socket: {
                host: config.redis.host,
                port: config.redis.port,
                // Without a ceiling the client retries forever with an
                // ever-growing delay and never reports that it gave up, so a
                // wrong host reads as "starting up" indefinitely.
                connectTimeout: 3000,
                /*
                 * One attempt, then stop.
                 *
                 * Six retries produced six `error` lines and six `reconnecting`
                 * lines on every nodemon restart before the fallback line that
                 * actually mattered - and on a machine with no Redis installed,
                 * every one of those retries was always going to fail. There is
                 * nothing to wait for: if the socket is refused, no Redis is
                 * listening, and the memory cache takes over immediately.
                 */
                reconnectStrategy: () => false
            },
            password: config.redis.password || undefined,
            database: config.redis.db
        });

        // An 'error' event with no listener is thrown, which on a background
        // reconnect would take the process down. Log and carry on: the cache
        // client already treats an absent Redis as a cache miss.
        /*
         * A refused connection is not an error worth a stack of red lines.
         *
         * The listener has to exist - an unhandled 'error' event on a redis
         * client is thrown, which on a background reconnect would take the
         * process down. But ECONNREFUSED simply means nothing is listening, and
         * the warning below says so once, in one line.
         */
        let reported = false;
        redisClient.on('error', (err) => {
            const code = err && (err.code || (err.errors && err.errors[0] && err.errors[0].code));
            if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
                if (!reported) {
                    reported = true;
                    logger.warn('Redis is not reachable - using the in-process memory cache', {
                        host: config.redis.host, port: config.redis.port, code
                    });
                }
                return;
            }
            logger.error('Redis client error', { error: err && err.message });
        });
        redisClient.on('connect', () => logger.info('Redis connected'));

        await redisClient.connect();
        logger.info('Redis ready', { host: config.redis.host, port: config.redis.port });
        return redisClient;
    } catch (error) {
        // Never fatal. A cache is an optimisation, and refusing to boot without
        // one turns a slow platform into an offline one.
        logger.warn('Redis unavailable - falling back to in-process memory cache', {
            host: config.redis && config.redis.host,
            error: error && error.message
        });
        redisClient = null;
        return null;
    }
};

const getRedisClient = () => {
    if (!redisClient || !redisClient.isOpen) {
        // logger.warn('Redis client not available'); // Commented out to prevent log spam
        return null;
    }
    return redisClient;
};

const disconnectRedis = async() => {
    if (redisClient && redisClient.isOpen) {
        await redisClient.quit();
        logger.info('Redis disconnected');
    }
};

module.exports = {
    connectRedis,
    getRedisClient,
    disconnectRedis
};