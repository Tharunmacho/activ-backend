const mongoose = require('mongoose');

const sourceUri = 'mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/activ-db';
const targetUri = 'mongodb://mongo:XnnQAuJEGQl81Ru0tqHv@178.16.137.247:27018/activ-db?authSource=admin&directConnection=true';

async function migrate() {
    console.log("Connecting to source database (Atlas)...");
    const sourceConn = await mongoose.createConnection(sourceUri).asPromise();
    
    console.log("Connecting to target database (Dokploy)...");
    const targetConn = await mongoose.createConnection(targetUri).asPromise();

    console.log("Fetching collections...");
    const collections = await sourceConn.db.listCollections().toArray();
    
    for (const collInfo of collections) {
        if (collInfo.name.startsWith('system.')) continue;
        console.log(`\nCopying collection: ${collInfo.name}`);
        
        const sourceColl = sourceConn.collection(collInfo.name);
        const targetColl = targetConn.collection(collInfo.name);
        
        const docs = await sourceColl.find({}).toArray();
        console.log(`Found ${docs.length} documents.`);
        
        if (docs.length > 0) {
            try { await targetColl.drop(); } catch (e) {}
            await targetColl.insertMany(docs);
            console.log(`Inserted ${docs.length} documents.`);
        }
    }
    
    console.log("\nMigration completely finished!");
    await sourceConn.close();
    await targetConn.close();
}

migrate().catch(console.error);
