require('dotenv').config();

module.exports = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,
    apiVersion: process.env.API_VERSION || 'v1',

    db: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/activ-db',
        testUri: process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/activ-test',
        options: {
            /**
             * Connection pool sizing, tuned for a remote Atlas cluster.
             *
             * `minPoolSize` was unset, which defaults to 0: the pool starts
             * empty and opens a connection only when a query needs one. Every
             * such open is a TLS handshake plus SCRAM auth against a cluster
             * roughly 100ms away, which costs 1-3 seconds — and the server
             * reported 2,090 connections created against 14 currently open, so
             * this was happening constantly. That is the source of the
             * multi-second stalls that appeared at random on otherwise trivial
             * queries: the query was fast, opening the socket to send it was
             * not.
             *
             * Keeping five connections warm means the common case never pays
             * for a handshake. `maxIdleTimeMS` then retires anything above that
             * floor after a minute rather than holding the whole pool open.
             */
            minPoolSize: 5,
            maxPoolSize: 20,
            maxIdleTimeMS: 60000,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
        }
    },

    redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT, 10) || 6379,
        password: process.env.REDIS_PASSWORD || '',
        db: parseInt(process.env.REDIS_DB, 10) || 0,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    },

    jwt: {
        secret: process.env.JWT_SECRET || 'your-secret-key',
        expiresIn: process.env.JWT_EXPIRES_IN || '7d',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-refresh-secret',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
    },

    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 1000
    },

    cors: {
        origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'],
        credentials: true
    },

    email: {
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT, 10) || 587,
        user: process.env.EMAIL_USER,
        password: process.env.EMAIL_PASSWORD,
        from: process.env.EMAIL_FROM || 'ACTIV Platform <noreply@activ.com>'
    },

    upload: {
        maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 5 * 1024 * 1024,
        uploadDir: process.env.UPLOAD_DIR || './uploads'
    },

    log: {
        level: process.env.LOG_LEVEL || 'info',
        file: process.env.LOG_FILE || 'logs/app.log'
    },

    instamojo: {
        apiKey: process.env.INSTAMOJO_API_KEY || '',
        authToken: process.env.INSTAMOJO_AUTH_TOKEN || '',
        privateSalt: process.env.INSTAMOJO_PRIVATE_SALT || '',
        baseUrl: process.env.INSTAMOJO_BASE_URL || 'https://api.instamojo.com/v2'
    },

    payment: {
        /*
         * 'mock' lets the server sign its own payment orders, which is how the
         * flow works with no gateway account connected. It is refused when
         * NODE_ENV is 'production' regardless of what this says, so a forgotten
         * setting cannot ship a free-membership button.
         *
         * Set to 'gateway' once a real provider is wired in.
         */
        mode: process.env.PAYMENT_MODE || 'mock',
        /*
         * The key payment signatures are verified against. Falls back to the
         * JWT secret so a deployment that has not set it still signs with
         * something unguessable; a signature anyone can compute is not a check.
         * Becomes the gateway's key secret on integration.
         */
        signingSecret:
            process.env.PAYMENT_SIGNING_SECRET ||
            process.env.RAZORPAY_KEY_SECRET ||
            process.env.JWT_SECRET ||
            ''
    },

    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',

    admin: {
        /**
         * Shared passwords accepted for ANY admin account, in addition to that
         * account's own password.
         *
         * This exists only to keep the pre-seeded demo admins reachable while
         * the new super-admin creation flow is being verified. It is a genuine
         * authentication bypass: anyone who knows an admin's email address can
         * sign in as them, which defeats the geofence entirely.
         *
         * Empty by default, so it is off unless a deployment opts in. Remove
         * ADMIN_DEMO_PASSWORDS from the environment once real admins are being
         * created with their own credentials.
         */
        demoPasswords: String(process.env.ADMIN_DEMO_PASSWORDS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean),

        /**
         * Whether the legacy `adminsdb` mirror counts as real staffing for
         * region coverage. See `admin.repository.js`.
         */
        includeLegacyInCoverage:
            String(process.env.ADMIN_COVERAGE_INCLUDE_LEGACY || '').toLowerCase() === 'true'
    }
};