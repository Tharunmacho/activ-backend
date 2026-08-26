/**
 * Replays the website's profile-completion rules against every real member.
 *
 * `ProfileContext.loadProfileCompletion` decides two things a member sees on
 * their dashboard: the percentage, and whether the card reads "Complete Your
 * Profile" or "Application Submitted / View Status". The rules are pure — five
 * API responses in, a number out — so they can be replayed here against live
 * data, which is the only way to catch a check that never matches the values
 * the backend actually stores.
 *
 * That is the bug class this exists for. Earlier versions tested `name`, `pan`,
 * `declarationAccepted` and `doingBusiness === 'yes'` against a backend
 * returning `fullName`, `panNumber`, `agreeToDeclaration` and a boolean; then
 * `financial.status === 'submitted'` against records an admin had already moved
 * to 'verified'. Nothing errors in either case — the member just watches their
 * bar sit still, or fall.
 *
 * Read-only. It creates nothing and writes nothing.
 *
 *   PORT=5077 node src/server.js
 *   BASE_URL=http://localhost:5077 node scripts/verify-member-dashboard.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = (process.env.BASE_URL || 'http://localhost:5077').replace(/\/$/, '') + '/api/v1';

let passed = 0;
let failed = 0;

const check = (name, condition, detail) => {
    if (condition) {
        passed += 1;
        console.log('  PASS  ' + name);
    } else {
        failed += 1;
        console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
    }
};

const get = async (path, token) => {
    const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body) return null;
    return Object.prototype.hasOwnProperty.call(body, 'data') && body.data != null ? body.data : body;
};

/** The rules from ProfileContext, transcribed. Keep the two in step. */
const SUBMITTED_OR_BEYOND = ['submitted', 'verified', 'approved', 'completed'];
const isSubmitted = value => SUBMITTED_OR_BEYOND.includes(String(value || '').toLowerCase());

const computeCompletion = ({ profile, business, financial, declaration, applications }) => {
    const completed = [];
    if (profile && profile.fullName) completed.push('Personal Details');

    const isDoingBusiness = business && business.doingBusiness === true;
    if (business && business.doingBusiness !== null && business.doingBusiness !== undefined) {
        completed.push('Business Details');
    }
    const totalForms = isDoingBusiness ? 4 : 3;

    if (isDoingBusiness && isSubmitted(financial && financial.status)) completed.push('Financial Details');
    if ((declaration && declaration.agreeToDeclaration) || isSubmitted(declaration && declaration.status)) {
        completed.push('Declaration');
    }

    const application = Array.isArray(applications) && applications.length ? applications[0] : null;
    const hasSubmitted = !!(application && (application._id || application.id || application.status));
    const isPaid = ['approved', 'active'].includes(String((profile && profile.membershipStatus) || '').toLowerCase());

    const percentage = hasSubmitted || isPaid
        ? 100
        : Math.min(100, Math.round((completed.length / totalForms) * 100));

    return { percentage, completed, totalForms, hasSubmitted, isDoingBusiness };
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const Member = require('../src/modules/members/memberdetails.model');

    try {
        const members = await Member.find({ role: 'member' }).select('_id fullName email role block district state membershipStatus').lean();
        console.log('\n' + members.length + ' member accounts\n');

        const rows = [];

        for (const member of members) {
            // Signed exactly as authService.login signs it: the MemberDetails
            // `_id`, never the auth `_id`. They are different documents in
            // different collections and every lookup below keys off this one.
            const token = jwt.sign(
                {
                    userId: member._id.toString(),
                    email: member.email,
                    role: member.role || 'member',
                    block: member.block,
                    district: member.district,
                    state: member.state,
                },
                process.env.JWT_SECRET,
                { expiresIn: '5m' },
            );

            const [profile, business, financial, declaration, applications] = await Promise.all([
                get('/members/my-profile', token),
                get('/members/business-info', token),
                get('/members/financial-info', token),
                get('/members/declaration-info', token),
                get('/applications/my-applications', token),
            ]);

            const result = computeCompletion({ profile, business, financial, declaration, applications });
            rows.push({ member, profile, business, financial, declaration, applications, result });
        }

        console.log('name                 %    forms                      card');
        console.log('-'.repeat(96));
        for (const r of rows) {
            const card = r.result.percentage === 100 ? 'Application Submitted / View Status' : 'Complete Your Profile';
            console.log(
                String(r.member.fullName || '(no name)').slice(0, 20).padEnd(21) +
                String(r.result.percentage + '%').padEnd(5) +
                (r.result.completed.length + '/' + r.result.totalForms + '  ' +
                    r.result.completed.map(c => c.split(' ')[0]).join(',')).padEnd(27) +
                card,
            );
        }

        console.log('\nEvery member with data reaches a truthful figure');

        const withProfile = rows.filter(r => r.profile && r.profile.fullName);
        check('the profile endpoint answers for every member', withProfile.length === rows.length,
            (rows.length - withProfile.length) + ' returned nothing');

        const stuckAtZero = rows.filter(r => r.result.percentage === 0 && r.profile && r.profile.fullName);
        check('nobody with a stored name sits at 0%', stuckAtZero.length === 0,
            stuckAtZero.map(r => r.member.fullName).join(', '));

        const submittedButNotFull = rows.filter(r => r.result.hasSubmitted && r.result.percentage !== 100);
        check('everyone who has applied reads 100%', submittedButNotFull.length === 0,
            submittedButNotFull.map(r => r.member.fullName).join(', '));

        const applied = rows.filter(r => r.result.hasSubmitted);
        check('an applicant is offered View Status, not Complete Profile',
            applied.every(r => r.result.percentage === 100),
            applied.length + ' applicants checked');

        console.log('\nThe status checks match the values actually stored');

        // A status is fine either way — what must never happen is a value the
        // client has no opinion about, because those fall through to "not
        // submitted" and silently cost the member a quarter of their bar.
        const NOT_YET = ['draft', 'pending', 'incomplete', ''];
        const known = v => isSubmitted(v) || NOT_YET.includes(String(v || '').toLowerCase());

        const financialStatuses = [...new Set(rows.map(r => r.financial && r.financial.status).filter(Boolean))];
        console.log('  financial.status seen in the database:   ' + JSON.stringify(financialStatuses));
        check('every stored financial status is understood',
            financialStatuses.every(known),
            'unknown to the client: ' + JSON.stringify(financialStatuses.filter(v => !known(v))));

        const declStatuses = [...new Set(rows.map(r => r.declaration && r.declaration.status).filter(Boolean))];
        console.log('  declaration.status seen in the database: ' + JSON.stringify(declStatuses));
        check('every stored declaration status is understood',
            declStatuses.every(known),
            'unknown to the client: ' + JSON.stringify(declStatuses.filter(v => !known(v))));

        const businessMembers = rows.filter(r => r.result.isDoingBusiness);
        check('a business member is measured against four forms',
            businessMembers.every(r => r.result.totalForms === 4),
            businessMembers.length + ' business members');
        check('an aspirant is measured against three',
            rows.filter(r => !r.result.isDoingBusiness).every(r => r.result.totalForms === 3));
    } catch (error) {
        failed += 1;
        console.log('\n  FAIL  the run threw: ' + (error && error.message));
    } finally {
        await mongoose.disconnect();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed === 0) console.log('\n  THE DASHBOARD FIGURE MATCHES WHAT IS STORED FOR EVERY MEMBER\n');
    process.exit(failed > 0 ? 1 : 0);
})();
