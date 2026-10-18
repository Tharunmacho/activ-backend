// All advertised fields, truthful fallbacks and channel parity. No I/O.
const assert = require('node:assert/strict');
const { BUILTINS, variableValues, missingVariables } = require('../src/modules/common/updateVariables');
const { personalizeUpdate } = require('../src/modules/common/recipientPersonalization');
const messages = require('../src/modules/notifications/associationUpdateMessage');
const recipient = { _id: '507f1f77bcf86cd799439011', fullName: 'Alex Member', companyName: 'Recorded Company',
    membershipExpiresAt: '2099-12-31T00:00:00Z', membershipActivatedAt: '2025-01-01T00:00:00Z',
    membershipNumber: 'ACT-001', lastPaidFee: 'INR 1,234.50', email: 'member@example.test', phoneNumber: '9123456780',
    state: 'Tamil Nadu', district: 'Chennai', block: 'Central', city: 'Chennai', country: 'India', place: 'Recorded place' };
const expected = { name: 'Alex Member', title: 'Dr', company_name: 'Recorded Company', date: '17 Oct 2026',
    renewal_date: '31 Dec 2099', fee: 'INR 500 quoted', renewal_fee: 'Ask the office for a renewal quote',
    last_paid_fee: 'INR 1,234.50', membership_number: 'ACT-001', email: 'member@example.test', phone: '9123456780',
    state: 'Tamil Nadu', district: 'Chennai', block: 'Central', city: 'Chennai', country: 'India', place: 'Recorded place', member_since: '01 Jan 2025' };
const variables = [
    { key: 'title', defaultValue: 'ACTIV member', overrides: [{ memberId: recipient._id, value: 'Dr' }] },
    { key: 'fee', defaultValue: 'INR 500 quoted', overrides: [] },
    { key: 'renewal_fee', defaultValue: 'Ask the office for a renewal quote', overrides: [] },
];
assert.deepEqual(BUILTINS.map(row => row.key).sort(), Object.keys(expected).sort(), 'every advertised built-in has an explicit test case');
for (const { key } of BUILTINS) {
    const update = { title: `Notice {${key}}`, summary: `Summary {${key}}`, body: `<p>Message {${key}}</p>`,
        bannerAlt: `Poster {${key}}`, attachmentLabel: `Document {${key}}`, variables, publishedAt: '2026-10-17T12:00:00Z' };
    const rendered = personalizeUpdate(update, recipient);
    for (const field of ['title', 'summary', 'body', 'bannerAlt', 'attachmentLabel']) {
        assert(rendered[field].includes(expected[key]), `${key} resolves in ${field}`);
        assert(!rendered[field].includes(`{${key}}`), `${key} never leaks unresolved`);
    }
    const external = messages.render(update, recipient);
    assert.equal(external.params[1], rendered.title, `${key} WhatsApp title matches in-app title`);
    assert(external.html.includes(expected[key]), `${key} reaches email rendering`);
    assert.deepEqual(missingVariables(update, recipient), []);
}
assert.equal(variableValues({ createdAt: '2026-10-17T12:00:00Z' }, {}).date, '17 Oct 2026',
    'legacy publication uses its recorded creation date, matching the displayed update date');
assert.equal(variableValues({}, {}).date, '', 'missing dates are never invented');
assert.equal(variableValues({}, { gender: 'female' }).title, '', 'salutation is never inferred from gender');
assert.equal(variableValues({}, recipient).fee, '', 'last payment is not guessed to be the fee for this notice');
assert.equal(variableValues({}, { ...recipient, membershipType: 'lifetime' }).renewal_date, '');
assert.deepEqual(missingVariables({ title: '{title}', body: '{fee} {renewal_date} {name}' }, {}), ['title', 'fee', 'renewal_date']);
const general = personalizeUpdate({ title: 'Dear {name}', body: '{company_name}; {custom}', variables: [
    { key: 'company_name', defaultValue: 'your company', overrides: [] },
    { key: 'custom', defaultValue: '<private> & {name}', overrides: [] },
] }, {});
assert.equal(general.title, 'Dear ACTIVian');
assert.equal(general.body, 'your company; &lt;private&gt; &amp; {name}', 'missing recipients use authored fallback safely without recursive expansion');
console.log('PASS all 18 advertised variables across five content fields, email/WhatsApp title parity, legacy publication date, explicit salutations/fees, missing-value preview and safe visitor fallback. No external requests.');
