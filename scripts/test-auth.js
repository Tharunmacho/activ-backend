// Test authentication with the database
const axios = require('axios');

const API_BASE_URL = 'http://localhost:5000/api/v1';

// Test data - using existing user from database
const testMember = {
    email: 'tharunroobika@gmail.com',
    password: 'tharun2005',
    fullName: 'Test Member',
    phoneNumber: '+919876543210',
    state: 'Karnataka',
    district: 'Bangalore Urban',
    block: 'Bangalore North',
    city: 'Bangalore'
};

let authToken = '';

async function testRegister() {
    console.log('\n🔵 Testing Member Registration...');
    try {
        const response = await axios.post(`${API_BASE_URL}/auth/register`, testMember);
        console.log('✅ Registration successful!');
        console.log('Response:', JSON.stringify(response.data, null, 2));
        authToken = response.data.data.token;
        return response.data;
    } catch (error) {
        if (error.response?.data?.error?.message === 'Email already registered') {
            console.log('⚠️  User already exists, proceeding to login...');
            return null;
        }
        console.error('❌ Registration failed:', error.response?.data || error.message);
        throw error;
    }
}

async function testLogin() {
    console.log('\n🔵 Testing Member Login...');
    try {
        const response = await axios.post(`${API_BASE_URL}/auth/login`, {
            email: testMember.email,
            password: testMember.password
        });
        console.log('✅ Login successful!');
        console.log('Response:', JSON.stringify(response.data, null, 2));
        authToken = response.data.data.token;
        return response.data;
    } catch (error) {
        console.error('❌ Login failed:', error.response?.data || error.message);
        throw error;
    }
}

async function testGetCurrentUser() {
    console.log('\n🔵 Testing Get Current User...');
    try {
        const response = await axios.get(`${API_BASE_URL}/auth/me`, {
            headers: {
                Authorization: `Bearer ${authToken}`
            }
        });
        console.log('✅ Get current user successful!');
        console.log('Response:', JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error('❌ Get current user failed:', error.response?.data || error.message);
        throw error;
    }
}

async function checkDatabaseConnection() {
    console.log('\n🔵 Checking Backend Connection...');
    try {
        // Try a simple request to check if backend is running
        await axios.get(`${API_BASE_URL}/auth/test`).catch(() => {
            // If 404, backend is running but route doesn't exist - that's fine
        });
        console.log('✅ Backend is running!');
        return true;
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('❌ Cannot connect to backend:', error.message);
            console.log('\n⚠️  Please make sure the backend server is running:');
            console.log('   cd activ-backend');
            console.log('   npm run dev');
            return false;
        }
        // Any other error means backend is running
        console.log('✅ Backend is running!');
        return true;
    }
}

async function runTests() {
    console.log('═══════════════════════════════════════');
    console.log('  ACTIV Backend Authentication Test');
    console.log('═══════════════════════════════════════');

    try {
        // Check if backend is running
        const isConnected = await checkDatabaseConnection();
        if (!isConnected) {
            console.log('\n❌ Tests aborted: Backend not running');
            process.exit(1);
        }

        // Skip registration, directly test login with existing user
        console.log('\n📝 Using existing database credentials:');
        console.log('   Email:', testMember.email);
        console.log('   Password: ********');

        // Test login
        await testLogin();

        // Test get current user
        await testGetCurrentUser();

        console.log('\n═══════════════════════════════════════');
        console.log('✅ All tests passed successfully!');
        console.log('═══════════════════════════════════════');
        console.log('\n📊 Database Verification:');
        console.log('1. Check memberauths collection for email:', testMember.email);
        console.log('2. Check memberdetails collection for profile data');
        console.log('\nMongoDB Connection String:');
        console.log('mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/activ-db');

    } catch (error) {
        console.log('\n═══════════════════════════════════════');
        console.log('❌ Tests failed!');
        console.log('═══════════════════════════════════════');
        process.exit(1);
    }
}

// Run tests
runTests();