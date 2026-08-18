// Create test user in database
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../src/config');

async function createTestUser() {
    try {
        // Connect to MongoDB
        await mongoose.connect(config.db.uri);
        console.log('✅ Connected to MongoDB');

        const email = 'tharunroobika@gmail.com';
        const password = 'tharun2005';

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Sync in web auth
        const webAuthCol = mongoose.connection.db.collection('web auth');
        await webAuthCol.updateOne(
            { email },
            { $set: { email, password: hashedPassword, isActive: true, updatedAt: new Date() } },
            { upsert: true }
        );

        // Sync in web users
        const webUsersCol = mongoose.connection.db.collection('web users');
        await webUsersCol.updateOne(
            { email },
            {
                $set: {
                    fullName: 'Tharun Roobika',
                    email: email,
                    phoneNumber: '+919876543210',
                    state: 'Tamil Nadu',
                    district: 'Chennai',
                    block: 'Chennai North',
                    city: 'Chennai',
                    role: 'member',
                    isActive: true,
                    profileCompleted: false,
                    membershipStatus: 'pending',
                    membershipType: 'none',
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );

        // Sync in memberauths
        const memberAuthsCol = mongoose.connection.db.collection('memberauths');
        await memberAuthsCol.updateOne(
            { email },
            { $set: { email, password: hashedPassword, isActive: true, updatedAt: new Date() } },
            { upsert: true }
        );

        // Sync in memberdetails
        const memberDetailsCol = mongoose.connection.db.collection('memberdetails');
        await memberDetailsCol.updateOne(
            { email },
            {
                $set: {
                    fullName: 'Tharun Roobika',
                    email: email,
                    phoneNumber: '+919876543210',
                    state: 'Tamil Nadu',
                    district: 'Chennai',
                    block: 'Chennai North',
                    city: 'Chennai',
                    role: 'member',
                    isActive: true,
                    profileCompleted: false,
                    membershipStatus: 'pending',
                    membershipType: 'none',
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );

        console.log('✅ Credentials synced across web auth, web users, memberauths, and memberdetails!');

        console.log('\n═══════════════════════════════════════');
        console.log('✅ Test user created successfully!');
        console.log('═══════════════════════════════════════');
        console.log('\n📝 Login Credentials:');
        console.log('   Email:', email);
        console.log('   Password:', password);
        console.log('\n💡 You can now run: node test-auth.js');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error);
    } finally {
        await mongoose.connection.close();
        console.log('\n✅ Database connection closed');
    }
}

createTestUser();