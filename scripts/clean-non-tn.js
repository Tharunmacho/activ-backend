const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    const db = mongoose.connection.client.db('adminsdb');
    const collections = ['superadmins', 'stateadmins', 'districtadmins', 'blockadmins'];
    
    let deleted = 0;
    for (const col of collections) {
        const res = await db.collection(col).deleteMany({
            state: { $not: /tamil nadu/i }
        });
        deleted += res.deletedCount;
    }
    
    console.log('Deleted non-Tamil Nadu admins:', deleted);
    process.exit(0);
});
