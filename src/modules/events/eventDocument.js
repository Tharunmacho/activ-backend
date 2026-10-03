const axios = require('axios');

// A successful HTTP response can still be the website's HTML fallback.
// Check the actual response before handing a document URL to WhatsApp.
const validateDocument = async (url) => {
    const response = await axios.get(url, {
        responseType: 'stream', timeout: 15000,
        headers: { Range: 'bytes=0-1023' }, maxRedirects: 3,
    });
    try {
        const type = String(response.headers['content-type'] || '').toLowerCase();
        if (/text\/html|application\/xhtml/.test(type)) throw new Error('Document URL returned a web page instead of a file');
        const first = await response.data[Symbol.asyncIterator]().next();
        const prefix = Buffer.from(first.value || '').subarray(0, 1024).toString('utf8').trimStart();
        if (!prefix || /^<!doctype\s+html|^<html\b/i.test(prefix)) throw new Error('Document URL did not return a usable file');
        return true;
    } finally {
        response.data.destroy();
    }
};

module.exports = { validateDocument };
