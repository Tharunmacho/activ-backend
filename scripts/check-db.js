// Check database for existing user
const mongoose = require('mongoose');
const config = require('../src/config');

async function checkDatabase() {
    try {
        // Connect to MongoDB
        await mongoose.connect(config.db.uri);
        console.log('✅ Connected to MongoDB');

        // Check memberauths collection
        const memberAuthsCollection = mongoose.connection.db.collection('memberauths');
        const memberauths = await memberAuthsCollection.find({}).toArray();

        console.log('\n📊 memberauths collection:');
        console.log('Total documents:', memberauths.length);

        if (memberauths.length > 0) {
            console.log('\nFound users:');
            memberauths.forEach((user, index) => {
                console.log(`${index + 1}. Email: ${user.email}`);
                console.log(`   ID: ${user._id}`);
                console.log(`   isActive: ${user.isActive}`);
                console.log(`   Has password: ${!!user.password}`);
                console.log(`   Created: ${user.createdAt}`);
                console.log('');
            });
        } else {
            console.log('⚠️  No users found in memberauths collection');
        }

        // Check memberdetails collection
        const memberDetailsCollection = mongoose.connection.db.collection('memberdetails');
        const memberdetails = await memberDetailsCollection.find({}).toArray();

        console.log('\n📊 memberdetails collection:');
        console.log('Total documents:', memberdetails.length);

        if (memberdetails.length > 0) {
            console.log('\nFound member details:');
            memberdetails.forEach((member, index) => {
                console.log(`${index + 1}. Name: ${member.fullName}`);
                console.log(`   Email: ${member.email}`);
                console.log(`   Member ID: ${member.memberId}`);
                console.log(`   Membership Status: ${member.membershipStatus}`);
                console.log('');
            });
        }

        // Check if tharunroobika@gmail.com exists
        const targetEmail = 'tharunroobika@gmail.com';
        const targetUser = await memberAuthsCollection.findOne({ email: targetEmail });

        console.log(`\n🔍 Searching for: ${targetEmail}`);
        if (targetUser) {
            console.log('✅ User found in memberauths!');
            console.log('User details:', JSON.stringify({
                _id: targetUser._id,
                email: targetUser.email,
                isActive: targetUser.isActive,
                hasPassword: !!targetUser.password,
                lastLogin: targetUser.lastLogin,
                createdAt: targetUser.createdAt
            }, null, 2));

            const targetDetails = await memberDetailsCollection.findOne({ memberId: targetUser._id });
            if (targetDetails) {
                console.log('\n✅ Member details found!');
                console.log('Details:', JSON.stringify({
                    fullName: targetDetails.fullName,
                    phoneNumber: targetDetails.phoneNumber,
                    state: targetDetails.state,
                    membershipStatus: targetDetails.membershipStatus
                }, null, 2));
            }
        } else {
            console.log('❌ User NOT found in memberauths collection');
            console.log('\n💡 The user might be in the old schema. Let me check other collections...');

            // Check all collections
            const collections = await mongoose.connection.db.listCollections().toArray();
            console.log('\n📋 Available collections:');
            collections.forEach(coll => {
                console.log(`   - ${coll.name}`);
            });

            // Check old 'users' collection
            console.log('\n🔍 Checking old "users" collection...');
            const usersCollection = mongoose.connection.db.collection('users');
            const users = await usersCollection.find({}).toArray();
            console.log(`Found ${users.length} documents in users collection`);

            if (users.length > 0) {
                console.log('\n📊 Users in old collection:');
                users.forEach((user, index) => {
                    console.log(`\n${index + 1}. Email: ${user.email}`);
                    console.log(`   Full Name: ${user.fullName}`);
                    console.log(`   Phone: ${user.phoneNumber}`);
                    console.log(`   Role: ${user.role}`);
                    console.log(`   isActive: ${user.isActive}`);
                    console.log(`   Has password: ${!!user.password}`);
                });

                // Check for target user in old collection
                const oldTargetUser = await usersCollection.findOne({ email: targetEmail });
                if (oldTargetUser) {
                    console.log(`\n✅ Found ${targetEmail} in old users collection!`);
                    console.log('User data:', JSON.stringify(oldTargetUser, null, 2));
                }
            }

            // Check old 'members' collection
            console.log('\n🔍 Checking old "members" collection...');
            const membersCollection = mongoose.connection.db.collection('members');
            const members = await membersCollection.find({}).toArray();
            console.log(`Found ${members.length} documents in members collection`);

            if (members.length > 0) {
                console.log('\n📊 First 5 members in old collection:');
                members.slice(0, 5).forEach((member, index) => {
                    console.log(`\n${index + 1}. Email: ${member.email}`);
                    console.log(`   Full Name: ${member.fullName || 'N/A'}`);
                    console.log(`   Member ID: ${member._id}`);
                });
            }

            // Check applications collection
            console.log('\n🔍 Checking applications collection...');
            const applicationsCollection = mongoose.connection.db.collection('applications');
            const applications = await applicationsCollection.find({}).limit(5).toArray();
            console.log(`Found ${applications.length} documents in applications collection`);
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
        console.log('\n✅ Database connection closed');
    }
}

checkDatabase();