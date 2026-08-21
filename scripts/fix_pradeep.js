const mongoose = require('mongoose');
require('dotenv').config();
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/activ';

async function fixPradeep() {
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
  const db = mongoose.connection.db;

  await db.collection('applications').updateOne(
    { email: 'pradeep@gmail.com' },
    { $set: { role: 'business', memberType: 'business', registrationType: 'business' } }
  );

  await db.collection('users').updateOne(
    { email: 'pradeep@gmail.com' },
    { $set: { role: 'member', memberType: 'business', registrationType: 'business' } }
  );

  console.log('Successfully updated Pradeep role to Business Member in DB!');

  const app = await db.collection('applications').findOne({ email: 'pradeep@gmail.com' });
  console.log('Updated App for Pradeep:', app.email, '| Role:', app.role, '| MemberType:', app.memberType);

  await mongoose.disconnect();
}

fixPradeep().catch(console.error);
