require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testMediaHeader() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    const imageUrl = 'https://activ.org.in/logo_ACTIVian-removebg-preview.png';

    const payloads = [
        {
            name: 'media_url + media_type=image',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', media_url: imageUrl, media_type: 'image' }
        },
        {
            name: 'header_media_url + header_media_type=image',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', header_media_url: imageUrl, header_media_type: 'image' }
        },
        {
            name: 'header_type=image + header_content=imageUrl',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', header_type: 'image', header_content: imageUrl }
        },
        {
            name: 'header_text or image_url',
            data: { apiToken, phone_number_id, phone_number, template_id: '419760', image: imageUrl }
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

testMediaHeader();
