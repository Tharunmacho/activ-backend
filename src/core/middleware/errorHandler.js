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