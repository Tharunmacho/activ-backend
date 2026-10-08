const assert = require('node:assert/strict');
const { displayPlanName } = require('../src/modules/members/membershipLabels');
const { render } = require('../src/modules/notifications/notificationTemplates');
for (const old of ['Platinum', 'Platinum Lifetime', 'platinum membership', 'Lifetime membership']) {
    assert.equal(displayPlanName(old), 'Lifetime Membership');
}
assert.equal(displayPlanName('Old custom name', 'platinum'), 'Lifetime Membership');
assert.equal(displayPlanName('Business', 'ideal'), 'Business');
const ctx = { name: 'Sample Member', planName: 'Platinum Lifetime', membershipNumber: 'ACTIV-SAMPLE', membershipType: 'lifetime', amountLabel: '₹2,00,000', memberPath: '/member/dashboard' };
for (const event of ['MEMBERSHIP_ACTIVATED', 'PAYMENT_REQUIRED', 'PLATINUM_REQUESTED', 'ADMIN_PLATINUM_REQUEST']) {
    const notice = render(event, ctx);
    assert(notice, event);
    // Meta's approved template identifiers remain API contracts; visible copy is renamed.
    const copy = JSON.stringify(notice, (key, value) => ['template', 'templateName', 'name'].includes(key) ? undefined : value);
    assert(!/platinum/i.test(copy), event + ' contains an old display name');
    assert(copy.includes('Lifetime'), event + ' has the new display name');
}
assert.equal(ctx.planName, 'Platinum Lifetime', 'Rendering does not rewrite historical data');
console.log('PASS: legacy plan names and membership notification display labels.');
