const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/activ');
  
  // The MemberDetails model actually uses the 'users' collection
  const result = await mongoose.connection.db.collection('users').deleteMany({});
  
  console.log(`Successfully deleted ${result.deletedCount} members from the 'users' collection.`);
  
  process.exit(0);
}
run().catch(console.error);
