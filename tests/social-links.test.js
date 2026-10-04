const assert = require('assert/strict');
const { mergeSocial, socialRows, footerSocial, socialPlatform } = require('../src/modules/cms/contactOffices');
const oldRows = [
    { icon: 'instagram', href: 'activind' }, { icon: 'facebook', href: '#' },
    { icon: 'linkedin', href: '#' }, { icon: 'twitter', href: '#' },
    { icon: 'facebook', href: 'https://whatsapp.com/channel/fixture' }
];
const saved = { facebook: 'https://facebook.com/activind', instagram: 'https://instagram.com/activind', x: '@activind', linkedin: 'https://linkedin.com/company/activind', youtube: '@activind', telegram: '@activind' };
const links = mergeSocial(saved, oldRows);
assert.equal(Object.values(links).filter(Boolean).length, 8);
assert.equal(links.whatsapp, 'https://whatsapp.com/channel/fixture');
assert.equal(links.threads, 'https://www.threads.com/@activind');
assert.equal(links.facebook, saved.facebook);
assert.equal(footerSocial(oldRows).instagram, 'https://www.instagram.com/activind');
assert.equal(socialPlatform('https://whatsapp.com/channel/fixture', 'facebook'), 'whatsapp');
assert.equal(socialPlatform('https://facebook.com.evil.test/profile', ''), null);
assert.deepEqual(mergeSocial(links), mergeSocial({}, socialRows(links)), 'both editors return the same canonical links');
assert.equal(mergeSocial({ whatsapp: '8220112188' }).whatsapp, 'https://wa.me/918220112188');
assert.equal(mergeSocial({ facebook: 'javascript:alert(1)' }).facebook, '');
assert.equal(mergeSocial({}, [{icon: 'facebook', href: '#'}]).facebook, '');
assert.equal(mergeSocial({}, []).instagram, '', 'removing links does not resurrect old links');
assert.equal(mergeSocial({...saved, threads: 'https://www.threads.com/@custom'}).threads, 'https://www.threads.com/@custom');
console.log('Social links: eight networks, correct icons, handles, shared editor values, deletion and safe URL normalization passed.');
