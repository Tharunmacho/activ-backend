require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testHeaderFormats() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    const imageUrl = 'https://activ.org.in/logo_ACTIVian-removebg-preview.png';

    const payloads = [
        {
            name: 'header field string',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', header: imageUrl }
        },
        {
            name: 'header_image field',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', header_image: imageUrl }
        },
        {
            name: 'header object with link',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', header: { type: 'image', image: { link: imageUrl } } }
        },
        {
            name: 'components array',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                components: [{ type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] }]
            }
        },
        {
            name: 'variable_map or template_data with image link as 1st param',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', template_data: [imageUrl] }
        }
    ];

    for (const p of payloads) {
        console.log(`\nTesting ${p.name}...`);
        try {
            const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', p.data);
            console.log('Response:', JSON.stringify(res.data, null, 2));
        } catch (err) {
            console.log('Error:', err.message, err.response ? err.response.data : '');
        }
    }

    process.exit(0);
}

testHeaderFormats();
