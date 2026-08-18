// Cache key patterns
const CACHE_KEYS = {
    // User related
    USER: (id) => `user:${id}`,
    USER_EMAIL: (email) => `user:email:${email}`,
    USER_TOKEN: (id) => `user:token:${id}`,

    // Member related
    MEMBER: (id) => `member:${id}`,
    MEMBER_LIST: (filters) => `members:list:${JSON.stringify(filters)}`,
    MEMBER_STATUS: (id) => `member:status:${id}`,

    // Application related
    APPLICATION: (id) => `application:${id}`,
    APPLICATION_USER: (userId) => `application:user:${userId}`,
    APPLICATION_LIST: (filters) => `applications:list:${JSON.stringify(filters)}`,

    // Admin related
    ADMIN: (id) => `admin:${id}`,
    ADMIN_STATS: 'admin:stats',

    // Notifications
    NOTIFICATIONS: (userId) => `notifications:${userId}`,

    // Analytics
    ANALYTICS: (type, period) => `analytics:${type}:${period}`,

    // Patterns for bulk delete
    PATTERNS: {
        USER: 'user:*',
        MEMBER: 'member:*',
        APPLICATION: 'application:*',
        ADMIN: 'admin:*',
        NOTIFICATIONS: 'notifications:*',
        ANALYTICS: 'analytics:*'
    }
};

// Cache TTL in seconds
const CACHE_TTL = {
    SHORT: 60, // 1 minute
    MEDIUM: 300, // 5 minutes
    LONG: 1800, // 30 minutes
    HOUR: 3600, // 1 hour
    DAY: 86400 // 24 hours
};

module.exports = {
    CACHE_KEYS,
    CACHE_TTL
};