require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function test3VarsPayload() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';

    const body = {
        apiToken,
        phone_number_id,
        phone_number,
        template_id: '438298', // activ_member_update (3 variables)
        
        template_data: ['AAA1', 'AAA2', 'AAA3'],
        body_params: ['BBB1', 'BBB2', 'BBB3'],
        params: ['CCC1', 'CCC2', 'CCC3'],
        variables: ['DDD1', 'DDD2', 'DDD3'],
        custom_data: ['EEE1', 'EEE2', 'EEE3'],
        values: ['FFF1', 'FFF2', 'FFF3'],
        placeholders: ['GGG1', 'GGG2', 'GGG3'],
        attributes: ['HHH1', 'HHH2', 'HHH3'],
        variable_map: { "1": "III1", "2": "III2", "3": "III3" },
        components: [
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: 'JJJ1' },
                    { type: 'text', text: 'JJJ2' },
                    { type: 'text', text: 'JJJ3' }
                ]
            }
        ]
    };

    console.log("Sending 3-vars multi-marker payload to BotBee template endpoint...");
    try {
        const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', body);
        console.log("Response:", JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log("Error:", err.message, err.response ? err.response.data : '');
    }
}

test3VarsPayload().then(() => process.exit(0));
