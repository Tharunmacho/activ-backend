const ApiError = require('../../core/utils/ApiError');
const { cleanMedia, toMedia } = require('./cms.contentHelpers');
const { relativizeUploadUrl } = require('../../core/storage/uploadUrls');

const PHOTO_LIMIT = 20, ATTACHMENT_LIMIT = 10, LINK_LIMIT = 10, DOCUMENT_LIMIT = 20 * 1024 * 1024;
const DOCUMENT_MIMES = {
    pdf: 'application/pdf', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation', txt: 'text/plain', csv: 'text/csv',
    rtf: 'application/rtf', zip: 'application/zip',
};
const MIME_ALIASES = { 'application/x-zip-compressed': 'application/zip', 'text/rtf': 'application/rtf', 'text/comma-separated-values': 'text/csv' };
const text = (value, max = 160) => String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const visible = value => record(value) && value.isHidden !== true && value.visible !== false;

function array(value, name, limit) {
    let rows = value;
    if (typeof rows === 'string') {
        try { rows = JSON.parse(rows); } catch { throw ApiError.badRequest(`${name} must be a list.`); }
    }
    if (!Array.isArray(rows)) throw ApiError.badRequest(`${name} must be a list. Use an empty list to remove them.`);
    if (rows.length > limit) throw ApiError.badRequest(`Use no more than ${limit} ${name.toLowerCase()} per article.`);
    if (rows.some(row => !record(row))) throw ApiError.badRequest(`Each ${name.toLowerCase()} entry must be an object.`);
    return rows;
}

/** No fetching here: validate public destinations and keep upload identities relative. */
function assetUrl(value, kind) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw ApiError.badRequest('Enter a valid public URL.');
    if (/^https?:\/\//i.test(raw)) {
        let absolute;
        try { absolute = new URL(raw); } catch { throw ApiError.badRequest('Enter a valid public URL.'); }
        if (absolute.username || absolute.password) throw ApiError.badRequest('Use a public URL without sign-in credentials.');
    }
    const url = kind === 'link' ? raw : relativizeUploadUrl(raw);
    // Older newsroom rows also used bundled /images/... and root image paths.
    const legacyPhoto = kind === 'photo' && /^\/(?:(?:images|assets)\/[^?#]*|[^/?#]+)\.(?:jpe?g|png|gif|webp|avif|heic|heif|bmp|tiff?)(?:[?#].*)?$/i.test(url);
    if (kind !== 'link' && (url.startsWith('/uploads/') || legacyPhoto)) {
        const path = url.split(/[?#]/, 1)[0];
        const segments = path.slice(1).split('/');
        try {
            if (!segments.length || segments.some(segment => {
                const decoded = decodeURIComponent(segment);
                return !decoded || decoded === '.' || decoded === '..' || /[\u0000-\u001f\u007f/\\?#%]/.test(decoded);
            })) throw new Error('Invalid upload');
        } catch { throw ApiError.badRequest('Choose a valid uploaded file.'); }
        // Conversation documents require recipient authentication and cannot be published.
        if (/^\/uploads\/chat-(?:files|audio)(?:\/|$)/i.test(path)) throw ApiError.badRequest('Private message documents cannot be published as news.');
        return path;
    }
    let parsed;
    try { parsed = new URL(url); } catch { throw ApiError.badRequest('Enter a valid public URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
        throw ApiError.badRequest('Use a public http or https link without sign-in credentials.');
    }
    if (kind === 'attachment' && parsed.protocol !== 'https:') throw ApiError.badRequest('Document links must use HTTPS or an uploaded file.');
    return url;
}

const allowedUrl = (value, kind) => { try { return !!assetUrl(value, kind); } catch { return false; } };
function cleanPhoto(row) {
    if (!String(row.url || '').trim()) return null;
    return { ...cleanMedia(row), url: assetUrl(row.url, 'photo') };
}
function cleanAttachment(row) {
    if (!String(row.url || '').trim()) {
        if (row.label || row.filename || row.mimeType || row.size) throw ApiError.badRequest('Choose a file or enter the document URL.');
        return null;
    }
    const url = assetUrl(row.url, 'attachment');
    let basename = String(row.filename || url.split(/[?#]/, 1)[0].split('/').pop() || '').replace(/\\/g, '/').split('/').pop();
    try { basename = decodeURIComponent(basename); } catch { /* Keep an ordinary literal filename. */ }
    const filename = text(basename).replace(/[<>:"|?*]/g, '-');
    const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() || '';
    const supplied = String(row.mimeType || '').trim().toLowerCase();
    const mimeType = MIME_ALIASES[supplied] || supplied || DOCUMENT_MIMES[extension] || '';
    if (!Object.values(DOCUMENT_MIMES).includes(mimeType) || (extension && DOCUMENT_MIMES[extension] !== mimeType)) {
        throw ApiError.badRequest('Attach a PDF, Word, Excel, PowerPoint, OpenDocument, text, CSV, RTF or ZIP document with its matching file type.');
    }
    const size = row.size === undefined || row.size === null || row.size === '' ? 0 : Number(row.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > DOCUMENT_LIMIT) throw ApiError.badRequest('Each document must be 20 MB or smaller.');
    return { url, label: text(row.label) || filename || 'Document', filename, mimeType, size };
}
function cleanLink(row) {
    if (!String(row.url || '').trim()) {
        if (row.label) throw ApiError.badRequest('Enter the URL for each supporting link.');
        return null;
    }
    const url = assetUrl(row.url, 'link');
    return { url, label: text(row.label) || new URL(url).hostname };
}
const cleanPhotos = value => array(value, 'Photos', PHOTO_LIMIT).map(cleanPhoto).filter(Boolean);
const cleanAttachments = value => array(value, 'Documents', ATTACHMENT_LIMIT).map(cleanAttachment).filter(Boolean);
const cleanLinks = value => array(value, 'Supporting links', LINK_LIMIT).map(cleanLink).filter(Boolean);
// Legacy malformed rows never make the whole public article unavailable. Read
// all valid old rows; limits apply to intentional writes, never silent truncation.
const readRows = (value, clean) => (Array.isArray(value) ? value : []).filter(visible).flatMap(row => {
    try { const result = clean(row); return result ? [result] : []; } catch { return []; }
});
const readPhotos = value => readRows(value, row => { const result = cleanPhoto(row); return result ? toMedia(result) : null; });
const readAttachments = value => readRows(value, cleanAttachment);
const readLinks = value => readRows(value, cleanLink);

module.exports = { PHOTO_LIMIT, ATTACHMENT_LIMIT, LINK_LIMIT, DOCUMENT_LIMIT, DOCUMENT_MIMES, allowedUrl,
    cleanPhotos, cleanAttachments, cleanLinks, readPhotos, readAttachments, readLinks };
