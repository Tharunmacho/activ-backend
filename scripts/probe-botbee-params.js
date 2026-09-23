require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testAll() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264'; // Test number
    const template_id = '438245'; // activ_registration_welcome (1 variable)

    const testCases = [
        { name: '1. template_data array', payload: { template_data: ['TharunTest'] } },
        { name: '2. body_params array', payload: { body_params: ['TharunTest'] } },
        { name: '3. params array', payload: { params: ['TharunTest'] } },
        { name: '4. variables array', payload: { variables: ['TharunTest'] } },
        { name: '5. template_data comma string', payload: { template_data: 'TharunTest' } },
        { name: '6. template_data object string keys', payload: { template_data: { "1": "TharunTest" } } },
        { name: '7. template_data object hash keys', payload: { template_data: { "#1#": "TharunTest" } } },
        { name: '8. components array (Meta style)', payload: {
            components: [
                {
                    type: 'body',
                    parameters: [{ type: 'text', text: 'TharunTest' }]
                }
            ]
        } }
    ];

    for (const tc of testCases) {
        console.log(`\n--- ${tc.name} ---`);
        const body = {
            apiToken,
            phone_number_id,
            phone_number,
            template_id,
            ...tc.payload
        };
        try {
            const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', body);
            console.log('Response:', JSON.stringify(res.data));
        } catch (err) {
            console.log('Error:', err.message, err.response ? err.response.data : '');
        }
    }
}

testAll().then(() => process.exit(0));
