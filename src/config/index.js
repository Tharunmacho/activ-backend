require('dotenv').config();

module.exports = {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT, 10) || 5000,
    apiVersion: process.env.API_VERSION || 'v1',

    db: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/activ-db',
        testUri: process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/activ-test',
        options: {
            maxPoolSize: 10,
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

    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    backendUrl: process.env.BACKEND_URL || 'http://localhost:5000'
};