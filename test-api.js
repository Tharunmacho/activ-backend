const mongoose = require('mongoose');
require('dotenv').config();
const SuperAdminService = require('./src/modules/admin/superadmin.service');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/activ');
  
  const overview = await SuperAdminService.getOverview();
  console.log(JSON.stringify(overview, null, 2));
  
  process.exit(0);
}
run().catch(console.error);
