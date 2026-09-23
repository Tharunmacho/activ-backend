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

        /*
         * EVERY LINK IN EVERY MESSAGE COMES FROM `FRONTEND_URL`.
         *
         * Notification emails and WhatsApp messages carry absolute links built
         * from it — "Complete your application", "Pay now", "Track your
         * application". Left at localhost while a real mail host and a real
         * WhatsApp provider are configured, the platform sends real members
         * links to their own machine, and every one of them is a dead end that
         * nothing reports: the mail is delivered, the send succeeds, the log row
         * is green, and the member simply cannot get in.
         *
         * Checked at boot rather than at send time because there is no send-time
         * surface anyone watches, and because the answer never varies between
         * one message and the next — it is a deployment fact, and boot is when
         * deployment facts are worth stating.
         *
         * Local development trips neither branch: with no SMTP host and no
         * BotBee token, a localhost URL is simply correct.
         */
        const frontendIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2)(:|\/|$)/i
            .test(String(config.frontendUrl || ''));
        const messagingIsLive = !!(config.email && config.email.host) || config.botbee.isConfigured;

        if (frontendIsLocal && messagingIsLive) {
            logger.warn(
                'FRONTEND_URL is a local address while messaging is configured — '
                + 'every link sent to a member will be a dead end',
                {
                    frontendUrl: config.frontendUrl,
                    email: !!(config.email && config.email.host),
                    whatsapp: config.botbee.isConfigured
                }
            );
        }

        // Connect to Redis (optional)
        const redisClient = await connectRedis();

        /*
         * Warm the admin roster before the port opens, then keep it warm.
         *
         * Every dashboard needs the roster (for the admin's own scope) and the
         * coverage map built from it (for orphan-fallback routing). Both come
         * from one scan of eight collections — 448 rows, already parallel and
         * projected, but ~3.5s against the remote cluster because the cost is
         * round trips rather than work. Measured cold, a district dashboard took
         * 9.2s end to end; warm it is 0.7s.
         *
         * `findAll` already spares callers a refresh inside its five-minute
         * stale window, so the only requests that ever paid full price were the
         * first one after a restart and the first one after five idle minutes.
         * This closes both, off the request path.
         *
         * Awaited, so the first admin to load a dashboard after a deploy does
         * not race the warm-up — and non-fatal, because a warm-up is an
         * optimisation and must never stop the server coming up.
         */
        const adminRepository = require('./modules/admin/admin.repository');
        await adminRepository.startRosterRefresh().catch((err) => {
            logger.warn('Admin roster warm-up failed; first request will be slower', {
                error: err && err.message
            });
        });

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