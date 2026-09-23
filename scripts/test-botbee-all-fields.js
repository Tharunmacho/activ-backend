require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testSinglePayloadWithDistinctMarkers() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264'; // Recipient phone number

    // Send a message where EACH candidate field name has a UNIQUE distinct string!
    // That way, whichever field appears on the phone reveals the exact key BotBee reads!
    const body = {
        apiToken,
        phone_number_id,
        phone_number,
        template_id: '438245', // activ_registration_welcome (1 variable slot #1#)
        
        // Candidates:
        template_data: ['AAA_template_data'],
        body_params: ['BBB_body_params'],
        params: ['CCC_params'],
        variables: ['DDD_variables'],
        custom_data: ['EEE_custom_data'],
        values: ['FFF_values'],
        placeholders: ['GGG_placeholders'],
        attributes: ['HHH_attributes'],
        variable_map: { "1": "III_variable_map" },
        components: [
            {
                type: 'body',
                parameters: [{ type: 'text', text: 'JJJ_components' }]
            }
        ]
    };

    console.log("Sending multi-marker payload to BotBee template endpoint...");
    try {
        const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', body);
        console.log("Response:", JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log("Error:", err.message, err.response ? err.response.data : '');
    }
}

testSinglePayloadWithDistinctMarkers().then(() => process.exit(0));
