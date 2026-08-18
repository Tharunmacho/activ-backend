const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function debugLogin() {
    try {
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ MongoDB connected');

        // Check web auth collection
        const authCollection = mongoose.connection.db.collection('web auth');
        const authUsers = await authCollection.find({}).toArray();
        console.log('\n📋 Web Auth Collection:');
        console.log(`Total users: ${authUsers.length}`);
        authUsers.forEach(user => {
            console.log(`- Email: ${user.email}, Active: ${user.isActive}, Has Password: ${!!user.password}`);
        });

        // Check web users collection
        const usersCollection = mongoose.connection.db.collection('web users');
        const webUsers = await usersCollection.find({}).toArray();
        console.log('\n📋 Web Users Collection:');
        console.log(`Total users: ${webUsers.length}`);
        webUsers.forEach(user => {
            console.log(`- Email: ${user.email}, Role: ${user.role}`);
        });

        // Check if emails match between collections
        console.log('\n🔍 Email matching check:');
        const authEmails = new Set(authUsers.map(u => u.email));
        const userEmails = new Set(webUsers.map(u => u.email));
        
        authEmails.forEach(email => {
            if (!userEmails.has(email)) {
                console.log(`⚠️  Email in auth but not in users: ${email}`);
            }
        });
        
        userEmails.forEach(email => {
            if (!authEmails.has(email)) {
                console.log(`⚠️  Email in users but not in auth: ${email}`);
            }
        });

        await mongoose.disconnect();
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

debugLogin();
