require('dotenv').config();
const mongoose = require('mongoose');
const config = require('./src/config');
const User = require('./src/modules/auth/auth.model');
const MemberDetails = require('./src/modules/members/memberdetails.model');
const Application = require('./src/modules/applications/application.model');
const PaymentOrder = require('./src/modules/payment/paymentorder.model');

async function clearSpecificUsers() {
    try {
        console.log('Connecting to DB...');
        await mongoose.connect(config.db.uri);
        
        const searchRegexName1 = /tharun v/i;
        const searchRegexName2 = /tharunroobika/i;
        const searchRegexPhone = /9092317264/i;

        const usersToClear = await MemberDetails.find({
            $or: [
                { fullName: searchRegexName1 },
                { fullName: searchRegexName2 },
                { phoneNumber: searchRegexPhone },
                { email: /tharunroobika/i },
                { email: /tharun/i }
            ]
        });

        const authsToClear = await User.find({
            $or: [
                { email: /tharunroobika/i },
                { email: /tharun/i },
                { email: /tharun v/i }
            ]
        });

        const appsToClear = await Application.find({
            $or: [
                { fullName: searchRegexName1 },
                { fullName: searchRegexName2 },
                { phone: searchRegexPhone },
                { email: /tharunroobika/i },
                { email: /tharun/i }
            ]
        });

        const userIds = [...new Set([
            ...usersToClear.map(u => (u.userId ? u.userId.toString() : u._id.toString())),
            ...authsToClear.map(u => u._id.toString()),
            ...appsToClear.map(a => (a.userId ? a.userId.toString() : null)).filter(Boolean)
        ])];

        const emails = [...new Set([
            ...usersToClear.map(u => u.email),
            ...authsToClear.map(u => u.email),
            ...appsToClear.map(a => a.email)
        ])];

        console.log('Found user IDs:', userIds);
        console.log('Found emails:', emails);

        if (userIds.length > 0 || emails.length > 0) {
            const authRes = await User.deleteMany({ 
                $or: [
                    { _id: { $in: userIds } },
                    { email: { $in: emails } }
                ] 
            });
            console.log('- ' + authRes.deletedCount + ' Auth accounts');

            const mdRes = await MemberDetails.deleteMany({ 
                $or: [
                    { userId: { $in: userIds } },
                    { _id: { $in: userIds } },
                    { email: { $in: emails } }
                ]
            });
            console.log('- ' + mdRes.deletedCount + ' Member Profiles (users)');

            const appRes = await Application.deleteMany({ 
                $or: [
                    { userId: { $in: userIds } },
                    { email: { $in: emails } }
                ]
            });
            console.log('- ' + appRes.deletedCount + ' Applications');

            const orderRes = await PaymentOrder.deleteMany({ memberId: { $in: userIds } });
            console.log('- ' + orderRes.deletedCount + ' Payment Orders');
        } else {
            console.log('No matching users found to clear.');
        }

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}
clearSpecificUsers();
