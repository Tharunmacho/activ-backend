const connectDB = require('./src/config/db');
const Application = require('./src/modules/applications/application.model');

async function cleanup() {
  await connectDB();
  const allApps = await Application.find({});
  console.log('TOTAL APPLICATIONS BEFORE CLEANUP:', allApps.length);

  // Find Karan's application
  const karanApp = allApps.find(a => 
    (a.fullName && a.fullName.toLowerCase().includes('karan')) || 
    (a.email && a.email.toLowerCase().includes('karan')) ||
    (a.data && a.data.personalDetails && a.data.personalDetails.fullName && a.data.personalDetails.fullName.toLowerCase().includes('karan'))
  );

  console.log('KARAN APP:', karanApp ? { id: karanApp._id, name: karanApp.fullName, email: karanApp.email, status: karanApp.status } : 'NOT FOUND');

  if (karanApp) {
    const deleteResult = await Application.deleteMany({
      _id: { $ne: karanApp._id },
      $or: [
        { block: { $regex: /ariyalur/i } },
        { 'data.personalDetails.block': { $regex: /ariyalur/i } },
        { fullName: 'Applicant' }
      ]
    });
    console.log('DELETED OLD ARIYALUR APPLICATIONS:', deleteResult.deletedCount);
  }

  const remaining = await Application.find({});
  console.log('REMAINING APPLICATIONS COUNT:', remaining.length);
  console.log('REMAINING APPLICATIONS:', remaining.map(a => ({ id: a._id, name: a.fullName, block: a.block, status: a.status })));
  process.exit(0);
}

cleanup().catch(err => {
  console.error('Cleanup Error:', err);
  process.exit(1);
});
