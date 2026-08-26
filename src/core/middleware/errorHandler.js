const config = require('../../config');
const logger = require('../../config/logger');
const ApiError = require('../utils/ApiError');

const errorHandler = (err, req, res, next) => {
    let { statusCode, message } = err;

    // A unique-index collision is a user-correctable conflict, not a server
    // fault. Left unmapped it surfaced as a bare 500 and the app showed a
    // generic failure instead of naming the field that clashed.
    if (err && err.code === 11000) {
        const field = Object.keys(err.keyValue || {})[0];
        const value = field ? err.keyValue[field] : '';
        statusCode = 409;
        message = field
            ? `That ${field} is already in use${value ? ` ("${value}")` : ''}. Please use a different one.`
            : 'That value is already in use. Please use a different one.';
        err.isOperational = true;
    }

    /**
     * A Mongoose validation failure is the user's input, not a server fault.
     *
     * Unmapped it left the handler as a 500 carrying a schema sentence —
     * "`Wholesaler` is not a valid enum value for path `businessType`" — which
     * tells the user their form crashed the server and tells the developer
     * nothing they could not see from the schema. It is a 400, and the field
     * messages are joined so more than one bad field is reported at once.
     */
    if (err && err.name === 'ValidationError' && err.errors) {
        statusCode = 400;
        message = Object.values(err.errors)
            .map((e) => e.message)
            .filter(Boolean)
            .join(' ') || 'Some of the values submitted are not valid.';
        err.isOperational = true;
    }

    // A malformed id reaching a query is a bad request, not a crash.
    if (err && err.name === 'CastError') {
        statusCode = 400;
        message = `"${err.value}" is not a valid ${err.path === '_id' ? 'id' : err.path}.`;
        err.isOperational = true;
    }

    if (config.env === 'production' && !err.isOperational) {
        statusCode = 500;
        message = 'Internal Server Error';
    }

    res.locals.errorMessage = err.message;

    const response = {
        success: false,
        statusCode: statusCode || 500,
        message,
        ...(config.env === 'development' && { stack: err.stack }),
    };

    if (config.env === 'development') {
        logger.error(err);
    }

    res.status(statusCode || 500).json(response);
};

const notFound = (req, res, next) => {
    next(ApiError.notFound(`Route ${req.originalUrl} not found`));
};

module.exports = {
    errorHandler,
    notFound
};