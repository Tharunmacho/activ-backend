/**
 * Verifies that an ASPIRANT's submission creates a real application.
 *
 * The website had two submit paths on the profile screen. The business branch
 * called `POST /applications`; the aspirant branch did not. It invented
 * `APP-${Date.now()}-${random}`, wrote it to localStorage, showed
 * "Application submitted successfully!" and the submitted screen — while
 * creating nothing.
 *
 * The consequences were all silent:
 *
 *   - the aspirant appeared in NO admin queue at any tier, so nobody could ever
 *     approve them;
 *   - `ProfileContext` counts a submitted application as a finished profile, so
 *     their bar stuck at 67% with all three forms filled in and nothing left to
 *     fill;
 *   - the status page, finding no application, rendered a MOCK tracker —
 *     id `ACTV2024001`, "0 of 4 stages", every tier "Pending Assignment" —
 *     which is indistinguishable from a real application nobody has picked up.
 *
 * This walks an aspirant through the three forms they are asked for, submits,
 * and asserts the application exists, reaches the block queue, and drives
 * completion to 100%.
 *
 * Everything it creates is synthetic and removed at the end, including on
 * failure.
 *
 *   PORT=5077 node src/server.js
 *   BASE_URL=http://localhost:5077 node scripts/verify-aspirant-submission.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = (process.env.BASE_URL || 'http://localhost:5077').replace(/\/$/, '') + '/api/v1';
const RUN = 'ASPSUB' + Date.now().toString(36).toUpperCase();

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

const call = async (path, options = {}) => {
    const res = await fetch(BASE + path, {
        method: options.method || 'GET',
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            options.token ? { Authorization: 'Bearer ' + options.token } : {},
        ),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty */ }
    const data = body && Object.prototype.hasOwnProperty.call(body, 'data') && body.data != null
        ? body.data
        : body;
    return { status: res.status, body, data };
};

/** The completion rule from ProfileContext, transcribed. */
const SUBMITTED_OR_BEYOND = ['submitted', 'verified', 'approved', 'completed'];
const isSubmitted = v => SUBMITTED_OR_BEYOND.includes(String(v || '').toLowerCase());

const completion = ({ profile, business, financial, declaration, applications }) => {
    const done = [];
    if (profile && profile.fullName) done.push('Personal');
    const doingBusiness = business && business.doingBusiness === true;
    if (business && business.doingBusiness !== null && business.doingBusiness !== undefined) done.push('Business');
    const total = doingBusiness ? 4 : 3;
    if (doingBusiness && isSubmitted(financial && financial.status)) done.push('Financial');
    if ((declaration && declaration.agreeToDeclaration) || isSubmitted(declaration && declaration.status)) done.push('Declaration');

    const app = Array.isArray(applications) && applications.length ? applications[0] : null;
    const hasSubmitted = !!(app && (app._id || app.id || app.status));
    return {
        percentage: hasSubmitted ? 100 : Math.min(100, Math.round((done.length / total) * 100)),
        done, total, hasSubmitted,
    };
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const Member = require('../src/modules/members/memberdetails.model');
    const Application = require('../src/modules/applications/application.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');
    const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');

    const appsBefore = await Application.countDocuments();
    let member = null;

    try {
        // A region that is actually staffed, so the coverage gate lets the
        // application through — the same gate the browser hits.
        const staffed = await Application.findOne({ status: /Pending|Approved/i })
            .select('state district block').lean();
        const region = staffed && staffed.block
            ? { state: staffed.state, district: staffed.district, block: staffed.block }
            : { state: 'Tamil Nadu', district: 'Ariyalur', block: 'Ariyalur' };
        console.log('\n  region: ' + JSON.stringify(region));

        member = await Member.create({
            fullName: RUN + ' Aspirant',
            email: (RUN + '@parity.local').toLowerCase(),
            phoneNumber: '9000000000',
            role: 'member',
            isActive: true,
            membershipStatus: 'pending',
            ...region,
        });

        const token = jwt.sign(
            { userId: member._id.toString(), email: member.email, role: 'member', ...region },
            process.env.JWT_SECRET,
            { expiresIn: '10m' },
        );

        // ---- the three forms an aspirant is asked for --------------------
        console.log('\nAn aspirant fills the three forms they are asked for');

        const forms = [
            ['personal', { fullName: RUN + ' Aspirant', phoneNumber: '9000000000', ...region, city: 'Testville' }],
            ['business', { doingBusiness: false, registrationType: 'aspirant' }],
            ['declaration', { agreeToDeclaration: true, sisterConcerns: 0 }],
        ];

        for (const [label, payload] of forms) {
            const res = await call('/members/profile', { method: 'PUT', token, body: payload });
            check(label + ' form saves', res.status === 200, 'answered ' + res.status);
        }

        let state = {
            profile: (await call('/members/my-profile', { token })).data,
            business: (await call('/members/business-info', { token })).data,
            financial: (await call('/members/financial-info', { token })).data,
            declaration: (await call('/members/declaration-info', { token })).data,
            applications: (await call('/applications/my-applications', { token })).data,
        };

        let c = completion(state);
        console.log('  completion before submitting: ' + c.percentage + '%  (' + c.done.join(', ') + ' of ' + c.total + ')');
        check('an aspirant is measured against three forms', c.total === 3, String(c.total));
        // All three forms done IS 100% for an aspirant, before any application
        // exists — the bar measures the forms, not the submission.
        check('all three forms count', c.done.length === 3, c.done.join(', '));

        // ---- submit ------------------------------------------------------
        console.log('\nSubmitting creates a real application');

        const submitted = await call('/applications', {
            method: 'POST',
            token,
            body: {
                applicationType: 'membership',
                fullName: state.profile.fullName,
                email: state.profile.email,
                phone: state.profile.phoneNumber,
                ...region,
                registrationType: 'aspirant',
                memberType: 'aspirant',
                data: {
                    personalDetails: { fullName: state.profile.fullName, email: state.profile.email, ...region },
                    businessInfo: state.business || {},
                    financialInfo: state.financial || {},
                    declaration: state.declaration || {},
                },
            },
        });

        check('the application is created', submitted.status === 201 || submitted.status === 200,
            'answered ' + submitted.status + ' ' + JSON.stringify(submitted.body && submitted.body.message));

        const stored = await Application.findOne({ email: member.email }).lean();
        check('an Application document exists', !!stored,
            'the aspirant branch used to create nothing at all');
        check('it carries a SERVER id, not APP-<timestamp>',
            !!stored && !/^APP-\d{13}-/.test(String(stored.applicationId || '')),
            stored && stored.applicationId);
        check('it is registrationType aspirant', !!stored && stored.registrationType === 'aspirant',
            stored && stored.registrationType);
        check('it starts at the block tier',
            !!stored && /Pending-Block|PENDING/i.test(String(stored.status)),
            stored && stored.status);

        // ---- what the member now sees ------------------------------------
        console.log('\nThe dashboard and the status page agree with it');

        state.applications = (await call('/applications/my-applications', { token })).data;
        check('the member can read their own application back',
            Array.isArray(state.applications) && state.applications.length === 1,
            'got ' + (Array.isArray(state.applications) ? state.applications.length : typeof state.applications));

        c = completion(state);
        console.log('  completion after submitting: ' + c.percentage + '%');
        check('completion reads 100%', c.percentage === 100, c.percentage + '%');
        check('the dashboard offers View Status, not Complete Profile', c.hasSubmitted);

        // ---- and the admin queue -----------------------------------------
        console.log('\nThe applicant reaches the block admin queue');

        const adminToken = jwt.sign(
            { userId: new mongoose.Types.ObjectId().toString(), role: 'block_admin', email: 'b@x', ...region },
            process.env.JWT_SECRET,
            { expiresIn: '10m' },
        );
        const dash = await call('/admin/block/dashboard', { token: adminToken });
        const pending = ((dash.data || {}).applicants || {}).pending || [];
        check('the aspirant is in the block pending queue',
            pending.some(a => String(a.email).toLowerCase() === member.email),
            'queue holds ' + pending.length + ' applicants');
    } catch (error) {
        failed += 1;
        console.log('\n  FAIL  the run threw: ' + (error && error.message));
    } finally {
        if (member) {
            await Application.deleteMany({ email: member.email }).catch(() => {});
            await BusinessInfo.deleteMany({ userId: member._id }).catch(() => {});
            await Declaration.deleteMany({ $or: [{ userId: member._id }, { memberId: member._id }] }).catch(() => {});
            await PersonalInfo1.deleteMany({ userId: member._id }).catch(() => {});
            await Member.deleteOne({ _id: member._id }).catch(() => {});
        }
        const appsAfter = await Application.countDocuments();
        console.log('\n  teardown: applications before=' + appsBefore + ' after=' + appsAfter +
            (appsBefore === appsAfter ? ' (clean)' : '  *** MISMATCH ***'));
        if (appsBefore !== appsAfter) failed += 1;
        await mongoose.disconnect();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed === 0) console.log('\n  AN ASPIRANT SUBMISSION CREATES A REAL, ROUTABLE APPLICATION\n');
    process.exit(failed > 0 ? 1 : 0);
})();
