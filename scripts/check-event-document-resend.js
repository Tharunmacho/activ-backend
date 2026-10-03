require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const config = require('../src/config');
const Log = require('../src/modules/notifications/notificationLog.model');
const bookingService = require('../src/modules/events/eventbooking.service');
const { documentForResend, validateDocument } = require('../src/modules/events/eventDocument');

(async () => {
    await mongoose.connect(config.db.uri, { serverSelectionTimeoutMS: 10000 });
    try {
        const rows = await Log.find({ event: /^EVENT_DOCUMENT_/, status: 'failed', eventTitle: /Zero Cost Social/i })
            .sort({ createdAt: -1 }).limit(5).lean();
        let tested = false;
        for (const row of rows) {
            const booking = await bookingService.bookingForLogRow(row);
            if (!booking) { console.log('Document check: original booking not found'); continue; }
            const ctx = await bookingService.messageContext(booking);
            const document = documentForResend(row, ctx.attachments);
            if (!document) { console.log('Document check: attachment not found'); continue; }
            await validateDocument(document.link);
            console.log(JSON.stringify({ original: row.data?.headerDocument?.link, corrected: document.link, validFile: true }));
            if (process.argv.includes('--send-test') && !tested) {
                // Only the test number explicitly authorized by the user.
                const params = ['Tharun (test message)', document.filename, `[TEST] ${ctx.eventTitle}`,
                    ctx.whenLabel || 'Date to be confirmed', 'TEST ONLY - no reservation'];
                const sent = await require('../src/modules/notifications/whatsappTemplate').sendTemplateMessage(
                    '9092317264', config.botbee.templates.eventDocument || row.templateId, params, 'en', '', { headerDocument: document });
                console.log(JSON.stringify({ success: sent.success, mock: sent.mock, messageId: sent.messageId, error: sent.error }));
                if (!sent.success || sent.mock) process.exitCode = 1;
                tested = true;
            }
        }
        if (!rows.length || (process.argv.includes('--send-test') && !tested)) {
            console.log('No matching failed document was available to test.');
            process.exitCode = 1;
        }
    } finally { await mongoose.disconnect(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
