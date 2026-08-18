const mongoose = require('mongoose');
require('dotenv').config();

async function approveCandidate() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        const db = mongoose.connection.db;
        const email = 'tharunroobika@gmail.com';

        const authUser = await db.collection('web auth').findOne({ email });
        const userId = authUser ? authUser._id : new mongoose.Types.ObjectId();

        // 1. Update Application status to Approved
        await db.collection('applications').updateOne(
            { email },
            {
                $set: {
                    userId: userId,
                    user: userId,
                    fullName: 'Tharun Roobika',
                    email: email,
                    phoneNumber: '+919876543210',
                    state: 'Tamil Nadu',
                    district: 'Chennai',
                    block: 'Chennai North',
                    city: 'Chennai',
                    status: 'Approved',
                    blockApprovedAt: new Date(),
                    districtApprovedAt: new Date(),
                    stateApprovedAt: new Date(),
                    reviewedBy: {
                        blockAdmin: 'Admin-Block-01',
                        districtAdmin: 'Admin-District-01',
                        stateAdmin: 'Admin-State-01'
                    },
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
        console.log('✅ Application status updated to "Approved"');

        // 2. Update MemberDetails and web users profiles to Completed & Approved
        const approvedMemberDoc = {
            memberId: userId,
            fullName: 'Tharun Roobika',
            email: email,
            phoneNumber: '+919876543210',
            state: 'Tamil Nadu',
            district: 'Chennai',
            block: 'Chennai North',
            city: 'Chennai',
            profileCompleted: true,
            membershipStatus: 'approved',
            membershipType: 'premium',
            approvedAt: new Date(),
            membershipActivatedAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection('memberdetails').updateOne(
            { email },
            { $set: approvedMemberDoc },
            { upsert: true }
        );

        await db.collection('web users').updateOne(
            { email },
            { $set: approvedMemberDoc },
            { upsert: true }
        );
        console.log('✅ MemberDetails & web users profiles marked as Completed & Approved');

        console.log('\n═══════════════════════════════════════');
        console.log('🎉 Candidate tharunroobika@gmail.com is fully approved!');
        console.log('═══════════════════════════════════════');

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
    }
}

approveCandidate();
