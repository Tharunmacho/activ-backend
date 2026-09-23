require('dotenv').config();
const botbeeService = require('../src/modules/notifications/botbee.service');

async function main() {
    console.log("Checking current templates on BotBee account...");
    const templates = await botbeeService.listTemplates();
    console.log("Templates on account:");
    console.dir(templates, { depth: null });
}

main().catch(console.error);
