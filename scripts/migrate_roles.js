const mongoose = require('mongoose');
require('dotenv').config();
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/activ';

async function updateDatabase() {
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
  const db = mongoose.connection.db;

  const applications = await db.collection('applications').find({}).toArray();
  let updatedApps = 0;
  let updatedUsers = 0;

  for (const app of applications) {
    const data = app.data || {};
    const businessInfo = data.businessInfo || {};
    const personalDetails = data.personalDetails || {};

    const isAspirant =
      businessInfo.doingBusiness === false ||
      data.registrationType === 'aspirant' ||
      data.memberType === 'aspirant' ||
      app.registrationType === 'aspirant' ||
      app.memberType === 'aspirant' ||
      personalDetails.registrationType === 'aspirant';

    const role = isAspirant ? 'aspirant' : (businessInfo.doingBusiness ? 'business' : 'member');
    const registrationType = isAspirant ? 'aspirant' : (businessInfo.doingBusiness ? 'business' : 'member');

    console.log('Processing App:', app.email, '| Name:', app.fullName, '| isAspirant:', isAspirant, '| Set Role:', role);

    await db.collection('applications').updateOne(
      { _id: app._id },
      {
        $set: {
          role: role,
          memberType: registrationType,
          registrationType: registrationType
        }
      }
    );
    updatedApps++;

    if (app.userId || app.email) {
      let query = {};
      try {
        if (app.userId) query = { _id: new mongoose.Types.ObjectId(app.userId) };
        else query = { email: app.email };
      } catch (e) {
        query = { email: app.email };
      }

      const res = await db.collection('users').updateMany(
        query,
        {
          $set: {
            role: role,
            memberType: registrationType,
            registrationType: registrationType
          }
        }
      );
      updatedUsers += res.modifiedCount;

      await db.collection('members').updateMany(
        { $or: [{ userId: app.userId }, { email: app.email }] },
        {
          $set: {
            role: role,
            memberType: registrationType,
            registrationType: registrationType,
            doingBusiness: !isAspirant
          }
        }
      );
    }
  }

  console.log('Migration Complete! Apps updated:', updatedApps, 'Users updated:', updatedUsers);

  // Print updated records
  console.log('\n--- VERIFY UPDATED APPLICATIONS ---');
  const updatedList = await db.collection('applications').find({}).toArray();
  updatedList.forEach(a => {
    console.log('App:', a.fullName, '| Email:', a.email, '| Role:', a.role, '| MemberType:', a.memberType);
  });

  console.log('\n--- VERIFY UPDATED USERS ---');
  const userList = await db.collection('users').find({}).toArray();
  userList.forEach(u => {
    console.log('User:', u.fullName || u.name, '| Email:', u.email, '| Role:', u.role, '| MemberType:', u.memberType);
  });

  await mongoose.disconnect();
}

updateDatabase().catch(console.error);
