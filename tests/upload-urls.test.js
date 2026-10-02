/**
 * Upload URL normalisation — pure unit tests, no database.
 *
 *   node tests/upload-urls.test.js
 */

const { relativizeUploadUrl, uploadNameOf, rewriteUploadUrls } = require('../src/core/storage/uploadUrls');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};
const eq = (label, actual, expected) => check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);

console.log('\nrelativizeUploadUrl');
eq('site host is stripped', relativizeUploadUrl('https://activ.org.in/uploads/cms-1.png'), '/uploads/cms-1.png');
eq('localhost is stripped', relativizeUploadUrl('http://localhost:5000/uploads/cms-1.png'), '/uploads/cms-1.png');
eq('emulator alias is stripped', relativizeUploadUrl('http://10.0.2.2:5000/uploads/x.jpg'), '/uploads/x.jpg');
eq('nested member photo keeps its folders', relativizeUploadUrl('https://api.activ.org.in/uploads/members/a-1/profile-2.jpg'), '/uploads/members/a-1/profile-2.jpg');
eq('a render-time ?w= is dropped', relativizeUploadUrl('https://activ.org.in/uploads/cms-1.png?w=800'), '/uploads/cms-1.png');
eq('relative stays relative', relativizeUploadUrl('/uploads/cms-2.jpg'), '/uploads/cms-2.jpg');
eq('Unsplash is untouched', relativizeUploadUrl('https://images.unsplash.com/photo-1?auto=format'), 'https://images.unsplash.com/photo-1?auto=format');
eq('a CDN path that merely contains "uploads" is untouched', relativizeUploadUrl('https://cdn.example.com/x/uploads/n.png'), 'https://cdn.example.com/x/uploads/n.png');
eq('site-relative logo is untouched', relativizeUploadUrl('/logo_ACTIVian-removebg-preview.png'), '/logo_ACTIVian-removebg-preview.png');
eq('null is empty', relativizeUploadUrl(null), '');
eq('whitespace is trimmed', relativizeUploadUrl('  /uploads/a.png  '), '/uploads/a.png');

console.log('\nuploadNameOf');
eq('name of an absolute url', uploadNameOf('https://activ.org.in/uploads/cms-1.png'), 'cms-1.png');
eq('name of a relative url', uploadNameOf('/uploads/members/x/y.jpg'), 'members/x/y.jpg');
eq('no name for a foreign url', uploadNameOf('https://images.unsplash.com/photo-1'), '');

console.log('\nrewriteUploadUrls');
const doc = {
    _id: 'abc',
    title: 'Home',
    hero: { media: { url: 'https://activ.org.in/uploads/cms-1.png', alt: 'x' } },
    slides: [
        { media: { url: '/uploads/cms-2.jpg' } },
        { media: { url: 'http://localhost:5000/uploads/cms-3.png' } },
        { media: { url: 'https://images.unsplash.com/photo-9' } },
    ],
    'dotted.key': { url: 'https://activ.org.in/uploads/never-addressed.png' },
    createdAt: new Date('2026-01-01'),
    count: 3,
};
const { sets, names } = rewriteUploadUrls(doc);
eq('only absolute upload urls are rewritten', sets, {
    'hero.media.url': '/uploads/cms-1.png',
    'slides.1.media.url': '/uploads/cms-3.png',
});
eq('every referenced upload is collected, relative ones included', [...names].sort(), ['cms-1.png', 'cms-2.jpg', 'cms-3.png', 'never-addressed.png']);
check('a document with nothing to change yields no sets', Object.keys(rewriteUploadUrls({ a: '/uploads/x.png', b: 'hello' }).sets).length === 0);
check('a non-object is tolerated', Object.keys(rewriteUploadUrls(null).sets).length === 0 && rewriteUploadUrls('x').names.size === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
