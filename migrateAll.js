const { MongoClient } = require('mongodb');

const sourceUri = 'mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/';
const targetUri = 'mongodb://mongo:XnnQAuJEGQl81Ru0tqHv@178.16.137.247:27018/?authSource=admin&directConnection=true';

async function migrateAll() {
    console.log("Connecting to source (Atlas)...");
    const sourceClient = new MongoClient(sourceUri);
    await sourceClient.connect();

    console.log("Connecting to target (Dokploy)...");
    const targetClient = new MongoClient(targetUri);
    await targetClient.connect();

    const adminDb = sourceClient.db('admin');
    const { databases } = await adminDb.admin().listDatabases();

    for (const dbInfo of databases) {
        const dbName = dbInfo.name;
        
        if (['admin', 'local', 'config'].includes(dbName)) continue;
        
        console.log(`\n================================`);
        console.log(`MIGRATING DATABASE: ${dbName}`);
        console.log(`================================`);
        
        const sourceDb = sourceClient.db(dbName);
        const targetDb = targetClient.db(dbName);
        
        const collections = await sourceDb.listCollections().toArray();
        
        for (const collInfo of collections) {
            if (collInfo.name.startsWith('system.')) continue;
            console.log(`Copying collection: ${collInfo.name}`);
            
            const sourceColl = sourceDb.collection(collInfo.name);
            const targetColl = targetDb.collection(collInfo.name);
            
            const docs = await sourceColl.find({}).toArray();
            console.log(` -> Found ${docs.length} documents.`);
            
            if (docs.length > 0) {
                try { await targetColl.drop(); } catch(e) {}
                
                // BATCH INSERTS (50 at a time) to prevent hanging on huge files
                const batchSize = 50;
                for (let i = 0; i < docs.length; i += batchSize) {
                    const batch = docs.slice(i, i + batchSize);
                    await targetColl.insertMany(batch);
                }
                
                console.log(` -> Inserted ${docs.length} documents into Dokploy!`);
            }
        }
    }
    
    console.log("\nALL DATABASES COMPLETELY MIGRATED!");
    await sourceClient.close();
    await targetClient.close();
}

migrateAll().catch(console.error);
