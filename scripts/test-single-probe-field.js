require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testSingleField(fieldName, fieldValue) {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    const template_id = '438245'; // activ_registration_welcome

    const body = {
        apiToken,
        phone_number_id,
        phone_number,
        template_id,
        [fieldName]: fieldValue
    };

    console.log(`Testing field ${fieldName} with value:`, JSON.stringify(fieldValue));
    try {
        const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', body);
        console.log('Response:', JSON.stringify(res.data));
    } catch (err) {
        console.log('Error:', err.message, err.response ? err.response.data : '');
    }
}

// Read args from command line
const field = process.argv[2];
const valStr = process.argv[3];
if (field && valStr) {
    let val;
    try { val = JSON.parse(valStr); } catch(e) { val = valStr; }
    testSingleField(field, val).then(() => process.exit(0));
} else {
    console.log("Usage: node test-single-probe-field.js <fieldName> <jsonValue>");
    process.exit(1);
}
