/**
 * Delivery guard: which failures heal on a retry, and which never will.
 *
 *   node tests/delivery-guard.test.js      (pure — no DB, no network)
 *
 * Getting this wrong either way costs: a permanent failure retried is a
 * member messaged three times for nothing; a healable one not retried is the
 * 28–30 Sept outage again — 58 emails that stayed failed after the password
 * was fixed.
 */
const { isHealable } = require('../src/modules/notifications/deliveryGuard');

let passed = 0;
let failed = 0;
const check = (label, ok) => {
    if (ok) { passed += 1; console.log(`  ok    ${label}`); } else { failed += 1; console.log(`  FAIL  ${label}`); }
};
const row = (lastError) => ({ lastError });

console.log('\nheals on a retry');
check('SMTP 535 (the Sept outage)', isHealable(row('Invalid login: 535 Incorrect authentication data')));
check('connection refused', isHealable(row('connect ECONNREFUSED 1.2.3.4:465')));
check('timeout', isHealable(row('Connection timeout')));
check('DNS hiccup', isHealable(row('getaddrinfo EAI_AGAIN smtp.example.com')));
check('SMTP 421 try again later', isHealable(row('421 4.7.0 Try again later')));
check('WhatsApp rate limit 130429', isHealable(row('(#130429) Rate limit hit')));
check('WhatsApp generic 131000', isHealable(row('(#131000) Something went wrong')));
check('WhatsApp spam-rate 131048', isHealable(row('(#131048) Spam rate limit hit')));

console.log('\nnever retried');
check('not on WhatsApp 131026', !isHealable(row('(#131026) Message undeliverable')));
check('template missing 132001', !isHealable(row('(#132001) Template name does not exist in the translation')));
check('too long 132005', !isHealable(row('(#132005) Translated text too long')));
check('mailbox unavailable 550', !isHealable(row('550 5.1.1 Mailbox unavailable')));
check('invalid phone number', !isHealable(row('Invalid phone number')));
check('no reason recorded', !isHealable(row('')));
check("ACTIV's own WhatsApp number", !isHealable(row("Not sent: this is ACTIV's own WhatsApp number — save the person's own mobile number on their record")));
check('permanent wins over a healable word', !isHealable(row('550 user unknown after timeout')));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
