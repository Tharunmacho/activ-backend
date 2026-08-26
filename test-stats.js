const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/activ');
  const members = await mongoose.connection.db.collection('members').countDocuments();
  const applications = await mongoose.connection.db.collection('applications').find({}).toArray();
  
  let approved = 0, pending = 0, rejected = 0;
  applications.forEach(a => {
    if (a.status === 'Approved') approved++;
    else if (a.status === 'Rejected') rejected++;
    else pending++;
  });
  
  console.log('--- ACTUAL DB STATS ---');
  console.log(`Members Collection: ${members}`);
  console.log(`Applications Collection: ${applications.length}`);
  console.log(`Approved: ${approved}`);
  console.log(`Pending: ${pending}`);
  console.log(`Rejected: ${rejected}`);
  
  process.exit(0);
}
run().catch(console.error);
