const { getRedisClient } = require('../../config/redis');
const logger = require('../../config/logger');

class CacheClient {
    constructor() {
        this.memoryCache = new Map();
        this.defaultTTL = 3600; // 1 hour
    }

    async get(key) {
        try {
            const redis = getRedisClient();

            if (redis) {
                const value = await redis.get(key);
                return value ? JSON.parse(value) : null;
            }

            // Fallback to memory cache
            const cached = this.memoryCache.get(key);
            if (cached && cached.expiry > Date.now()) {
                return cached.value;
            }

            return null;
        } catch (error) {
            logger.error('Cache get error:', error);
            return null;
        }
    }

    async set(key, value, ttl = this.defaultTTL) {
        try {
            const redis = getRedisClient();

            if (redis) {
                await redis.setEx(key, ttl, JSON.stringify(value));
            }

            // Also set in memory cache as backup
            this.memoryCache.set(key, {
                value,
                expiry: Date.now() + (ttl * 1000)
            });

            return true;
        } catch (error) {
            logger.error('Cache set error:', error);
            return false;
        }
    }

    async del(key) {
        try {
            const redis = getRedisClient();

            if (redis) {
                await redis.del(key);
            }

            this.memoryCache.delete(key);
            return true;
        } catch (error) {
            logger.error('Cache delete error:', error);
            return false;
        }
    }

    async delPattern(pattern) {
        try {
            const redis = getRedisClient();

            if (redis) {
                let cursor = 0;
                do {
                    const res = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
                    cursor = res.cursor;
                    const keys = res.keys;
                    if (keys.length > 0) {
                        await redis.del(keys);
                    }
                } while (cursor !== 0);
            }

            // Clear matching keys from memory cache
            for (const key of this.memoryCache.keys()) {
                if (key.includes(pattern.replace('*', ''))) {
                    this.memoryCache.delete(key);
                }
            }

            return true;
        } catch (error) {
            logger.error('Cache delete pattern error:', error);
            return false;
        }
    }

    async flush() {
        try {
            const redis = getRedisClient();

            if (redis) {
                await redis.flushDb();
            }

            this.memoryCache.clear();
            return true;
        } catch (error) {
            logger.error('Cache flush error:', error);
            return false;
        }
    }

    // Cleanup expired memory cache entries
    cleanupMemoryCache() {
        const now = Date.now();
        for (const [key, data] of this.memoryCache.entries()) {
            if (data.expiry <= now) {
                this.memoryCache.delete(key);
            }
        }
    }
}

// Singleton instance
const cacheClient = new CacheClient();

// Cleanup memory cache every 5 minutes
setInterval(() => cacheClient.cleanupMemoryCache(), 5 * 60 * 1000);

module.exports = cacheClient;