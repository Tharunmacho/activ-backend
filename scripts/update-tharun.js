const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const res = await mongoose.connection.collection('users').updateOne(
    { email: 'tharunroobika@gmail.com' },
    { $set: { membershipStatus: 'approved', membershipType: 'annual', membershipActivatedAt: new Date() } }
  );
  console.log('UPDATED THARUNROOBIKA MEMBERSHIP:', res.modifiedCount);
  await mongoose.disconnect();
}

run();
