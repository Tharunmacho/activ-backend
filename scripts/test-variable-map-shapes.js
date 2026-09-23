require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testVariableMapShapes() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    
    const shapes = [
        {
            name: "Shape 1: Root key '#1#'",
            payload: { apiToken, phone_number_id, phone_number, template_id: "438245", "#1#": "THARUN_HASH1" }
        },
        {
            name: "Shape 2: Root key '1'",
            payload: { apiToken, phone_number_id, phone_number, template_id: "438245", "1": "THARUN_ONE" }
        },
        {
            name: "Shape 3: body object {'1': 'THARUN_BODY1'}",
            payload: { apiToken, phone_number_id, phone_number, template_id: "438245", body: { "1": "THARUN_BODY1" } }
        },
        {
            name: "Shape 4: body object {'#1#': 'THARUN_BODY_HASH1'}",
            payload: { apiToken, phone_number_id, phone_number, template_id: "438245", body: { "#1#": "THARUN_BODY_HASH1" } }
        },
        {
            name: "Shape 5: template_data object {'#1#': 'THARUN_TPL_HASH1'}",
            payload: { apiToken, phone_number_id, phone_number, template_id: "438245", template_data: { "#1#": "THARUN_TPL_HASH1" } }
        },
        {
            name: "Shape 6: template_data object {'1': 'THARUN_TPL_ONE'}",
            payload: { apiToken, phone_number_id, phone_number, template_id: "438245", template_data: { "1": "THARUN_TPL_ONE" } }
        }
    ];

    for (const s of shapes) {
        console.log(`\nSending ${s.name}...`);
        try {
            const res = await axios.post("https://app.botbee.io/api/v1/whatsapp/send/template", s.payload);
            console.log("Response:", JSON.stringify(res.data));
        } catch (err) {
            console.log("Error:", err.message, err.response ? JSON.stringify(err.response.data) : '');
        }
    }
}

testVariableMapShapes().then(() => process.exit(0));
