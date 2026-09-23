const mongoose = require('mongoose');
const Application = require('../src/modules/applications/application.model');
const MemberAuth = require('../src/modules/auth/auth.model');
const MemberDetails = require('../src/modules/members/memberdetails.model');
const BusinessInfo = require('../src/modules/members/businessinfo.model');
const MemberFinancialInfo = require('../src/modules/members/memberfinancialinfo.model');
const MemberDeclaration = require('../src/modules/members/memberdeclaration.model');
const Company = require('../src/modules/members/company.model');
const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
const EventRegistration = require('../src/modules/events/eventregistration.model');
const PaymentOrder = require('../src/modules/payment/paymentorder.model');
const Notification = require('../src/modules/notifications/notification.model');
const NotificationLog = require('../src/modules/notifications/notificationLog.model');

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/activ-db';

async function clearApplicants() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB.');

        // Delete all applications
        const appRes = await Application.deleteMany({});
        console.log(`Deleted ${appRes.deletedCount} applications.`);

        // Delete all applicant user details
        const memberRes = await MemberDetails.deleteMany({
            email: { $ne: 'admin@activ.com' }
        });
        console.log(`Deleted ${memberRes.deletedCount} member details.`);

        // Delete all applicant auth records
        const authRes = await MemberAuth.deleteMany({
            email: { $ne: 'admin@activ.com' }
        });
        console.log(`Deleted ${authRes.deletedCount} auth records.`);

        // Delete related member collections
        const bizRes = await BusinessInfo.deleteMany({});
        const finRes = await MemberFinancialInfo.deleteMany({});
        const decRes = await MemberDeclaration.deleteMany({});
        const compRes = await Company.deleteMany({});
        const persRes = await PersonalInfo1.deleteMany({});
        const evtRegRes = await EventRegistration.deleteMany({});
        const payRes = await PaymentOrder.deleteMany({});

        console.log(`Deleted ${bizRes.deletedCount} business info rows.`);
        console.log(`Deleted ${finRes.deletedCount} financial info rows.`);
        console.log(`Deleted ${decRes.deletedCount} declaration rows.`);
        console.log(`Deleted ${compRes.deletedCount} company rows.`);
        console.log(`Deleted ${persRes.deletedCount} personal info rows.`);
        console.log(`Deleted ${evtRegRes.deletedCount} event registration rows.`);
        console.log(`Deleted ${payRes.deletedCount} payment order rows.`);

        // Clear notification logs & notifications
        const notifRes = await Notification.deleteMany({});
        const logRes = await NotificationLog.deleteMany({});
        console.log(`Deleted ${notifRes.deletedCount} notifications.`);
        console.log(`Deleted ${logRes.deletedCount} notification logs.`);

        console.log('\n========================================');
        console.log('SUCCESS: All applicant & member data cleared cleanly!');
        console.log('========================================\n');
        process.exit(0);
    } catch (err) {
        console.error('Error clearing applicants:', err);
        process.exit(1);
    }
}

clearApplicants();

