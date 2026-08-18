const connectDB = require('./src/config/db');
const mongoose = require('mongoose');

async function inspectAndPurgeAllCollections() {
  await connectDB();
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  console.log('=== ALL MONGO COLLECTIONS & DOCUMENT COUNTS ===');
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    console.log(`- ${col.name}: ${count} document(s)`);
  }

  // Admin collection names to preserve completely
  const adminCollections = ['admins', 'blockadmins', 'districtadmins', 'stateadmins', 'superadmins', 'roles'];

  // Preserved Karan identifiers
  const karanEmailRegex = /karan/i;

  // Let's find all Karan IDs across collections
  const karanApps = await db.collection('applications').find({
    $or: [
      { fullName: karanEmailRegex },
      { email: karanEmailRegex },
      { 'data.personalDetails.fullName': karanEmailRegex },
      { 'data.personalDetails.email': karanEmailRegex }
    ]
  }).toArray();

  const karanAppIds = karanApps.map(a => a._id);
  const karanUserIds = karanApps.map(a => a.userId).filter(Boolean);

  console.log('\n--- CLEANING REMAINING COLLECTIONS (EXCEPT ADMINS & KARAN) ---');

  for (const col of collections) {
    const name = col.name;

    // Skip admin collections
    if (adminCollections.includes(name)) {
      console.log(`[SKIP ADMIN] Preserved ${name}`);
      continue;
    }

    if (name === 'applications') {
      const res = await db.collection('applications').deleteMany({
        _id: { $nin: karanAppIds }
      });
      console.log(`[CLEANED] ${name}: deleted ${res.deletedCount} non-Karan documents`);
    } else if (name === 'memberdetails' || name === 'web users' || name === 'memberauths' || name === 'web auth') {
      const res = await db.collection(name).deleteMany({
        $and: [
          { role: { $nin: ['block_admin', 'district_admin', 'state_admin', 'super_admin'] } },
          { email: { $not: karanEmailRegex } }
        ]
      });
      console.log(`[CLEANED] ${name}: deleted ${res.deletedCount} non-Karan documents`);
    } else {
      // For any other general collections (payments, receipts, logs, notifications, activities, etc.)
      // delete non-Karan items
      const res = await db.collection(name).deleteMany({
        $and: [
          { email: { $not: karanEmailRegex } },
          { applicantName: { $not: karanEmailRegex } },
          { fullName: { $not: karanEmailRegex } },
          { name: { $not: karanEmailRegex } },
          { userId: { $nin: karanUserIds } },
          { applicationId: { $nin: karanAppIds } }
        ]
      });
      console.log(`[CLEANED] ${name}: deleted ${res.deletedCount} old test documents`);
    }
  }

  console.log('\n=== POST-CLEANUP COLLECTION COUNTS ===');
  for (const col of collections) {
    const count = await db.collection(col.name).countDocuments();
    console.log(`- ${col.name}: ${count} document(s)`);
  }

  process.exit(0);
}

inspectAndPurgeAllCollections().catch(err => {
  console.error('Error inspecting/purging collections:', err);
  process.exit(1);
});
