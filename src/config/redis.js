const redis = require('redis');
const config = require('./index');
const logger = require('./logger');

let redisClient = null;

const connectRedis = async() => {
    // Skip Redis connection if not available
    logger.info('Redis connection skipped - using memory cache fallback');
    return null;

    /* Uncomment to enable Redis
    try {
        redisClient = redis.createClient({
            socket: {
                host: config.redis.host,
                port: config.redis.port,
            },
            password: config.redis.password || undefined,
            database: config.redis.db,
            retryStrategy: config.redis.retryStrategy
        });

        redisClient.on('error', (err) => {
            logger.error('Redis Client Error:', err);
        });

        redisClient.on('connect', () => {
            logger.info('Redis connected');
        });

        redisClient.on('reconnecting', () => {
            logger.warn('Redis reconnecting...');
        });

        await redisClient.connect();

        return redisClient;
    } catch (error) {
        logger.error('Redis connection failed:', error);
        // Don't exit - app can work without Redis
        return null;
    }
    */
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