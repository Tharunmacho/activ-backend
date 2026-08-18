const logger = require('../../config/logger');

const performanceMonitor = (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logMessage = `${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`;

        if (duration > 1000) {
            logger.warn(`Slow request: ${logMessage}`);
        } else {
            logger.http(logMessage);
        }
    });

    next();
};

const requestLogger = (req, res, next) => {
    logger.info(`Incoming: ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        userAgent: req.get('user-agent')
    });
    next();
};

module.exports = {
    performanceMonitor,
    requestLogger
};