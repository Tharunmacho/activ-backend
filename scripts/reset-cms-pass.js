const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function run() {
  await mongoose.connect('mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/');
  const db = mongoose.connection.useDb('adminsdb');
  
  // Set to Admin@123
  const hash = await bcrypt.hash('Admin@123', 10);
  const result = await db.collection('superadmins').updateOne(
    { email: 'cms@activ.org.in' },
    { 
      $set: { 
        email: 'cms@activ.org.in',
        passwordHash: hash,
        fullName: 'CMS Admin',
        role: 'cms_admin',
        active: true
      },
      $setOnInsert: {
        adminId: 'SUPER002'
      }
    },
    { upsert: true }
  );
  
  console.log('Password reset successfully!');
  await mongoose.disconnect();
}

run().catch(console.error);
