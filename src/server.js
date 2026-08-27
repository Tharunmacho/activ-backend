const http = require('http');
const app = require('./app');
const config = require('./config');
const connectDB = require('./config/db');
const { connectRedis, disconnectRedis } = require('./config/redis');
const logger = require('./config/logger');

// Create HTTP server
const server = http.createServer(app);

// Graceful shutdown
const gracefulShutdown = async() => {
    logger.info('Shutting down gracefully...');

    server.close(async() => {
        logger.info('HTTP server closed');

        try {
            await disconnectRedis();
            logger.info('Redis disconnected');

            // Mongoose will disconnect automatically via db.js cleanup
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    });

    // Force close after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown');
        process.exit(1);
    }, 10000);
};

// Start server
const startServer = async() => {
    try {
        // Connect to MongoDB
        await connectDB();

        // Warm the legacy `adminsdb` connection, which holds the per-tier admin
        // collections. Doing it here rather than on first use keeps the initial
        // admin request off the connection latency, and surfaces an unreachable
        // adminsdb at boot instead of as a failed admin creation later.
        const adminsDb = require('./modules/admin/adminsDb');
        const adminsDbReady = await adminsDb.ensureReady();
        if (adminsDbReady) logger.info('adminsdb connected (per-tier admin collections)');
        else logger.warn('adminsdb is unreachable — admin creation will fail until it recovers');

        // Connect to Redis (optional)
        const redisClient = await connectRedis();

        // Start listening
        server.listen(config.port, '0.0.0.0', () => {
            logger.info(`
╔═══════════════════════════════════════╗
║   ACTIV Backend Server Started   ║
╠═══════════════════════════════════════╣
║ Environment: ${config.env.padEnd(23)}║
║ Port: ${config.port.toString().padEnd(30)}║
║ API Version: ${config.apiVersion.padEnd(24)}║
║ MongoDB: Connected                    ║
║ Redis: ${(redisClient ? 'Connected' : 'Disconnected (memory cache)').padEnd(29)}║
╚═══════════════════════════════════════╝
      `);
        });

        // Handle shutdown signals
        process.on('SIGTERM', gracefulShutdown);
        process.on('SIGINT', gracefulShutdown);

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
};

// Handle uncaught exceptions.
// An uncaught *exception* leaves the process in an unknown state, so exiting is
// correct — the supervisor (pm2) restarts us.
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error && error.message}`, { stack: error && error.stack });
    process.exit(1);
});

/**
 * An unhandled *rejection* is usually one request's error escaping its handler.
 * Killing the process drops every other in-flight request and takes the API
 * down for all users — a bad-input 400 must never become an outage. Operational
 * errors (our own ApiError) are logged and shrugged off; anything else is
 * logged loudly but still does not take the server with it.
 */
process.on('unhandledRejection', (reason) => {
    const isOperational = reason && reason.isOperational === true;
    const message = (reason && reason.message) || String(reason);

    if (isOperational) {
        logger.warn(`Unhandled operational rejection (request-scoped, ignored): ${message}`);
        return;
    }

    logger.error(`Unhandled Rejection: ${message}`, { stack: reason && reason.stack });
});

// Start the server
startServer();