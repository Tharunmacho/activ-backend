// Pure: no DB, no provider. WhatsApp follows email's rule — on unless the member switched it off.
const assert = require('node:assert/strict');
delete process.env.ASSOCIATION_UPDATE_WHATSAPP_REQUIRE_OPT_IN;
const { preferences } = require('../src/modules/notifications/updatePreferences');
const base = { phoneNumber: '9123456780' };
// A member who never chose (stored default `whatsapp: false`, no updatedAt) is reachable.
assert.equal(preferences({ ...base, associationUpdatePreferences: { email: true, whatsapp: false } }).whatsapp, true);
assert.equal(preferences({ ...base }).whatsapp, true);
// An explicit opt-out is honoured.
assert.equal(preferences({ ...base, associationUpdatePreferences: { whatsapp: false, updatedAt: new Date() } }).whatsapp, false);
// No usable number, no WhatsApp.
assert.equal(preferences({ associationUpdatePreferences: {} }).whatsapp, false);
// Strict mode restores the recorded-consent rule.
process.env.ASSOCIATION_UPDATE_WHATSAPP_REQUIRE_OPT_IN = 'true';
assert.equal(preferences({ ...base }).whatsapp, false);
console.log('PASS: WhatsApp update default, opt-out and strict mode');
