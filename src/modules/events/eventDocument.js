const axios = require('axios');
const { relativizeUploadUrl } = require('../../core/storage/uploadUrls');

const documentUrl = (value) => {
    const relative = relativizeUploadUrl(value);
    if (!relative) return '';
    if (relative.startsWith('/uploads/')) return `${require('../../core/storage/publicMedia').publicMediaOrigin()}${relative}`;
    return relative;
};

// Old notification rows retain the website URL that failed. Resolve the same
// attachment against the current event, then anchor uploads to the API host.
const documentForResend = (row = {}, attachments = []) => {
    const data = row.data || {};
    const header = data.headerDocument || {};
    const storedUrl = header.link || data.document || '';
    const name = header.filename || row.subject || '';
    const identity = relativizeUploadUrl(storedUrl);
    let current = attachments.find(a => identity && relativizeUploadUrl(a.url) === identity);
    if (!current && name) {
        const named = attachments.filter(a => a.name === name);
        if (named.length === 1) current = named[0];
    }
    const link = documentUrl(current ? current.url : storedUrl);
    if (!link) return null;
    return { link, filename: current && current.name || name || 'Event document' };
};

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

module.exports = { validateDocument, documentUrl, documentForResend };
