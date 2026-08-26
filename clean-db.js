const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/activ');
  
  // Delete all members
  const result = await mongoose.connection.db.collection('memberdetails').deleteMany({});
  
  console.log(`Successfully deleted ${result.deletedCount} members from the database.`);
  
  process.exit(0);
}
run().catch(console.error);
