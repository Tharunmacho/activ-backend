// Default is a read-only plan. Applying a saved plan is explicit and resumable.
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
const { planMembershipNumberMigration, applyMembershipNumberMigration } = require('../src/modules/members/memberNumberMigration');
async function main() {
    const at = process.argv.indexOf('--plan');
    const file = path.resolve(at >= 0 ? process.argv[at + 1] : '../artifacts/daily-membership-id-plan.json');
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
    if (process.argv.includes('--apply')) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (saved.format !== 'ACTIV-TYPE-YYYYMMDD-NNN' || !Array.isArray(saved.changes)) throw new Error('Invalid migration plan; prepare a new category ID plan first.');
        const count = await applyMembershipNumberMigration(saved.changes);
        console.log('Applied saved membership ID conversion for ' + count + ' members. Previous IDs retained.');
    } else {
        const Member = require('../src/modules/members/memberdetails.model');
        const members = await Member.collection.find({}, { projection: { membershipNumber: 1, legacyMembershipNumbers: 1, membershipActivatedAt: 1, createdAt: 1, membershipStatus: 1, membershipType: 1, membershipTier: 1, memberType: 1, registrationType: 1 } }).toArray();
        const paid = await require('../src/modules/payment/paymentorder.model').find({ orderType: 'membership', status: 'paid' }).select('memberId planId planAudience membershipType').sort({ paidAt: -1, createdAt: -1 }).lean();
        const byMember = new Map();
        for (const order of paid) if (!byMember.has(String(order.memberId))) byMember.set(String(order.memberId), order);
        for (const member of members) member.idPlan = byMember.get(String(member._id));
        const reservations = await require('../src/config/dataLayout').collection('membershipCounters').find({ _id: /^number:/ }, { projection: { _id: 1 } }).toArray();
        const changes = planMembershipNumberMigration(members, reservations);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ format: 'ACTIV-TYPE-YYYYMMDD-NNN', preparedAt: new Date().toISOString(), changes }, null, 2));
        console.log('Read-only conversion plan saved locally for ' + changes.length + ' existing members. Database unchanged.');
    }
}
main().catch(error => { console.error('Membership ID migration could not complete:', String(error.message).replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[database connection]')); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
