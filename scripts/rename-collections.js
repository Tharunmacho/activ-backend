const connectDB = require('../src/config/db');
const mongoose = require('mongoose');

async function renameCollectionsInMongo() {
  console.log('--- STARTING MONGO COLLECTION RENAME (web auth -> auth, web users -> users) ---');
  await connectDB();
  const db = mongoose.connection.db;

  const collections = (await db.listCollections().toArray()).map(c => c.name);

  // 1. Rename / Copy 'web auth' -> 'auth'
  if (collections.includes('web auth')) {
    console.log('Found "web auth" collection. Migrating documents to "auth"...');
    const docs = await db.collection('web auth').find({}).toArray();
    if (docs.length > 0) {
      for (const doc of docs) {
        await db.collection('auth').updateOne(
          { _id: doc._id },
          { $set: doc },
          { upsert: true }
        );
      }
      console.log(`Migrated ${docs.length} document(s) from "web auth" to "auth".`);
    }
    await db.collection('web auth').drop().catch(() => {});
    console.log('Dropped old "web auth" collection.');
  }

  // 2. Rename / Copy 'web users' -> 'users'
  if (collections.includes('web users')) {
    console.log('Found "web users" collection. Migrating documents to "users"...');
    const docs = await db.collection('web users').find({}).toArray();
    if (docs.length > 0) {
      for (const doc of docs) {
        await db.collection('users').updateOne(
          { _id: doc._id },
          { $set: doc },
          { upsert: true }
        );
      }
      console.log(`Migrated ${docs.length} document(s) from "web users" to "users".`);
    }
    await db.collection('web users').drop().catch(() => {});
    console.log('Dropped old "web users" collection.');
  }

  // 3. Clean any empty legacy collections like 'memberauths' or 'memberdetails'
  for (const legacyCol of ['memberauths', 'memberdetails', 'declarationforms', 'financialforms', 'personalforms', 'memberdeclarations', 'memberbusinessinfos']) {
    if (collections.includes(legacyCol)) {
      const count = await db.collection(legacyCol).countDocuments();
      if (count === 0) {
        await db.collection(legacyCol).drop().catch(() => {});
        console.log(`Dropped empty legacy collection "${legacyCol}".`);
      }
    }
  }

  // Audit remaining collections
  const updatedCols = await db.listCollections().toArray();
  console.log('\n=== UPDATED MONGO COLLECTIONS ===');
  for (const c of updatedCols) {
    const cnt = await db.collection(c.name).countDocuments();
    console.log(`- ${c.name}: ${cnt} document(s)`);
  }

  process.exit(0);
}

renameCollectionsInMongo().catch(err => {
  console.error('Error renaming collections:', err);
  process.exit(1);
});
