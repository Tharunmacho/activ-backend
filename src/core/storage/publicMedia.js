const publicMediaOrigin = () => {
    const origin = require('../../config/publicUrl').publicOrigin();
    const explicit = String(process.env.PUBLIC_MEDIA_URL || '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    // The public website moved to a separate host. It no longer serves uploads.
    return /^https?:\/\/(?:www\.)?activ\.org\.in$/i.test(origin) ? 'https://api.activ.org.in' : origin;
};
module.exports = { publicMediaOrigin };
