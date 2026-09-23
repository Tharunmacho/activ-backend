require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testWithImage() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    const imageUrl = 'https://activ.org.in/logo_ACTIVian-removebg-preview.png';

    const payloads = [
        {
            name: 'media_url',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                media_url: imageUrl,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
        },
        {
            name: 'header_url',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                header_url: imageUrl,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
        },
        {
            name: 'image_url',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                image_url: imageUrl,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
        },
        {
            name: 'url in template_data / header',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                url: imageUrl,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
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

testWithImage();
