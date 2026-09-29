/**
 * Contact offices, pasted maps and social links — pure, no DB, no network.
 *   node tests/contact-offices.test.js
 */
const {
    normalizeMap, resolveMap, followShortLink, cleanOffice, settleOffices, legacyOffice, socialUrl, cleanSocial,
} = require('../src/modules/cms/contactOffices');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed += 1; console.log(`  ok    ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const isEmbed = (u) => /^https:\/\/www\.google\.com\/maps(\/embed\?|\?q=.*&output=embed$)/.test(u || '');

(async () => {
    section('pasted maps become a frameable Google URL');
    const embedSrc = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3887!2d80.2!3d13.0!2m3';
    let r = normalizeMap(embedSrc);
    check('embed URL kept as is', r.embedUrl === embedSrc, r.embedUrl);

    r = normalizeMap(`<iframe src="${embedSrc.replace(/&/g, '&amp;')}" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy"></iframe>`);
    check('whole <iframe> tag → its src', r.embedUrl === embedSrc, r.embedUrl);

    r = normalizeMap('https://www.google.com/maps/place/ACTIV+Office,+Guindy/@13.0067,80.2206,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d13.0067!4d80.2206');
    check('place link with pin → q=lat,lng embed', isEmbed(r.embedUrl) && r.query === '13.0067,80.2206', r.embedUrl);

    r = normalizeMap('https://www.google.com/maps/place/Ilayaperumal+Apartments,+Velachery+Rd');
    check('place link without pin → q=place', isEmbed(r.embedUrl) && r.query === 'Ilayaperumal Apartments, Velachery Rd', r.query);

    r = normalizeMap('https://www.google.com/maps/@12.9716,77.5946,15z');
    check('@lat,lng link → q=lat,lng', r.query === '12.9716,77.5946', r.query);

    r = normalizeMap('https://maps.google.com/?q=DNC+Vijay+Mahal,+Dharmapuri');
    check('?q= link → q', r.query === 'DNC Vijay Mahal, Dharmapuri', r.query);

    r = normalizeMap('13.0827, 80.2707');
    check('plain "lat, lng" → q', r.query === '13.0827,80.2707' && isEmbed(r.embedUrl));

    r = normalizeMap('6, Ilayaperumal Apartments, 121 Velachery Road, Guindy, Chennai 600032');
    check('plain address → q embed', isEmbed(r.embedUrl) && /Guindy/.test(decodeURIComponent(r.embedUrl)));
    check('an "Open in Maps" link is produced', /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/.test(r.mapLink));
    check('a directions link is produced', /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/.test(r.directionsUrl));

    r = normalizeMap('', 'Guindy, Chennai');
    check('empty input → the address', r.query === 'Guindy, Chennai' && isEmbed(r.embedUrl));
    r = normalizeMap('', '');
    check('nothing at all → no map', r.embedUrl === '' && r.mapLink === '');

    section('hostile or foreign input never reaches the frame');
    r = normalizeMap('javascript:alert(1)', 'Chennai');
    check('javascript: → the address instead', r.query === 'Chennai' && isEmbed(r.embedUrl), r.embedUrl);
    r = normalizeMap('<iframe src="https://evil.example/pwn"></iframe>', 'Chennai');
    check('non-Google iframe → the address', r.query === 'Chennai', r.embedUrl);
    r = normalizeMap('https://evil.example/maps/embed?pb=1', 'Chennai');
    check('non-Google host with /maps/embed → the address', r.query === 'Chennai');
    r = normalizeMap('data:text/html,<b>x</b>', '');
    check('data: → nothing', r.embedUrl === '');

    section('share links are followed, only through Google');
    r = normalizeMap('https://maps.app.goo.gl/AbCdEf123');
    check('short link flagged for resolution', r.shortLink === 'https://maps.app.goo.gl/AbCdEf123', r.shortLink);
    r = await resolveMap('https://maps.app.goo.gl/AbCdEf123', 'Chennai', {
        resolver: async () => 'https://www.google.com/maps/place/Guindy/@13.0067,80.2206,17z/data=!3d13.0067!4d80.2206',
    });
    check('resolved short link → the pin', r.query === '13.0067,80.2206' && isEmbed(r.embedUrl), JSON.stringify(r));
    r = await resolveMap('https://maps.app.goo.gl/broken', 'Guindy, Chennai', { resolver: async () => '' });
    check('unresolvable short link → address map + the share link to open', r.query === 'Guindy, Chennai'
        && r.mapLink === 'https://maps.app.goo.gl/broken', JSON.stringify(r));

    // followShortLink with a fake fetch: two hops, then Google.
    const hops = {
        'https://maps.app.goo.gl/x': 'https://goo.gl/maps/y',
        'https://goo.gl/maps/y': 'https://www.google.com/maps/place/Hosur/@12.74,77.82,15z',
    };
    const fakeFetch = async (u) => ({ headers: { get: (h) => (h === 'location' ? hops[u] || '' : '') } });
    const long = await followShortLink('https://maps.app.goo.gl/x', { fetchImpl: fakeFetch });
    check('follows goo.gl hops to the Google URL', /google\.com\/maps\/place\/Hosur/.test(long), long);
    const evil = await followShortLink('https://maps.app.goo.gl/z', {
        fetchImpl: async () => ({ headers: { get: () => 'https://evil.example/steal' } }),
    });
    check('a redirect off Google is refused', evil === '', evil);

    section('offices');
    const a = cleanOffice({ state: 'Karnataka', isHeadOffice: 'true', addressLines: 'Line 1\nLine 2', isActive: 'false' });
    check('booleans that arrive as strings', a.isHeadOffice === true && a.isActive === false);
    check('address lines from text', a.addressLines.length === 2);
    const settled = settleOffices([
        cleanOffice({ state: 'Tamil Nadu', isHeadOffice: true, order: 1 }),
        cleanOffice({ state: 'Karnataka', isHeadOffice: true, order: 0 }),
        cleanOffice({ state: 'Kerala', order: 2 }),
    ]);
    check('exactly one head office', settled.filter((o) => o.isHeadOffice).length === 1);
    check('the first flagged (by order) wins', settled.find((o) => o.isHeadOffice).state === 'Karnataka');
    const none = settleOffices([cleanOffice({ state: 'Goa', isActive: false }), cleanOffice({ state: 'Delhi' })]);
    check('none flagged → the first ACTIVE office', none.find((o) => o.isHeadOffice).state === 'Delhi');
    check('empty rows dropped', settleOffices([cleanOffice({})]).length === 0);
    const legacy = legacyOffice({ addressLines: ['Guindy', 'Chennai'], phone: '+91 1', mapEmbedUrl: 'https://maps.app.goo.gl/q' });
    check('legacy fields → one head office', legacy && legacy.isHeadOffice && legacy.label === 'Head Office');
    check('legacy share link still draws the address map', legacy && isEmbed(legacy.embedUrl), legacy && legacy.embedUrl);
    check('no legacy details → no office', legacyOffice({}) === null);

    section('social links');
    check('@handle → profile URL', socialUrl('instagram', '@activ.india') === 'https://www.instagram.com/activ.india');
    check('bare host path → https', socialUrl('facebook', 'facebook.com/activindia') === 'https://facebook.com/activindia');
    check('full URL kept', socialUrl('linkedin', 'https://www.linkedin.com/company/activ') === 'https://www.linkedin.com/company/activ');
    check('WhatsApp 10-digit number → wa.me/91…', socialUrl('whatsapp', '82201 12188') === 'https://wa.me/918220112188');
    check('WhatsApp +91 number', socialUrl('whatsapp', '+91 82201 12188') === 'https://wa.me/918220112188');
    check('javascript: refused', socialUrl('facebook', 'javascript:alert(1)') === '');
    check('YouTube handle', socialUrl('youtube', '@ACTIVIndia') === 'https://www.youtube.com/@ACTIVIndia');
    const cs = cleanSocial({ twitter: '@activ', facebook: '' });
    check('old "twitter" carried to x', cs.x === 'https://x.com/activ' && cs.facebook === '');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
