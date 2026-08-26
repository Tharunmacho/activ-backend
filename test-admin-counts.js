const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  const adminsDbUri = process.env.MONGODB_URI.replace('/activ-db', '/adminsdb');
  await mongoose.connect(adminsDbUri);
  
  const blockAdmins = await mongoose.connection.db.collection('blockadmins').countDocuments();
  const districtAdmins = await mongoose.connection.db.collection('districtadmins').countDocuments();
  const stateAdmins = await mongoose.connection.db.collection('stateadmins').countDocuments();
  const superAdmins = await mongoose.connection.db.collection('superadmins').countDocuments();
  
  console.log(`--- ADMINSDB STATS ---`);
  console.log(`blockadmins: ${blockAdmins}`);
  console.log(`districtadmins: ${districtAdmins}`);
  console.log(`stateadmins: ${stateAdmins}`);
  console.log(`superadmins: ${superAdmins}`);
  
  // Also check the primary admins collection
  const activDbUri = process.env.MONGODB_URI;
  await mongoose.disconnect();
  await mongoose.connect(activDbUri);
  
  const primaryAdmins = await mongoose.connection.db.collection('admins').countDocuments();
  const primaryBlockAdmins = await mongoose.connection.db.collection('admins').countDocuments({ $or: [{role: 'block_admin'}, {adminType: 'block_admin'}] });
  
  console.log(`--- ACTIV-DB STATS ---`);
  console.log(`admins collection total: ${primaryAdmins}`);
  console.log(`admins collection (block_admin): ${primaryBlockAdmins}`);
  
  process.exit(0);
}
run().catch(console.error);
