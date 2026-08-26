/**
 * Does the profile-completion percentage actually climb as the four forms are
 * filled in?
 *
 * The figure is computed in `website/src/contexts/ProfileContext.tsx` from the
 * four form endpoints. It has failed twice in ways that looked like "the bar is
 * stuck":
 *
 *   - The field tests were wrong (`name`, `pan`, `declarationAccepted`,
 *     `doingBusiness === 'yes'`) where the backend returns `fullName`,
 *     `panNumber`, `agreeToDeclaration` and a Boolean. Nothing errored; the
 *     checks simply never matched.
 *   - Then the financial test read `panNumber`, which is an OPTIONAL field on
 *     both financial forms — so a member who completed that step without a PAN
 *     was capped at 75% with nothing left to fill in.
 *
 * This walks a synthetic member through all four steps and asserts the
 * percentage after each one, using the same rule the context applies, against
 * the same endpoints it calls.
 *
 *   PORT=5077 node src/server.js
 *   node scripts/verify-profile-completion.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PORT = process.env.PARITY_PORT || 5077;
const BASE = `http://localhost:${PORT}/api/v1`;
const RUN = String(Date.now()).slice(-8);

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { minPoolSize: 2 });

    const MemberDetails = require('../src/modules/members/memberdetails.model');
    const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const MemberFinancialInfo = require('../src/modules/members/memberfinancialinfo.model');
    const MemberDeclaration = require('../src/modules/members/memberdeclaration.model');

    const seed = await MemberDetails.findOne({ state: { $ne: null } }).lean();
    const region = {
        state: seed?.state || 'Tamil Nadu',
        district: seed?.district || 'Ariyalur',
        block: seed?.block || 'Ariyalur',
    };

    const probe = await MemberDetails.create({
        fullName: 'Completion Probe',
        email: `completion-${RUN}@parity.local`,
        phoneNumber: '9000000007',
        ...region,
    });
    const userId = String(probe._id);
    const token = jwt.sign({ userId, role: 'member', email: probe.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const auth = { Authorization: `Bearer ${token}` };

    const put = (body) => fetch(`${BASE}/members/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

    const get = (path) => fetch(`${BASE}${path}`, { headers: auth })
        .then(async (r) => (await r.json().catch(() => null))?.data || {});

    /** The exact rule `ProfileContext.loadProfileCompletion` applies. */
    const percentage = async () => {
        const [profile, business, financial, declaration] = await Promise.all([
            get('/members/my-profile'),
            get('/members/business-info'),
            get('/members/financial-info'),
            get('/members/declaration-info'),
        ]);

        const completed = [];
        if (profile?.fullName) completed.push('Personal');

        const isDoingBusiness = business?.doingBusiness === true;
        if (business && business.doingBusiness !== null && business.doingBusiness !== undefined) {
            completed.push('Business');
        }
        const total = isDoingBusiness ? 4 : 3;

        if (isDoingBusiness && financial?.status === 'submitted') completed.push('Financial');
        if (declaration?.agreeToDeclaration) completed.push('Declaration');

        return {
            pct: Math.min(100, Math.round((completed.length / total) * 100)),
            completed, total,
        };
    };

    const STEPS = [
        {
            label: 'after Personal only',
            // A fresh member already has fullName from registration, so this is
            // the starting state; nothing is sent.
            payload: null,
            expect: 33,
        },
        {
            label: 'after Business',
            payload: { doingBusiness: true, businessTypes: ['Manufacturing'], constitutionType: 'Private Limited' },
            expect: 50,
        },
        {
            label: 'after Financial (NO pan — the case that used to stick)',
            payload: { gstNumber: '22ABCDE1234F1Z5', turnoverRange: '10-50 Lakhs', filedITR: true, govtSchemes: ['MUDRA'], govtSchemeBenefit: true },
            expect: 75,
        },
        {
            label: 'after Declaration',
            payload: { sisterConcerns: 0, companyNames: [], agreeToDeclaration: true },
            expect: 100,
        },
    ];

    let failures = 0;
    for (const step of STEPS) {
        if (step.payload) {
            const res = await put(step.payload);
            if (res.status !== 200) {
                failures++;
                console.log(`  FAIL  ${step.label} — save returned HTTP ${res.status}: ${res.body?.message}`);
                continue;
            }
        }
        const { pct, completed, total } = await percentage();
        const ok = pct === step.expect;
        if (!ok) failures++;
        console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${String(step.label).padEnd(48)} ${String(pct).padStart(3)}%  ` +
            `(expected ${step.expect}%)  [${completed.join(', ')}] of ${total}`);
    }

    // ---------------------------------------------------------------- teardown
    await Promise.all([
        PersonalInfo1.deleteMany({ userId }),
        BusinessInfo.deleteMany({ userId }),
        MemberFinancialInfo.deleteMany({ memberId: userId }),
        MemberDeclaration.deleteMany({ $or: [{ userId }, { memberId: userId }] }),
    ]);
    await MemberDetails.deleteOne({ _id: userId });

    console.log(`\n  teardown: probe removed (${await MemberDetails.countDocuments({ email: probe.email })} left behind)`);
    console.log(failures === 0
        ? '\n  PROFILE COMPLETION CLIMBS CORRECTLY THROUGH ALL FOUR FORMS\n'
        : `\n  ${failures} STEP(S) WRONG\n`);

    await mongoose.disconnect();
    process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
    console.error('completion check failed:', err);
    process.exit(1);
});
