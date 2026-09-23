require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

async function testUploadMedia() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;

    // Use placeholder logo file from website/public
    const filePath = path.join(__dirname, '..', '..', 'website', 'public', 'briefcase_3d.png');
    if (!fs.existsSync(filePath)) {
        console.error('File not found:', filePath);
        process.exit(1);
    }

    console.log('Uploading media to BotBee...');
    const form = new FormData();
    form.append('apiToken', apiToken);
    form.append('phone_number_id', phone_number_id);
    form.append('media_file', fs.createReadStream(filePath));

    try {
        const uploadRes = await axios.post('https://app.botbee.io/api/v1/whatsapp/upload/media', form, {
            headers: form.getHeaders()
        });
        console.log('Upload Response:', JSON.stringify(uploadRes.data, null, 2));

        if (uploadRes.data && uploadRes.data.media_id) {
            const mediaId = uploadRes.data.media_id;
            console.log('\n--- Testing template send with media_id ---', mediaId);

            const sendRes = await axios.post('https://app.botbee.io/api/v1/whatsapp/send/template', {
                apiToken,
                phone_number_id,
                phone_number: '919092317264',
                template_id: '419760',
                media_id: mediaId,
                template_data: ['tharun', 'ACTIV Platform', 'tharun', '9092317264', 'tharunroobika@gmail.com', 'ACTIV Registration', 'ACTIV Office', '2026-09-06', '10:00', '18:00', '1', '0', 'tharunroobika@gmail.com']
            });
            console.log('Template send response:', JSON.stringify(sendRes.data, null, 2));
        }
    } catch (err) {
        console.error('Error:', err.message, err.response ? err.response.data : '');
    }

    process.exit(0);
}

testUploadMedia();
