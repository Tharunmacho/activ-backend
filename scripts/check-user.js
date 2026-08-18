const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const showRecentUsers = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB\n');

        // Get last 10 users from web users collection sorted by createdAt
        const recentUsers = await mongoose.connection.db.collection('web users')
            .find({})
            .sort({ createdAt: -1 })
            .limit(10)
            .toArray();

        console.log('=== LAST 10 REGISTERED USERS (Most Recent First) ===\n');
        
        recentUsers.forEach((user, index) => {
            console.log(`${index + 1}. ${user.fullName || 'N/A'} (${user.email})`);
            console.log(`   Phone: ${user.phoneNumber || 'N/A'}`);
            console.log(`   Location: ${user.city || 'N/A'}, ${user.district || 'N/A'}, ${user.state || 'N/A'}`);
            console.log(`   Role: ${user.role || 'member'}`);
            console.log(`   Created: ${user.createdAt}`);
            console.log(`   Has Password: ${user.password ? 'Yes' : 'No'}`);
            console.log('');
        });

        const totalCount = await mongoose.connection.db.collection('web users').countDocuments();
        console.log(`\nTotal users in "web users" collection: ${totalCount}`);

        await mongoose.connection.close();
        console.log('\nConnection closed');
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

showRecentUsers();
