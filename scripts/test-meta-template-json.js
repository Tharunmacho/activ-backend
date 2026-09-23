require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function testMetaJson() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;
    const phone_number = '919092317264';
    const imageUrl = 'https://activ.org.in/logo_ACTIVian-removebg-preview.png';

    const payloads = [
        {
            name: 'template_data as object { header, body }',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                template_data: {
                    header: { type: 'image', image: { link: imageUrl } },
                    body: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
                }
            }
        },
        {
            name: 'header_input string',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                header_input: imageUrl,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
        },
        {
            name: 'header_url as 1st param or header_handle',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                header_handle: imageUrl,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            }
        },
        {
            name: 'variable_map matching #name# etc.',
            data: {
                apiToken, phone_number_id, phone_number, template_id: '419760',
                variable_map: {
                    header: { link: imageUrl },
                    body: { "1": "tharun", "2": "ACTIV", "3": "tharun", "4": "9092317264", "5": "tharunroobika@gmail.com", "6": "ACTIV Registration", "7": "ACTIV Office", "8": "2026-09-06", "9": "10:00", "10": "18:00", "11": "1", "12": "0", "13": "tharunroobika@gmail.com" }
                }
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

testMetaJson();
