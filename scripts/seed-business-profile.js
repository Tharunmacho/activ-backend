const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function seedBusinessProfile() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const db = mongoose.connection.db;
        const email = 'pradeep@gmail.com';

        const authUser = await db.collection('users').findOne({ email });
        if (!authUser) {
            console.error('User not found');
            return;
        }

        const userId = authUser._id;

        // Create company record in business-profiles / companies collection
        const companyDoc = {
            userId: userId,
            businessName: 'Roobika Enterprise & Solutions',
            email: email,
            description: 'Leading Provider of Enterprise Software & Technical Solutions',
            businessType: 'Technology & IT Services',
            mobileNumber: '+919876543210',
            area: 'Chennai North Industrial Zone',
            location: 'Chennai, Tamil Nadu',
            status: 'active',
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('business_profiles_accounts').updateOne(
            { email },
            { $set: companyDoc },
            { upsert: true }
        );

        await db.collection('companies').updateOne(
            { email },
            { $set: companyDoc },
            { upsert: true }
        );

        console.log('✅ Created Active Business Company Profile for:', email);

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
    }
}

seedBusinessProfile();
