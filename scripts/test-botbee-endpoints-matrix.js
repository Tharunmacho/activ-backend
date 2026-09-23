require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testMatrix() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    
    // We want to test sending "Tharun" into activ_registration_welcome (438245)
    const variations = [
        {
            name: "Endpoint /send/template - template_data object {'1': 'Tharun'}",
            url: "https://app.botbee.io/api/v1/whatsapp/send/template",
            body: { apiToken, phone_number_id, phone_number, template_id: "438245", template_data: { "1": "Tharun" } }
        },
        {
            name: "Endpoint /send/template - template_data object {'#1#': 'Tharun'}",
            url: "https://app.botbee.io/api/v1/whatsapp/send/template",
            body: { apiToken, phone_number_id, phone_number, template_id: "438245", template_data: { "#1#": "Tharun" } }
        },
        {
            name: "Endpoint /send/template - variables object {'1': 'Tharun'}",
            url: "https://app.botbee.io/api/v1/whatsapp/send/template",
            body: { apiToken, phone_number_id, phone_number, template_id: "438245", variables: { "1": "Tharun" } }
        },
        {
            name: "Endpoint /send/template - body_params object {'1': 'Tharun'}",
            url: "https://app.botbee.io/api/v1/whatsapp/send/template",
            body: { apiToken, phone_number_id, phone_number, template_id: "438245", body_params: { "1": "Tharun" } }
        },
        {
            name: "Endpoint /send/template - template_data string 'Tharun'",
            url: "https://app.botbee.io/api/v1/whatsapp/send/template",
            body: { apiToken, phone_number_id, phone_number, template_id: "438245", template_data: "Tharun" }
        },
        {
            name: "Endpoint /send - is_template 1 + template_id 438245 + template_data ['Tharun']",
            url: "https://app.botbee.io/api/v1/whatsapp/send",
            body: { apiToken, phone_number_id, phone_number, is_template: "1", template_id: "438245", template_data: ["Tharun"] }
        }
    ];

    for (const v of variations) {
        console.log(`\nTesting: ${v.name}...`);
        try {
            const res = await axios.post(v.url, v.body);
            console.log("Response:", JSON.stringify(res.data));
        } catch (err) {
            console.log("Error:", err.message, err.response ? JSON.stringify(err.response.data) : '');
        }
    }
}

testMatrix().then(() => process.exit(0));
