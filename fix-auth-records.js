const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function fixMissingAuthRecords() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ MongoDB connected');

        // Get auth collection
        const authCollection = mongoose.connection.db.collection('web auth');
        
        // Users who need auth records
        const usersNeedingAuth = [
            'rani123@gmail.com',
            'maniii@gmail.com',
            'manii@gmail.com',
            'sasvanth@gmail.com',
            'diya@gmail.com',
            'vino@gmail.com'
        ];

        // Default password for all users (they should change it after first login)
        const defaultPassword = 'Password@123';
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(defaultPassword, salt);

        console.log('\n🔧 Creating auth records...');
        
        for (const email of usersNeedingAuth) {
            // Check if already exists
            const exists = await authCollection.findOne({ email });
            
            if (exists) {
                console.log(`⚠️  ${email} already has auth record`);
                continue;
            }

            // Create auth record
            await authCollection.insertOne({
                email: email,
                password: hashedPassword,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date()
            });
            
            console.log(`✅ Created auth record for ${email}`);
        }

        console.log('\n📝 Summary:');
        console.log('Default password for all new users: Password@123');
        console.log('⚠️  Users should change their password after first login');

        await mongoose.disconnect();
        console.log('\n✅ Done!');
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

fixMissingAuthRecords();
