require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testMetaComponents() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    
    // We will test 4 distinct payloads with UNIQUE visible markers!
    const tests = [
        {
            name: "Test 1: template_id + language=en_US + template_data array",
            payload: {
                apiToken, phone_number_id, phone_number,
                template_id: "438245",
                language: "en_US",
                template_data: ["MARKER_ONE_US"]
            }
        },
        {
            name: "Test 2: template_name + language=en_US + template_data array",
            payload: {
                apiToken, phone_number_id, phone_number,
                template_name: "activ_registration_welcome",
                language: "en_US",
                template_data: ["MARKER_TWO_NAME"]
            }
        },
        {
            name: "Test 3: template_id + components nested Meta format",
            payload: {
                apiToken, phone_number_id, phone_number,
                template_id: "438245",
                language: "en_US",
                components: [
                    {
                        type: "body",
                        parameters: [{ type: "text", text: "MARKER_THREE_COMP" }]
                    }
                ]
            }
        },
        {
            name: "Test 4: template_id + template_jsoncode",
            payload: {
                apiToken, phone_number_id, phone_number,
                template_id: "438245",
                language: "en_US",
                template_jsoncode: JSON.stringify([
                    {
                        type: "body",
                        parameters: [{ type: "text", text: "MARKER_FOUR_JSONCODE" }]
                    }
                ])
            }
        }
    ];

    for (const t of tests) {
        console.log(`\nSending ${t.name}...`);
        try {
            const res = await axios.post("https://app.botbee.io/api/v1/whatsapp/send/template", t.payload);
            console.log("Response:", JSON.stringify(res.data));
        } catch (err) {
            console.log("Error:", err.message, err.response ? JSON.stringify(err.response.data) : '');
        }
    }
}

testMetaComponents().then(() => process.exit(0));
