/**
 * Which plan an applicant is offered — business, aspirant, student — and the
 * Platinum tier that is granted, never sold.
 *
 * PURE UNIT, NO DB. `resolvePlans` is the rule `resolveForMember` applies
 * after it has read the plans; it is tested here on hand-made rows.
 *
 *   node tests/membership-plans.test.js
 */
const svc = require('../src/modules/members/membershipplan.service');
const frozen = require('../src/modules/payment/membershipPlans');

const { resolvePlans, kindOf, audienceOf, bandLabel } = svc;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
    if (ok) { passed++; console.log(`  ok    ${label}`); } else { failed++; console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`); }
};
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

const plan = (key, audience, price, minYears = 0, maxYears = null) => ({ key, audience, price, minYears, maxYears, active: true });
const PLANS = [
    plan('basic', 'business', 5000, 0, 5),
    plan('intermediate', 'business', 10000, 5, 10),
    plan('ideal', 'business', 20000, 10, null),
    plan('aspirant', 'aspirant', 2000),
    plan('student', 'student', 500),
    plan('platinum', 'platinum', 200000)
];
const OFF = { showAllPlans: false };
const thisYear = new Date().getFullYear();
const keys = (r) => (r.plans || []).map((p) => p.key).join(',');

section('the kind decides the plan');
{
    const r = resolvePlans(PLANS, OFF, { kind: 'student' });
    check('student -> the student plan alone', keys(r) === 'student' && r.matched && r.matched.key === 'student', keys(r));
    check('student reason is "student"', r.reason === 'student');
}
{
    const r = resolvePlans(PLANS, OFF, { kind: 'aspirant' });
    check('aspirant -> the aspirant plan alone', keys(r) === 'aspirant' && r.matched.key === 'aspirant', keys(r));
}
{
    const r = resolvePlans(PLANS, OFF, { kind: 'business', commencementYear: String(thisYear - 7) });
    check('business, 7 years -> the 5–10 band', keys(r) === 'intermediate' && r.reason === 'band', keys(r));
}
{
    const r = resolvePlans(PLANS, OFF, { kind: 'business', commencementYear: '' });
    check('business, no year -> every company plan, never platinum', keys(r) === 'basic,intermediate,ideal', keys(r));
}
{
    const r = resolvePlans(PLANS.filter((p) => p.key !== 'student'), OFF, { kind: 'student' });
    check('no student plan active -> falls back to aspirant', keys(r) === 'aspirant', keys(r));
}

section('platinum is granted, never offered');
{
    const r = resolvePlans(PLANS, { showAllPlans: true }, { kind: 'business' });
    check('show-all lists the sellable plans only', !keys(r).includes('platinum') && keys(r).includes('student'), keys(r));
}
check('the payment picker list leaves platinum out', !frozen.listPlans().some((p) => p.id === 'platinum'));
check('the frozen table prices the student plan at 500', frozen.getPlan('student') && frozen.getPlan('student').amount === 500);
check('the frozen platinum plan is a lifetime one at 2 lakh', frozen.PLANS.platinum.membershipType === 'lifetime'
    && frozen.PLANS.platinum.amount === 200000);

section('labels and inputs');
check('legacy isAspirant still resolves to aspirant', kindOf({ isAspirant: true }) === 'aspirant');
check('kind wins over isAspirant', kindOf({ kind: 'student', isAspirant: true }) === 'student');
check('an unknown audience reads as business', audienceOf('gold') === 'business');
check('bandLabel: student / aspirant / platinum', bandLabel({ audience: 'student' }) === 'Student'
    && bandLabel({ audience: 'aspirant' }) === 'Aspirant' && bandLabel({ audience: 'platinum' }) === 'Lifetime');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
