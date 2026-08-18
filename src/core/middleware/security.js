const helmet = require('helmet');
const cors = require('cors');
const config = require('../../config');

const setupSecurity = (app) => {
    // Helmet - security headers
    app.use(helmet({
        contentSecurityPolicy: config.env === 'production',
        crossOriginEmbedderPolicy: config.env === 'production'
    }));

    // CORS
    app.use(cors({
        origin: config.cors.origin,
        credentials: config.cors.credentials,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Length', 'X-Request-Id']
    }));

    // Prevent parameter pollution
    app.use((req, res, next) => {
        if (req.query) {
            Object.keys(req.query).forEach(key => {
                if (Array.isArray(req.query[key]) && req.query[key].length > 1) {
                    req.query[key] = req.query[key][0];
                }
            });
        }
        next();
    });
};

module.exports = setupSecurity;