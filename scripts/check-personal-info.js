const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const checkPersonalInfo = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB\n');

        // Check PersonalInfo1 collection
        const personalInfos = await mongoose.connection.db.collection('personalinfo1s')
            .find({})
            .sort({ createdAt: -1 })
            .limit(10)
            .toArray();

        console.log('=== LAST 10 PERSONAL INFO RECORDS ===\n');
        
        if (personalInfos.length === 0) {
            console.log('No records found in personalinfo1s collection');
        } else {
            personalInfos.forEach((info, index) => {
                console.log(`${index + 1}. ${info.name || 'N/A'}`);
                console.log(`   User ID: ${info.userId || 'N/A'}`);
                console.log(`   Phone: ${info.phoneNumber || 'N/A'}`);
                console.log(`   Location: ${info.city || 'N/A'}, ${info.block || 'N/A'}, ${info.district || 'N/A'}, ${info.state || 'N/A'}`);
                console.log(`   Religion: ${info.religion || 'N/A'}`);
                console.log(`   Social Category: ${info.socialCategory || 'N/A'}`);
                console.log(`   Created: ${info.createdAt}`);
                console.log('');
            });
        }

        const totalCount = await mongoose.connection.db.collection('personalinfo1s').countDocuments();
        console.log(`\nTotal records in personalinfo1s collection: ${totalCount}`);

        // Also show web users for comparison
        const users = await mongoose.connection.db.collection('web users')
            .find({})
            .sort({ createdAt: -1 })
            .limit(5)
            .toArray();

        console.log('\n=== LAST 5 WEB USERS FOR COMPARISON ===\n');
        users.forEach((user, index) => {
            console.log(`${index + 1}. ${user.fullName || 'N/A'} (${user.email})`);
            console.log(`   User ID: ${user._id}`);
            console.log(`   Phone: ${user.phoneNumber || 'N/A'}`);
            console.log('');
        });

        await mongoose.connection.close();
        console.log('\nConnection closed');
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

checkPersonalInfo();
