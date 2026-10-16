const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const ApiError = require('../../core/utils/ApiError');
const config = require('../../config');

const TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
};
const IMAGE_LIMIT = 5 * 1024 * 1024;
const FILE_LIMIT = 10 * 1024 * 1024;
const FILE_ID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: FILE_LIMIT } })
    .fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 1 }]);
const receive = (req, res, next) => upload(req, res, error => next(error
    ? ApiError.badRequest(error.code === 'LIMIT_FILE_SIZE' ? 'Documents and audio must be 10 MB or smaller; photos must be 5 MB or smaller.' : 'Choose one photo, document or audio file to attach.')
    : undefined));
const cleanName = value => path.basename(String(value || '').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '-').replace(/^[. ]+|[. ]+$/g, '').slice(-120);

function officeZip(buffer, extension) {
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
    }
    if (end < 0) return false;
    const count = buffer.readUInt16LE(end + 10), length = buffer.readUInt32LE(end + 12);
    let cursor = buffer.readUInt32LE(end + 16), expanded = 0;
    if (!count || count > 2000 || cursor + length !== end) return false;
    const names = new Set();
    for (let n = 0; n < count; n++) {
        if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) return false;
        const flags = buffer.readUInt16LE(cursor + 8), size = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
        const next = cursor + 46 + nameLength + extra + comment;
        if (next > end || flags & 1 || (expanded += size) > 64 * 1024 * 1024) return false;
        const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8').toLowerCase();
        if (name.includes('..') || name.includes('\\') || name.startsWith('/') || /vbaproject|\.(exe|dll|com|bat|cmd|ps1|vbs|js|jar|scr)$/i.test(name)) return false;
        names.add(name); cursor = next;
    }
    const required = { docx: 'word/document.xml', xlsx: 'xl/workbook.xml', pptx: 'ppt/presentation.xml' }[extension];
    return cursor === end && names.has('[content_types].xml') && names.has(required);
}

async function validateFile(file) {
    const name = cleanName(file?.originalname), extension = path.extname(name).slice(1).toLowerCase();
    const mimeType = TYPES[extension], buffer = file?.buffer;
    if (!mimeType) throw ApiError.badRequest('Choose a photo, document or MP3, M4A, AAC, WAV, Ogg or WebM audio file.');
    const received = String(file.mimetype || '').toLowerCase();
    const aliases = { 'image/jpg': 'image/jpeg', 'text/comma-separated-values': 'text/csv', 'text/rtf': 'application/rtf', 'audio/x-m4a': 'audio/mp4', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-aac': 'audio/aac', 'application/ogg': 'audio/ogg' };
    if (received && received !== 'application/octet-stream' && (aliases[received] || received) !== mimeType) {
        throw ApiError.badRequest('The file type does not match its name. Choose the original document.');
    }
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'file';
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw ApiError.badRequest('This file is empty or could not be read.');
    if (buffer.length > (kind === 'image' ? IMAGE_LIMIT : FILE_LIMIT)) throw ApiError.badRequest(kind === 'image' ? 'Photos must be 5 MB or smaller.' : 'Documents and audio must be 10 MB or smaller.');
    let valid = false;
    if (kind === 'image') {
        try {
            const image = await require('sharp')(buffer, { limitInputPixels: 40000000 }).metadata();
            valid = image.format === (extension === 'jpg' ? 'jpeg' : extension) && image.width > 0 && image.height > 0;
        } catch { valid = false; }
    } else if (kind === 'audio') valid = validAudio(buffer, extension);
    else if (extension === 'pdf') valid = buffer.subarray(0, 5).toString() === '%PDF-';
    else if (['doc', 'xls', 'ppt'].includes(extension)) valid = buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'));
    else if (['docx', 'xlsx', 'pptx'].includes(extension)) valid = officeZip(buffer, extension);
    else {
        try {
            const contents = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            valid = !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(contents) && !/^\s*<(?:!doctype\s+html|html|script)\b/i.test(contents);
            if (extension === 'rtf') valid = valid && /^\{\\rtf[0-9]/.test(contents) && !/\\(?:object|objdata)\b/i.test(contents);
        } catch { valid = false; }
    }
    if (!valid) throw ApiError.badRequest('This file is not a valid supported document, photo or audio recording. Choose the original file.');
    return { name, mimeType, size: buffer.length, kind };
}

function validAudio(buffer, extension) {
    if (buffer.length < 12) return false;
    const header = buffer.subarray(0, Math.min(buffer.length, 256 * 1024));
    if (extension === 'wav') return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE' && header.includes(Buffer.from('fmt ')) && buffer.includes(Buffer.from('data'));
    if (extension === 'm4a') return header.toString('ascii', 4, 8) === 'ftyp' && buffer.includes(Buffer.from('soun')) && !buffer.includes(Buffer.from('vide'));
    if (extension === 'ogg' || extension === 'opus') return header.toString('ascii', 0, 4) === 'OggS' && (header.includes(Buffer.from('OpusHead')) || header.includes(Buffer.from('vorbis'))) && !header.includes(Buffer.from('theora'));
    if (extension === 'webm') return header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex')) && (header.includes(Buffer.from('A_OPUS')) || header.includes(Buffer.from('A_VORBIS'))) && !header.includes(Buffer.from('V_VP')) && !header.includes(Buffer.from('V_AV1'));
    if (extension === 'aac') return buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0;
    if (extension === 'mp3') {
        let offset = 0;
        if (header.toString('ascii', 0, 3) === 'ID3') {
            if ([6, 7, 8, 9].some(i => buffer[i] & 0x80)) return false;
            offset = 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9]);
        }
        return offset + 4 < buffer.length && buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0 && (buffer[offset + 1] & 6) !== 0 && (buffer[offset + 2] & 0xf0) !== 0xf0 && (buffer[offset + 2] & 12) !== 12;
    }
    return false;
}

async function storeUpload(req, ownerId) {
    const file = req.files?.file?.[0] || req.files?.image?.[0];
    if (!file) throw ApiError.badRequest('Choose a photo, document or audio file to attach.');
    const meta = await validateFile(file);
    if (file.fieldname === 'image' && meta.kind !== 'image') throw ApiError.badRequest('Choose a photo for the image attachment.');
    const id = crypto.randomUUID(), category = meta.kind === 'image' ? 'chat-images' : meta.kind === 'audio' ? 'chat-audio' : 'chat-files';
    const storedName = meta.name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[-.]+/, '') || `document.${path.extname(meta.name).slice(1)}`;
    const filename = `${category}/${id}/${storedName}`;
    const target = path.join(require('../../core/storage/uploadStore').UPLOADS_DIR, filename);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.buffer, { flag: 'wx' });
    // Existing app middleware persists validated bytes to S3/GridFS after success.
    req.file = { ...file, filename, path: target, mimetype: meta.mimeType };
    req.files = undefined;
    const url = meta.kind === 'image' ? `/uploads/${filename}` : `/api/${config.apiVersion}/messages/attachments/${id}`;
    const attachment = { id, url, ...meta, storageName: filename };
    const token = jwt.sign(attachment, config.jwt.secret, { algorithm: 'HS256', subject: String(ownerId), audience: 'activ-chat-upload', expiresIn: '2d' });
    return { id, url, ...meta, token };
}

function forMessage(ownerId, attachmentUrl, attachment) {
    if (attachment?.token) {
        let value;
        try { value = jwt.verify(attachment.token, config.jwt.secret, { algorithms: ['HS256'], audience: 'activ-chat-upload', subject: String(ownerId) }); }
        catch { throw ApiError.badRequest('This attachment is no longer available to send. Choose the file again.'); }
        const { id, url, name, mimeType, size, kind, storageName } = value;
        if (!FILE_ID.test(id) || !TYPES[path.extname(name).slice(1).toLowerCase()]) throw ApiError.badRequest('Invalid attachment. Choose the file again.');
        return { id, url, name, mimeType, size, kind, storageName };
    }
    const url = String(attachmentUrl || '').trim();
    if (!url) return null;
    // Legacy clients post only the upload URL. Keep their raster photos working;
    // documents require their signed, owner-bound upload receipt.
    if (!/^\/uploads\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.(?:jpe?g|png|webp|gif)$/i.test(url)) {
        throw ApiError.badRequest('Choose a photo or document using Attach before sending it.');
    }
    return { url, kind: 'image' };
}
const publicMetadata = value => value?.id ? { id: value.id, url: value.url, name: value.name, mimeType: value.mimeType, size: value.size, kind: value.kind } : null;

function blockPublicFiles(req, res, next) {
    let requested;
    try { requested = path.posix.normalize('/' + decodeURIComponent(req.path || '').replace(/\\/g, '/')); }
    catch { return res.status(400).end(); }
    if (/^\/chat-(?:files|audio)(?:\/|$)/i.test(requested)) return res.status(404).end();
    return next();
}

async function download(attachment, res) {
    const store = require('../../core/storage/uploadStore');
    const name = attachment.storageName;
    if (!/^chat-(?:files|images|audio)\/[a-f\d-]{36}\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name || '')) throw ApiError.notFound('Attachment not found');
    let stream;
    try {
        const target = path.join(store.UPLOADS_DIR, name);
        await fs.access(target);
        stream = require('fs').createReadStream(target);
    } catch { /* A deployment can clear the disk cache. Read durable storage. */ }
    if (!stream && store.objectStore.isEnabled()) {
        const object = await store.objectStore.getObject(name);
        if (object?.body) stream = object.body;
    }
    if (!stream) {
        const bucket = store.bucket();
        const files = bucket ? await bucket.find({ filename: name }).sort({ uploadDate: -1 }).limit(1).toArray() : [];
        if (files.length) stream = bucket.openDownloadStream(files[0]._id);
    }
    if (!stream) throw ApiError.notFound('This attachment is unavailable. Ask the sender to attach it again.');
    res.attachment(attachment.name);
    res.type(attachment.mimeType);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

module.exports = { TYPES, FILE_ID, IMAGE_LIMIT, FILE_LIMIT, receive, cleanName, validateFile, storeUpload, forMessage, publicMetadata, blockPublicFiles, download };
