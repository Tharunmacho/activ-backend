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

    /**
     * One admin dashboard payload, keyed by tier and by the region it is scoped
     * to — not by admin id. Co-admins on the same region share one queue by
     * construction, so they can share one cached answer; keying by id would
     * compute the identical payload once per person.
     */
    ADMIN_DASHBOARD: (tier, region) => `admin:dashboard:${tier}:${String(region || '').toLowerCase()}`,

    /**
     * ======================================================================
     * THESE TWO LIVE UNDER `admin:dashboard:` ON PURPOSE
     * ======================================================================
     *
     * `delPattern('admin:dashboard:*')` is what every approve and reject calls
     * (see `invalidateReviewCaches`), and the memory cache implements it as
     * `key.includes('admin:dashboard:')`. Anything under that prefix is
     * therefore cleared by a decision for free.
     *
     * Naming them `admin:directory:*` instead would have compiled, cached and
     * quietly served an admin the region counts from before their own approval
     * — the exact staleness the dashboard TTL was given an invalidation to
     * avoid. If either of these is ever renamed out of this prefix, it needs
     * its own line in `invalidateReviewCaches`.
     *
     * The directory is keyed by the ACTOR'S FORCED SCOPE as well as the level:
     * `getDirectory` narrows a tier admin to their own patch before it queries,
     * so two tiers asking for `level=block` are asking different questions and
     * must not share an answer.
     */
    ADMIN_DIRECTORY: (role, level, state, district) =>
        `admin:dashboard:directory:${role}:${level}:${String(state || '').toLowerCase()}`
        + `:${String(district || '').toLowerCase()}`,

    /** The super admin's platform-wide counters. One answer for everybody. */
    ADMIN_OVERVIEW: 'admin:dashboard:overview',

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
        ADMIN_DASHBOARD: 'admin:dashboard:*',
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