const connectDB = require('./src/config/db');
const Application = require('./src/modules/applications/application.model');
const MemberDetails = require('./src/modules/members/memberdetails.model');
const MemberAuth = require('./src/modules/auth/auth.model');
const Company = require('./src/modules/members/company.model');

async function cleanDbFreshExceptKaran() {
  console.log('--- STARTING FRESH DB CLEANUP (PRESERVING KARAN & ADMINS) ---');
  await connectDB();

  // 1. Find all applications matching Karan
  const allApps = await Application.find({}).lean();
  const karanApps = allApps.filter(a => {
    const fullName = a.fullName || a.data?.personalDetails?.fullName || a.data?.personal?.fullName || '';
    const email = a.email || a.data?.personalDetails?.email || '';
    return fullName.toLowerCase().includes('karan') || email.toLowerCase().includes('karan');
  });

  const karanAppIds = karanApps.map(a => a._id);
  const karanEmails = new Set(karanApps.map(a => (a.email || '').toLowerCase()).filter(Boolean));

  // Also check MemberDetails for Karan
  const allMembers = await MemberDetails.find({}).lean();
  const karanMembers = allMembers.filter(m => {
    const name = m.fullName || m.name || '';
    const email = m.email || '';
    return name.toLowerCase().includes('karan') || email.toLowerCase().includes('karan');
  });

  karanMembers.forEach(m => {
    if (m.email) karanEmails.add(m.email.toLowerCase());
  });

  const karanEmailList = Array.from(karanEmails);
  console.log(`Found ${karanApps.length} Karan Application(s) and ${karanMembers.length} Karan Member Profile(s).`);
  console.log('Preserved Karan Emails:', karanEmailList);

  // 2. Delete non-Karan Applications
  const appDeleteRes = await Application.deleteMany({
    _id: { $nin: karanAppIds },
    email: { $nin: karanEmailList }
  });
  console.log(`Deleted ${appDeleteRes.deletedCount} old test Application(s).`);

  // 3. Delete non-Karan MemberDetails (role === 'member')
  const memberDeleteRes = await MemberDetails.deleteMany({
    role: { $in: ['member', 'aspirant', 'business'] },
    email: { $nin: karanEmailList }
  });
  console.log(`Deleted ${memberDeleteRes.deletedCount} old test Member Profile(s).`);

  // 4. Delete non-Karan MemberAuth
  const authDeleteRes = await MemberAuth.deleteMany({
    email: { $nin: karanEmailList }
  });
  console.log(`Deleted ${authDeleteRes.deletedCount} old test Auth record(s).`);

  // 5. Delete non-Karan Companies / Business Profiles
  const bizDeleteRes = await Company.deleteMany({
    email: { $nin: karanEmailList }
  });
  console.log(`Deleted ${bizDeleteRes.deletedCount} old test Company/Business Profile(s).`);

  // Verification Summary
  const remainingApps = await Application.find({}).lean();
  const remainingMembers = await MemberDetails.find({ role: 'member' }).lean();

  console.log('\n--- CLEANUP COMPLETE ---');
  console.log('Remaining Applications:', remainingApps.map(a => ({ id: a._id, name: a.fullName, email: a.email, block: a.block, status: a.status })));
  console.log('Remaining Members:', remainingMembers.map(m => ({ id: m._id, name: m.fullName, email: m.email })));

  process.exit(0);
}

cleanDbFreshExceptKaran().catch(err => {
  console.error('Database Cleanup Error:', err);
  process.exit(1);
});
