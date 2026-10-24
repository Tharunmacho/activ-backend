// Local testing uses the existing credentials without rewriting the deployment environment.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const port = Number(process.env.LOCAL_API_PORT || 5057);
process.env.FRONTEND_URL = process.env.LOCAL_FRONTEND_URL || 'http://localhost:8080';
process.env.BACKEND_URL = `http://localhost:${port}`;
process.env.PUBLIC_API_URL = `${process.env.BACKEND_URL}/api/v1`;
process.env.PUBLIC_MEDIA_URL = process.env.BACKEND_URL;
process.env.OAUTH_REDIRECT_BASE = `${process.env.BACKEND_URL}/api/v1/auth/oauth`;
const mongoose = require('mongoose');
const config = require('../src/config');
async function start() {
    let attempt = 0;
    for (;;) {
        try {
            await mongoose.connect(config.db.uri, {
                ...config.db.options, minPoolSize: 0, serverSelectionTimeoutMS: 15000,
                dbName: config.db.name, autoIndex: false, autoCreate: false,
            });
            break;
        } catch (error) {
            const reason = String(error?.message || error?.name || 'Unknown error').replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[database address]');
            if (/auth|password/i.test(reason) || !/timeout|timed out|ECONN|ENET|selection/i.test(reason)) throw error;
            const delay = Math.min(++attempt * 5000, 30000);
            console.error(`Local database connection unavailable; retrying in ${delay / 1000}s: ${reason}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    require('../src/app').listen(port, '127.0.0.1', () => {
        console.log(`Local API: http://localhost:${port}/api/v1; scheduled notifications are disabled.`);
        console.log(`Google authorized redirect URI for local testing: ${process.env.OAUTH_REDIRECT_BASE}/google/callback`);
    });
}
start().catch((error) => {
    const reason = String(error?.message || error?.name || 'Unknown error').replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[database address]');
    console.error(`Could not start the local API: ${reason}`);
    process.exit(1);
});
