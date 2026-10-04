// Local testing uses the existing credentials without rewriting the deployment environment.
require('dotenv').config();
const port = Number(process.env.LOCAL_API_PORT || 5057);
process.env.FRONTEND_URL = process.env.LOCAL_FRONTEND_URL || 'http://localhost:8080';
process.env.BACKEND_URL = `http://localhost:${port}`;
process.env.PUBLIC_API_URL = `${process.env.BACKEND_URL}/api/v1`;
process.env.PUBLIC_MEDIA_URL = process.env.BACKEND_URL;
process.env.OAUTH_REDIRECT_BASE = `${process.env.BACKEND_URL}/api/v1/auth/oauth`;
const mongoose = require('mongoose');
const config = require('../src/config');
mongoose.connect(config.db.uri, { ...config.db.options, dbName: config.db.name })
    .then(() => require('../src/app').listen(port, '127.0.0.1', () => {
        console.log(`Local API: http://localhost:${port}/api/v1; scheduled notifications are disabled.`);
        console.log(`Google authorized redirect URI for local testing: ${process.env.OAUTH_REDIRECT_BASE}/google/callback`);
    }))
    .catch(() => { console.error('Could not start the local API.'); process.exit(1); });
