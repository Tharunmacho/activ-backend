require('dotenv').config();
const mongoose = require('mongoose');
const Application = require('../src/modules/applications/application.model');
const MemberAuth = require('../src/modules/auth/auth.model');
const MemberDetails = require('../src/modules/members/memberdetails.model');
const NotificationLog = require('../src/modules/notifications/notificationLog.model');

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/activ-db';

async function checkLatestRegistration() {
    try {
        await mongoose.connect(mongoUri);
        console.log('--- LATEST MEMBER DETAILS ---');
        const members = await MemberDetails.find().sort({ createdAt: -1 }).limit(3);
        console.log(JSON.stringify(members, null, 2));

        console.log('--- LATEST APPLICATIONS ---');
        const apps = await Application.find().sort({ createdAt: -1 }).limit(3);
        console.log(JSON.stringify(apps, null, 2));

        console.log('--- LATEST NOTIFICATION LOGS ---');
        const logs = await NotificationLog.find().sort({ createdAt: -1 }).limit(5);
        console.log(JSON.stringify(logs, null, 2));

        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkLatestRegistration();
