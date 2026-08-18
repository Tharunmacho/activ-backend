const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
dotenv.config({ path: require('path').join(__dirname, '..', '.env') });

const OFFICIAL_ADMINS = [
  // Super Admin
  {
    email: 'super.admin@activ.com',
    fullName: 'Super Admin',
    role: 'super_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Ariyalur'
  },
  // State Admin
  {
    email: 'state.tamil.nadu@activ.com',
    fullName: 'Tamil Nadu State Admin',
    role: 'state_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Ariyalur'
  },
  // District Admin
  {
    email: 'district.ariyalur.tamil.nadu@activ.com',
    fullName: 'Ariyalur District Admin',
    role: 'district_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Ariyalur'
  },
  // Block Admins - Ariyalur District
  {
    email: 'block.ariyalur.ariyalur.tamil.nadu@activ.com',
    fullName: 'Ariyalur Block Admin',
    role: 'block_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Ariyalur'
  },
  {
    email: 'block.andimadam.ariyalur.tamil.nadu@activ.com',
    fullName: 'Andimadam Block Admin',
    role: 'block_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Andimadam'
  },
  {
    email: 'block.sendurai.ariyalur.tamil.nadu@activ.com',
    fullName: 'Sendurai Block Admin',
    role: 'block_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Sendurai'
  },
  {
    email: 'block.udayarpalayam.ariyalur.tamil.nadu@activ.com',
    fullName: 'Udayarpalayam Block Admin',
    role: 'block_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Udayarpalayam'
  },
  {
    email: 'block.jayankondam.ariyalur.tamil.nadu@activ.com',
    fullName: 'Jayankondam Block Admin',
    role: 'block_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Jayankondam'
  },
  {
    email: 'block.thirumanur.ariyalur.tamil.nadu@activ.com',
    fullName: 'Thirumanur Block Admin',
    role: 'block_admin',
    state: 'Tamil Nadu',
    district: 'Ariyalur',
    block: 'Thirumanur'
  }
];

async function seedAdmins() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB.');

    const passwordHash = await bcrypt.hash('ChangeMe@123', 10);
    const adminsCol = mongoose.connection.collection('admins');

    for (const admin of OFFICIAL_ADMINS) {
      await adminsCol.updateOne(
        { email: admin.email.toLowerCase() },
        {
          $set: {
            email: admin.email.toLowerCase(),
            password: passwordHash,
            fullName: admin.fullName,
            role: admin.role,
            state: admin.state,
            district: admin.district,
            block: admin.block,
            isActive: true,
            updatedAt: new Date()
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        { upsert: true }
      );
      console.log(`Seeded admin: ${admin.email} (${admin.role})`);
    }

    console.log('\n✅ All official admins seeded successfully with password: ChangeMe@123');
  } catch (error) {
    console.error('Error seeding admins:', error);
  } finally {
    await mongoose.disconnect();
  }
}

seedAdmins();
