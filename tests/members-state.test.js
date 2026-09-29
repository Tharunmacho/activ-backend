/**
 * Members: Active / Expired / Awaiting payment, and the twice-monthly
 * "renew now" reminder. PURE — no DB, no network.
 *
 *   npm run test:members
 */
const {
    membershipState, halfMonthKey, halfMonthStart, monthlyReminderDue, renewalFor, renewalBase,
} = require('../src/modules/members/membershipState');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);
const d = (s) => new Date(s);
const NOW = d('2026-10-10T10:00:00');

section('membershipState');
{
    const paidFuture = { membershipStatus: 'active', membershipType: 'annual', membershipExpiresAt: d('2027-01-01') };
    check('paid, in date -> active', membershipState(paidFuture, { now: NOW }).state === 'active');
    check('paid, 20 days left -> expiring soon', membershipState({ ...paidFuture, membershipExpiresAt: d('2026-10-30') }, { now: NOW }).expiringSoon === true);
    check('paid, 60 days left -> not expiring soon', membershipState({ ...paidFuture, membershipExpiresAt: d('2026-12-09') }, { now: NOW }).expiringSoon === false);
    check('paid, period ended -> expired', membershipState({ ...paidFuture, membershipExpiresAt: d('2026-10-01') }, { now: NOW }).state === 'expired');
    check("status 'completed' counts as paid", membershipState({ ...paidFuture, membershipStatus: 'completed' }, { now: NOW }).state === 'active');
    check("stored 'expired' -> expired", membershipState({ membershipStatus: 'expired', membershipType: 'annual' }, { now: NOW }).state === 'expired');
    check('lifetime never expires', membershipState({ membershipStatus: 'active', membershipType: 'lifetime', membershipExpiresAt: d('2020-01-01') }, { now: NOW }).state === 'active');
    check('platinum never expires', membershipState({ membershipStatus: 'active', membershipType: 'annual', membershipTier: 'platinum', membershipExpiresAt: d('2020-01-01') }, { now: NOW }).state === 'active');
    check("stray 'expired' on a lifetime row reads active", membershipState({ membershipStatus: 'expired', membershipType: 'lifetime' }, { now: NOW }).state === 'active');
    const legacy = { membershipStatus: 'active', membershipType: 'annual', membershipActivatedAt: d('2025-09-01') };
    const ls = membershipState(legacy, { now: NOW });
    check('no stored expiry: activation + 1 year (lapsed)', ls.state === 'expired' && ls.expiresAt.toISOString().slice(0, 10) === '2026-09-01', ls.expiresAt && ls.expiresAt.toISOString());
    check('no stored expiry, recent activation: active', membershipState({ ...legacy, membershipActivatedAt: d('2026-06-01') }, { now: NOW }).state === 'active');
    check('approved application, not paid -> awaiting payment', membershipState({ membershipStatus: 'pending' }, { outcome: 'Approved', now: NOW }).state === 'awaiting_payment');
    check('pending application -> none', membershipState({ membershipStatus: 'pending' }, { outcome: 'Pending', now: NOW }).state === 'none');
    check('daysLeft counts whole days', membershipState({ ...paidFuture, membershipExpiresAt: d('2026-10-13T10:00:00') }, { now: NOW }).daysLeft === 3);
}

section('twice-monthly key');
{
    check('1st -> H1', halfMonthKey(d('2026-11-01T08:00:00')) === 'expired:2026-11-H1');
    check('14th -> H1', halfMonthKey(d('2026-11-14T23:00:00')) === 'expired:2026-11-H1');
    check('15th -> H2', halfMonthKey(d('2026-11-15T00:30:00')) === 'expired:2026-11-H2');
    check('31st -> H2', halfMonthKey(d('2026-12-31T12:00:00')) === 'expired:2026-12-H2');
    check('H2 starts on the 15th', halfMonthStart(d('2026-11-20')).getDate() === 15);
}

section('monthlyReminderDue');
{
    const expired = { membershipStatus: 'expired', membershipType: 'annual', membershipExpiresAt: d('2026-09-20') };
    check('lapsed last month -> due this half-month', monthlyReminderDue(expired, { now: NOW }) === 'expired:2026-10-H1');
    check('already sent this half-month -> not again', monthlyReminderDue(expired, { now: NOW, already: ['expired:2026-10-H1'] }) === null);
    check('next half-month -> due again', monthlyReminderDue(expired, { now: d('2026-10-16'), already: ['expired:2026-10-H1'] }) === 'expired:2026-10-H2');
    check('reminders switched off -> never', monthlyReminderDue({ ...expired, renewalReminderEnabled: false }, { now: NOW }) === null);
    check('lapsed inside this half-month -> waits for the next', monthlyReminderDue({ ...expired, membershipExpiresAt: d('2026-10-05') }, { now: NOW }) === null);
    check('...then the next half-month it is due', monthlyReminderDue({ ...expired, membershipExpiresAt: d('2026-10-05') }, { now: d('2026-10-15T09:00:00') }) === 'expired:2026-10-H2');
    check('active member -> never', monthlyReminderDue({ membershipStatus: 'active', membershipType: 'annual', membershipExpiresAt: d('2027-01-01') }, { now: NOW }) === null);
    check('platinum -> never', monthlyReminderDue({ membershipStatus: 'expired', membershipType: 'lifetime', membershipTier: 'platinum' }, { now: NOW }) === null);
    // Two per calendar month at most, whatever the sweep frequency.
    const keys = new Set();
    for (let day = 1; day <= 31; day++) {
        for (let h = 0; h < 24; h += 6) {
            const k = monthlyReminderDue(expired, { now: new Date(2026, 9, day, h), already: [...keys] });
            if (k) keys.add(k);
        }
    }
    check('a whole month of 6-hourly sweeps sends exactly two', keys.size === 2, [...keys].join(','));
}

section('renewal — who may renew, and from when');
{
    const annual = (exp, status = 'active') => ({ membershipStatus: status, membershipType: 'annual', membershipExpiresAt: d(exp) });
    check("stored 'expired' -> can renew", renewalFor(annual('2026-09-01', 'expired'), { now: NOW }).canRenew === true);
    check("'active' past its end (sweep not run yet) -> can renew", renewalFor(annual('2026-10-01'), { now: NOW }).canRenew === true);
    check('active, 20 days left -> can renew early', renewalFor(annual('2026-10-30'), { now: NOW }).canRenew === true);
    const far = renewalFor(annual('2027-06-10'), { now: NOW });
    check('active, months left -> not yet', far.canRenew === false);
    check('...and says when it opens (30 days before the end)', far.opensAt && far.opensAt.toISOString().slice(0, 10) === '2027-05-11', far.opensAt && far.opensAt.toISOString());
    check('lifetime -> never', renewalFor({ membershipStatus: 'active', membershipType: 'lifetime' }, { now: NOW }).canRenew === false);
    check('platinum -> never', renewalFor({ membershipStatus: 'active', membershipType: 'annual', membershipTier: 'platinum', membershipExpiresAt: d('2020-01-01') }, { now: NOW }).canRenew === false);
    check('never paid -> never', renewalFor({ membershipStatus: 'pending' }, { now: NOW }).canRenew === false);
    check('early renewal continues from the current end date', renewalBase(annual('2026-10-30'), { now: NOW }).toISOString() === d('2026-10-30').toISOString());
    check('late renewal starts from today', renewalBase(annual('2026-09-01', 'expired'), { now: NOW }).toISOString() === NOW.toISOString());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
