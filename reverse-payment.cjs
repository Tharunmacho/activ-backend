require('dotenv').config();
const mongoose = require('mongoose');
const config = require('./src/config');
const PaymentOrder = require('./src/modules/payment/paymentorder.model');
const MemberDetails = require('./src/modules/members/memberdetails.model');

async function reversePayment() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || process.env.MONGODB_URL);
        console.log('Connected to MongoDB');

        const orders = await PaymentOrder.find({ email: 'tharunroobika@gmail.com' });
        console.log(`Found ${orders.length} orders for tharunroobika@gmail.com`);
        for (const o of orders) {
            console.log(`Order ID: ${o.orderId}, Status: ${o.status}, Amount: ${o.amount}`);
            
            // Revert member status
            const member = await MemberDetails.findOne({ email: o.email });
            if (member) {
                console.log(`Current member status: ${member.membershipStatus}`);
                member.membershipStatus = 'approved';
                member.memberSince = undefined;
                member.validUntil = undefined;
                member.lastPaymentDate = undefined;
                member.membershipPlan = undefined;
                await member.save();
                console.log(`Member ${o.email} reverted to 'approved' (awaiting payment).`);
            }
            
            // Cancel the payment record
            o.status = 'cancelled';
            await o.save();
            console.log(`Payment order ${o.orderId} marked as cancelled.`);
        }

        console.log('Reversal complete.');
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

reversePayment();
