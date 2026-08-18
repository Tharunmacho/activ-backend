// Check companies collection in database
const mongoose = require('mongoose');
const config = require('../src/config');

async function checkCompanies() {
    try {
        // Connect to MongoDB
        await mongoose.connect(config.db.uri);
        console.log('✅ Connected to MongoDB');

        // Check companies collection
        const companiesCollection = mongoose.connection.db.collection('companies');
        const companies = await companiesCollection.find({}).toArray();

        console.log('\n📊 companies collection:');
        console.log('Total documents:', companies.length);

        if (companies.length > 0) {
            console.log('\nFound companies:');
            companies.forEach((company, index) => {
                console.log(`\n${index + 1}. Company:`);
                console.log('   _id:', company._id);
                console.log('   userId:', company.userId);
                console.log('   businessName:', company.businessName);
                console.log('   businessType:', company.businessType);
                console.log('   mobileNumber:', company.mobileNumber);
                console.log('   location:', company.location);
                console.log('   email:', company.email);
                console.log('   status:', company.status);
                console.log('   isActive:', company.isActive);
                console.log('   createdAt:', company.createdAt);
            });
        } else {
            console.log('⚠️  No companies found in companies collection');
        }

        await mongoose.disconnect();
        console.log('\n✅ Disconnected from MongoDB');
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

checkCompanies();
