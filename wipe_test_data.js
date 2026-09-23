require('dotenv').config();
const mongoose = require('mongoose');
const config = require('./src/config');
const User = require('./src/modules/auth/auth.model');
const MemberDetails = require('./src/modules/members/memberdetails.model');
const Application = require('./src/modules/applications/application.model');
const PaymentOrder = require('./src/modules/payment/paymentorder.model');

async function wipeTestApplicants() {
    try {
        await mongoose.connect(config.db.uri);
        
        const users = await User.find({});
        const userIds = users.map(u => u._id);
        const emails = users.map(u => u.email);

        const userRes = await User.deleteMany({});
        
        let mdRes = { deletedCount: 0 };
        if (userIds.length > 0 || emails.length > 0) {
            mdRes = await MemberDetails.deleteMany({ 
                $or: [
                    { _id: { $in: userIds } },
                    { email: { $in: emails } }
                ]
            });
        }

        let orderRes = { deletedCount: 0 };
        if (userIds.length > 0) {
            orderRes = await PaymentOrder.deleteMany({ memberId: { $in: userIds } });
        }

        console.log('Successfully wiped:');
        console.log('- ' + userRes.deletedCount + ' Member accounts (Users)');
        console.log('- ' + mdRes.deletedCount + ' Member Profiles');
        console.log('- ' + orderRes.deletedCount + ' Payment Orders');

        await mongoose.disconnect();
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}
wipeTestApplicants();
