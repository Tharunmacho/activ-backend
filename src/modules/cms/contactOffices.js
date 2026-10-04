/**
 * OFFICES, MAPS AND SOCIAL LINKS — the Contact page's data rules, pure.
 *
 * WHY THE PASTED MAP NEVER SHOWED. The Contact page put `mapEmbedUrl` straight
 * into an <iframe src>. That works for exactly one input — the `…/maps/embed?pb=…`
 * URL inside Google's "Embed a map" code — and editors paste everything else:
 *
 *   - a share link, `https://maps.app.goo.gl/…`            → Google refuses to be framed
 *   - a place link, `https://www.google.com/maps/place/…`  → X-Frame-Options, blank box
 *   - the whole `<iframe …>` tag                           → the src is HTML, not a URL
 *   - just the address                                      → not a URL at all
 *
 * `resolveMap` turns ANY of those into a URL Google allows in a frame
 * (`https://www.google.com/maps?q=…&output=embed`, or the original `/maps/embed`),
 * plus an ordinary link for "Open in Google Maps" / "Get directions". Only
 * google.com map URLs are ever emitted, so an editor cannot put an arbitrary
 * site in the page's frame.
 */

const MAX_Q = 300;

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

/** A Google host we accept: google.com, www.google.co.in, maps.google.com … */
const isGoogleHost = (host) => /(^|\.)google\.[a-z.]{2,6}$/i.test(String(host || ''));
const isShortHost = (host) => /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i.test(String(host || ''));

const LAT_LNG = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

const embedFor = (q) => `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
const linkFor = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const directionsFor = (q) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;

const decodeSeg = (s) => {
    try { return decodeURIComponent(String(s || '').replace(/\+/g, ' ')).trim(); } catch { return String(s || '').trim(); }
};

const htmlDecode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * What a Google Maps URL points at, as a search query ("place" or "lat,lng").
 * Returns '' when the URL names nothing we can read.
 */
const queryFromGoogleUrl = (u) => {
    const path = u.pathname || '';
    // The exact pin, when the URL carries it: …!3d13.0067!4d80.2206…
    const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(u.href);
    const place = /\/maps\/place\/([^/]+)/.exec(path);
    if (place && place[1]) {
        const name = decodeSeg(place[1]);
        if (pin) return `${pin[1]},${pin[2]}`;
        if (name) return name;
    }
    if (pin) return `${pin[1]},${pin[2]}`;
    const search = /\/maps\/search\/([^/]+)/.exec(path);
    if (search && search[1]) return decodeSeg(search[1]);
    const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('destination') || u.searchParams.get('daddr');
    if (q) return decodeSeg(q);
    const dir = /\/maps\/dir\/(.+)$/.exec(path);
    if (dir) {
        const parts = dir[1].split('/').filter((p) => p && !p.startsWith('@') && !p.startsWith('data='));
        if (parts.length) return decodeSeg(parts[parts.length - 1]);
    }
    const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(path);
    if (at) return `${at[1]},${at[2]}`;
    return '';
};

/**
 * Everything that can be decided WITHOUT the network.
 * @returns {{ embedUrl, mapLink, directionsUrl, query, shortLink }}
 *   `shortLink` is set when the input is a goo.gl share link that has to be
 *   followed first (see `resolveMap`).
 */
const normalizeMap = (input, fallbackAddress = '') => {
    const fallback = str(fallbackAddress).slice(0, MAX_Q);
    const fromQuery = (q) => (q
        ? { embedUrl: embedFor(q), mapLink: linkFor(q), directionsUrl: directionsFor(q), query: q, shortLink: '' }
        : fromFallback());
    const fromFallback = () => (fallback
        ? { embedUrl: embedFor(fallback), mapLink: linkFor(fallback), directionsUrl: directionsFor(fallback), query: fallback, shortLink: '' }
        : { embedUrl: '', mapLink: '', directionsUrl: '', query: '', shortLink: '' });

    let raw = str(input);
    if (!raw) return fromFallback();

    // The whole "Embed a map" snippet: take its src.
    if (/<iframe/i.test(raw)) {
        const m = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(raw);
        if (!m) return fromFallback();
        raw = htmlDecode(m[1]).trim();
    }

    if (LAT_LNG.test(raw)) {
        const [, lat, lng] = LAT_LNG.exec(raw);
        return fromQuery(`${lat},${lng}`);
    }

    let url = null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^(www\.|maps\.|goo\.gl|maps\.app\.goo\.gl)/i.test(raw)) {
        try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { url = null; }
        // A scheme that is not http(s) — javascript:, data:, file: — is never a map.
        if (!url || !/^https?:$/.test(url.protocol)) return fromFallback();
    }

    if (url) {
        if (isShortHost(url.hostname)) {
            return { ...fromFallback(), shortLink: `https://${url.hostname}${url.pathname}${url.search}` };
        }
        // google.com/maps/…, or the maps.google.* host (whose links live at /?q=…).
        const isMapUrl = isGoogleHost(url.hostname) && (/^\/maps/.test(url.pathname) || /^maps\./i.test(url.hostname));
        if (!isMapUrl) return fromFallback();
        if (/^\/maps\/embed/.test(url.pathname)) {
            // Already an embed URL: keep it, on the canonical host.
            const embedUrl = `https://www.google.com${url.pathname}${url.search}`;
            const q = url.searchParams.get('q') ? decodeSeg(url.searchParams.get('q')) : fallback;
            return { embedUrl, mapLink: q ? linkFor(q) : '', directionsUrl: q ? directionsFor(q) : '', query: q, shortLink: '' };
        }
        return fromQuery(queryFromGoogleUrl(url).slice(0, MAX_Q));
    }

    // Plain text: an address or a place name.
    return fromQuery(raw.replace(/\s+/g, ' ').slice(0, MAX_Q));
};

/**
 * Follow a goo.gl share link to the long google.com/maps URL it stands for.
 * Max 3 hops, 4s each, and only ever to goo.gl / google hosts. '' on failure.
 */
const followShortLink = async (start, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) => {
    let current = start;
    for (let hop = 0; hop < 3; hop += 1) {
        let res;
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        try {
            res = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: ctrl ? ctrl.signal : undefined });
        } catch {
            return '';
        } finally {
            if (timer) clearTimeout(timer);
        }
        const next = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : '';
        if (!next) return '';
        let u;
        try { u = new URL(next, current); } catch { return ''; }
        if (!/^https?:$/.test(u.protocol)) return '';
        if (isGoogleHost(u.hostname) && (/^\/maps/.test(u.pathname) || /^maps\./i.test(u.hostname))) return u.href;
        if (!isShortHost(u.hostname) && !isGoogleHost(u.hostname)) return '';
        current = u.href;
    }
    return '';
};

/** `normalizeMap`, plus the network step for share links. Never throws. */
const resolveMap = async (input, fallbackAddress = '', opts = {}) => {
    const first = normalizeMap(input, fallbackAddress);
    if (!first.shortLink) return first;
    const resolver = opts.resolver || ((u) => followShortLink(u, opts));
    let long = '';
    try { long = await resolver(first.shortLink); } catch { long = ''; }
    if (!long) {
        const { shortLink, ...rest } = first;
        // Could not be followed: the address still draws a map, and "Open in
        // Google Maps" keeps the editor's own link, which works in a new tab.
        return { ...rest, mapLink: shortLink, shortLink: '' };
    }
    const second = normalizeMap(long, fallbackAddress);
    return { ...second, shortLink: '' };
};

/* ============================================================== offices */

const stringList = (v) => (Array.isArray(v) ? v : String(v || '').split('\n'))
    .map((s) => str(s)).filter(Boolean).slice(0, 12);
const asBool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 'true' || v === 1 || v === '1');

let seq = 0;
const newId = () => `office-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

/** One office as the editor sent it, cleaned. The map is resolved separately. */
const cleanOffice = (o = {}, index = 0) => ({
    id: str(o.id).slice(0, 60) || newId(),
    state: str(o.state).slice(0, 80),
    label: str(o.label).slice(0, 80),
    isHeadOffice: asBool(o.isHeadOffice, false),
    addressLines: stringList(o.addressLines),
    phone: str(o.phone).slice(0, 40),
    alternatePhone: str(o.alternatePhone).slice(0, 40),
    email: str(o.email).toLowerCase().slice(0, 120),
    whatsapp: str(o.whatsapp).slice(0, 40),
    workingHours: stringList(o.workingHours),
    mapInput: str(o.mapInput).slice(0, 4000),
    order: Number.isFinite(Number(o.order)) ? Number(o.order) : index,
    isActive: asBool(o.isActive, true),
});

/**
 * Exactly one head office, among the active ones, and a stable order.
 * The first office flagged head wins; none flagged → the first active one.
 */
const settleOffices = (list = []) => {
    const offices = list.filter((o) => o && (o.state || o.addressLines.length || o.phone || o.email || o.mapInput))
        .sort((a, b) => a.order - b.order)
        .map((o, i) => ({ ...o, order: i }));
    let head = offices.findIndex((o) => o.isHeadOffice && o.isActive);
    if (head < 0) head = offices.findIndex((o) => o.isActive);
    return offices.map((o, i) => ({ ...o, isHeadOffice: i === head }));
};

/** An office built from the legacy single-office fields, when none are stored. */
const legacyOffice = (doc = {}) => {
    const has = (doc.addressLines || []).length || doc.phone || doc.email || doc.mapEmbedUrl;
    if (!has) return null;
    return {
        id: 'head-office',
        state: '',
        label: 'Head Office',
        isHeadOffice: true,
        addressLines: doc.addressLines || [],
        phone: doc.phone || '',
        alternatePhone: doc.alternatePhone || '',
        email: doc.email || '',
        whatsapp: '',
        workingHours: doc.workingHours || [],
        mapInput: doc.mapEmbedUrl || '',
        ...normalizeMap(doc.mapEmbedUrl, (doc.addressLines || []).join(', ')),
        order: 0,
        isActive: true,
    };
};

/* =============================================================== social */

const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'x', 'linkedin', 'youtube', 'whatsapp', 'telegram', 'threads'];

const SOCIAL_BASE = {
    facebook: 'https://www.facebook.com/',
    instagram: 'https://www.instagram.com/',
    x: 'https://x.com/',
    linkedin: 'https://www.linkedin.com/company/',
    youtube: 'https://www.youtube.com/@',
    telegram: 'https://t.me/',
    threads: 'https://www.threads.com/@',
};

/**
 * A pasted social link, as a URL a browser can open.
 *   "@activ"            → the platform's profile URL
 *   "instagram.com/x"   → "https://instagram.com/x"
 *   WhatsApp "98765 43210" / "+91 98765…" → "https://wa.me/919876543210"
 * Anything with a non-http scheme is refused ('').
 */
const socialUrl = (platform, input) => {
    let v = str(input);
    if (!v) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https?:/i.test(v)) return '';
    if (platform === 'whatsapp') {
        if (!/^https?:|wa\.me|whatsapp\.com/i.test(v)) {
            let digits = v.replace(/\D/g, '');
            if (digits.length === 10) digits = `91${digits}`;
            return digits.length >= 11 && digits.length <= 15 ? `https://wa.me/${digits}` : '';
        }
    }
    // A handle: "@activ.india", or a bare name with no dot and no slash.
    const isHandle = /^@[A-Za-z0-9._-]+$/.test(v) || /^[A-Za-z0-9_-]+$/.test(v);
    if (isHandle && SOCIAL_BASE[platform]) {
        return `${SOCIAL_BASE[platform]}${v.replace(/^@/, '')}`;
    }
    if (!/^https?:\/\//i.test(v)) v = `https://${v.replace(/^\/+/, '')}`;
    try {
        const u = new URL(v);
        if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
        return u.href;
    } catch {
        return '';
    }
};

const cleanSocial = (social = {}) => {
    const out = {};
    for (const p of SOCIAL_PLATFORMS) {
        // `twitter` was the old name for X; carry it over.
        const raw = p === 'x' ? (social.x || social.twitter) : social[p];
        out[p] = socialUrl(p, raw);
    }
    return out;
};

// Legacy footer rows sometimes carry the wrong icon. The URL identifies the
// network before the icon is used as a fallback for a bare handle.
const socialPlatform = (href, icon = '') => {
    let host = '';
    try { host = new URL(/^https?:\/\//i.test(str(href)) ? href : `https://${href}`).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
    const hosts = { facebook: ['facebook.com', 'fb.com'], instagram: ['instagram.com'], x: ['x.com', 'twitter.com'], linkedin: ['linkedin.com'], youtube: ['youtube.com', 'youtu.be'], whatsapp: ['whatsapp.com', 'wa.me'], telegram: ['t.me', 'telegram.me'], threads: ['threads.com', 'threads.net'] };
    for (const [p, names] of Object.entries(hosts)) if (names.some(h => host === h || host.endsWith(`.${h}`))) return p;
    const p = icon === 'twitter' ? 'x' : str(icon).toLowerCase();
    return SOCIAL_PLATFORMS.includes(p) ? p : null;
};
const footerSocial = (rows = []) => {
    const out = {};
    for (const row of rows) {
        const p = socialPlatform(row?.href, row?.icon);
        const href = p ? socialUrl(p, row?.href) : '';
        if (href && !out[p]) out[p] = href;
    }
    return cleanSocial(out);
};
const mergeSocial = (social = {}, rows = []) => {
    const out = footerSocial(rows), primary = cleanSocial(social);
    for (const p of SOCIAL_PLATFORMS) if (primary[p]) out[p] = primary[p];
    // Threads uses the Instagram handle when the association has not specified
    // a separate one, matching the existing public social buttons.
    if (!out.threads && out.instagram) {
        try { const handle = new URL(out.instagram).pathname.split('/').filter(Boolean)[0];
            if (handle && !['p', 'reel', 'explore', 'stories'].includes(handle)) out.threads = socialUrl('threads', `@${handle}`);
        } catch {}
    }
    return out;
};
const socialRows = (social = {}) => SOCIAL_PLATFORMS.filter(p => social[p])
    .map(p => ({ icon: p === 'x' ? 'twitter' : p, href: social[p] }));

module.exports = {
    normalizeMap,
    resolveMap,
    followShortLink,
    cleanOffice,
    settleOffices,
    legacyOffice,
    socialUrl,
    cleanSocial,
    socialPlatform, footerSocial, mergeSocial, socialRows,
    SOCIAL_PLATFORMS,
    isGoogleHost,
};
