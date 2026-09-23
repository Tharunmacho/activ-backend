require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');

async function inspectAll() {
    const apiToken = config.botbee.apiToken;
    const phone_number_id = config.botbee.phoneNumberId;

    const res = await axios.post('https://app.botbee.io/api/v1/whatsapp/get/template/list', { apiToken, phone_number_id });
    const list = res.data.message || [];
    console.log(`Found ${list.length} templates:`);
    list.forEach(t => {
        console.log(`ID: ${t.id} | Name: ${t.template_name} | Status: ${t.status} | Header: ${t.header_type}/${t.header_subtype}`);
    });

    process.exit(0);
}

inspectAll();
