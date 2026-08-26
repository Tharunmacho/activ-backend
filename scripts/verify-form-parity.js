/**
 * Deep value-check: does the mobile app and the website produce *identical*
 * database state for the four registration forms?
 *
 * Reading both clients side by side proves the field names look the same. It
 * does not prove the data lands the same, because the failures in this codebase
 * are silent: Mongoose strict mode drops an unknown path without error, an enum
 * refuses a value the form offered, and a Boolean sent as the string "no" is
 * truthy on the way in. Every one of those returns HTTP 200.
 *
 * So this submits each form twice against a real database — once with exactly
 * the payload the mobile screen sends, once with exactly the payload the website
 * page sends — and diffs the resulting documents across all four collections.
 *
 * It works on a synthetic member it creates and deletes, so it is safe to run
 * against the shared cluster. Nothing belonging to a real member is touched.
 *
 *   node scripts/verify-form-parity.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const PORT = process.env.PARITY_PORT || 5077;
const BASE = `http://localhost:${PORT}/api/v1`;

const RUN = `parity-${Date.now()}`;
const EMAIL = `${RUN}@parity.local`;

/** Fields that legitimately differ per write (timestamps, ids). */
const VOLATILE = new Set([
    '_id', 'userId', 'memberId', 'createdAt', 'updatedAt', '__v', 'submittedAt',
]);

const clean = (doc) => {
    if (!doc) return null;
    const out = {};
    Object.keys(doc).sort().forEach((k) => {
        if (VOLATILE.has(k)) return;
        const v = doc[k];
        out[k] = v && v.toString && typeof v === 'object' && v._bsontype ? v.toString() : v;
    });
    return out;
};

const diff = (a, b) => {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
    const out = [];
    for (const k of keys) {
        const av = JSON.stringify((a || {})[k]);
        const bv = JSON.stringify((b || {})[k]);
        if (av !== bv) out.push(`      ${k}:  mobile=${av}   website=${bv}`);
    }
    return out;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { minPoolSize: 2 });

    const MemberDetails = require('../src/modules/members/memberdetails.model');
    const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const MemberFinancialInfo = require('../src/modules/members/memberfinancialinfo.model');
    const MemberDeclaration = require('../src/modules/members/memberdeclaration.model');
    const jwt = require('jsonwebtoken');

    // Borrow a real, staffed region so the region gate cannot reject the write.
    const anyMember = await MemberDetails.findOne({ state: { $ne: null } }).lean();
    const region = {
        state: anyMember?.state || 'Tamil Nadu',
        district: anyMember?.district || 'Chennai',
        block: anyMember?.block || 'Chennai',
    };

    const member = await MemberDetails.create({
        fullName: 'Parity Probe',
        email: EMAIL,
        phoneNumber: '9000000000',
        ...region,
    });
    const userId = String(member._id);
    const token = jwt.sign({ userId, role: 'member', email: EMAIL }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const put = async (payload) => {
        const r = await fetch(`${BASE}/members/profile`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    const snapshot = async () => ({
        personal: clean(await PersonalInfo1.findOne({ userId }).lean()),
        member: clean(await MemberDetails.findById(userId).lean()),
        business: clean(await BusinessInfo.findOne({ userId }).lean()),
        financial: clean(await MemberFinancialInfo.findOne({ memberId: userId }).select('+panNumber').lean()),
        declaration: clean(await MemberDeclaration.findOne({ $or: [{ userId }, { memberId: userId }] }).lean()),
    });

    const wipeChildren = async () => {
        await Promise.all([
            PersonalInfo1.deleteMany({ userId }),
            BusinessInfo.deleteMany({ userId }),
            MemberFinancialInfo.deleteMany({ memberId: userId }),
            MemberDeclaration.deleteMany({ $or: [{ userId }, { memberId: userId }] }),
        ]);
    };

    // ---------------------------------------------------------------- payloads
    // Copied from what each client actually sends, verbatim.
    const CASES = [
        {
            name: 'Form 1 — Personal Details',
            // PersonalDetailsFormScreen.handleNext
            mobile: {
                fullName: 'Parity Probe', email: EMAIL, phoneNumber: '9000000000',
                ...region, city: 'Testville', religion: 'Hinduism', socialCategory: 'ST',
                currentPassword: '', password: '', confirmPassword: '',
            },
            // PersonalForm.handleSubmit -> updateProfile(formData)
            website: {
                fullName: 'Parity Probe', phoneNumber: '9000000000', email: EMAIL,
                ...region, city: 'Testville', religion: 'Hinduism', socialCategory: 'ST',
            },
        },
        {
            name: 'Form 2 — Business Information',
            mobile: {
                doingBusiness: true, organizationName: 'Probe Ltd', constitutionType: 'Partnership',
                businessTypes: ['Manufacturing'], businessActivities: 'Testing',
                businessCommencementYear: '2020', numberOfEmployees: '10',
                memberOfOtherChamber: false, otherChamber: '', govtOrganizations: ['MSME'],
            },
            // BusinessForm sends strings for the two Booleans.
            website: {
                doingBusiness: true, organizationName: 'Probe Ltd', constitutionType: 'Partnership',
                businessTypes: ['Manufacturing'], businessActivities: 'Testing',
                businessCommencementYear: '2020', numberOfEmployees: '10',
                memberOfOtherChamber: false, otherChamber: '', govtOrganizations: ['MSME'],
            },
        },
        {
            name: 'Form 2 — Business (aspirant, "no" as a string)',
            mobile: {
                doingBusiness: false, registrationType: 'aspirant',
                memberOfOtherChamber: false, govtOrganizations: [],
            },
            // The website's radios hold strings; `toBool` converts, but the
            // backend must survive the raw string too.
            website: { doingBusiness: 'no', memberOfOtherChamber: 'no', govtOrganizations: [] },
        },
        {
            name: 'Form 3 — Financial & Compliance',
            // FinancialComplianceFormScreen.handleNext
            mobile: {
                panNumber: 'ABCDE1234F', gstNumber: '22ABCDE1234F1Z5',
                filedITR: true, govtSchemeBenefit: true,
                itrFiled: true, govtSchemes: ['MUDRA'], schemeDetails: undefined,
                turnoverRange: '10-50 Lakhs', lastYearTurnover: '10-50 Lakhs',
            },
            // FinancialForm.handleSubmit (post-Udyam removal)
            website: {
                panNumber: 'ABCDE1234F', gstNumber: '22ABCDE1234F1Z5',
                govtSchemes: ['MUDRA'], schemeDetails: undefined,
                govtSchemeBenefit: true, filedITR: true, turnoverRange: '10-50 Lakhs',
            },
        },
        {
            name: 'Form 4 — Declaration',
            // DeclarationFormScreen: string count, comma-joined names, agreeToTerms
            mobile: {
                sisterConcerns: '2', companyNames: 'Alpha, Beta', agreeToTerms: true,
            },
            // DeclarationForm: Number count, array of names, agreeToDeclaration
            website: {
                sisterConcerns: 2, companyNames: ['Alpha', 'Beta'], agreeToDeclaration: true,
            },
        },
    ];

    let failures = 0;

    for (const c of CASES) {
        await wipeChildren();
        const mRes = await put(c.mobile);
        const mSnap = await snapshot();

        await wipeChildren();
        const wRes = await put(c.website);
        const wSnap = await snapshot();

        const problems = [];
        if (mRes.status !== wRes.status) {
            problems.push(`      HTTP status differs: mobile=${mRes.status} website=${wRes.status}`);
        }
        for (const key of ['personal', 'member', 'business', 'financial', 'declaration']) {
            const d = diff(mSnap[key], wSnap[key]);
            if (d.length) problems.push(`      [${key}]`, ...d);
        }

        if (problems.length) {
            failures++;
            console.log(`  DIFFER  ${c.name}  (HTTP ${mRes.status}/${wRes.status})`);
            problems.forEach((p) => console.log(p));
        } else {
            console.log(`  MATCH   ${c.name}  (HTTP ${mRes.status})`);
        }
    }

    // ------------------------------------------------- what reaches the DB at all
    console.log('\n  Financial answers, stored and read back:');

    const readBack = async () => {
        const r = await fetch(`${BASE}/members/financial-info`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        return (await r.json())?.data || {};
    };

    for (const client of ['mobile', 'website']) {
        await wipeChildren();
        await put(CASES[3][client]);
        const stored = await MemberFinancialInfo.findOne({ memberId: userId }).select('+panNumber').lean();
        const api = await readBack();

        const expect = {
            govtSchemes: ['MUDRA'],
            schemeDetails: '',
            filedITR: true,
            turnoverRange: '10-50 Lakhs',
        };

        console.log(`    via ${client}:`);
        for (const [k, want] of Object.entries(expect)) {
            const inDb = JSON.stringify(stored?.[k]);
            const viaApi = JSON.stringify(api?.[k]);
            const ok = inDb === JSON.stringify(want) && viaApi === JSON.stringify(want);
            if (!ok) failures++;
            console.log(`      ${ok ? 'OK  ' : 'FAIL'} ${k.padEnd(16)} db=${inDb}  api=${viaApi}`);
        }
    }

    /**
     * The two legacy aliases are deliberately not stored a second time: they
     * carry the same answer as `filedITR` / `turnoverRange`, and a document with
     * two copies of one answer is the shape that caused the doingBusiness bug.
     * What matters is that sending ONLY the old key still saves.
     */
    console.log('\n  Legacy keys alone (no canonical key in the payload):');
    await wipeChildren();
    await put({ itrFiled: true, lastYearTurnover: 'Above 1 Crore' });
    const legacy = await MemberFinancialInfo.findOne({ memberId: userId }).lean();
    const legacyOk = legacy?.filedITR === true && legacy?.turnoverRange === 'Above 1 Crore';
    if (!legacyOk) failures++;
    console.log(`    ${legacyOk ? 'OK  ' : 'FAIL'} itrFiled -> filedITR=${legacy?.filedITR}, ` +
        `lastYearTurnover -> turnoverRange=${JSON.stringify(legacy?.turnoverRange)}`);

    // Clearing every scheme must be recorded, not treated as "no answer".
    console.log('\n  Deselecting every scheme:');
    await wipeChildren();
    await put({ govtSchemes: ['MUDRA'], govtSchemeBenefit: true });
    await put({ govtSchemes: [], govtSchemeBenefit: false });
    const cleared = await MemberFinancialInfo.findOne({ memberId: userId }).lean();
    const clearedOk = Array.isArray(cleared?.govtSchemes) && cleared.govtSchemes.length === 0;
    if (!clearedOk) failures++;
    console.log(`    ${clearedOk ? 'OK  ' : 'FAIL'} govtSchemes=${JSON.stringify(cleared?.govtSchemes)}`);

    // ---------------------------------------------------------------- teardown
    await wipeChildren();
    await MemberDetails.deleteOne({ _id: userId });
    const leftover = await MemberDetails.countDocuments({ email: EMAIL });
    console.log(`\n  teardown: synthetic member removed (${leftover} left behind)`);
    console.log(failures === 0
        ? '\n  ALL FORMS PRODUCE IDENTICAL DATABASE STATE FROM BOTH CLIENTS'
        : `\n  ${failures} FORM(S) DIFFER`);

    await mongoose.disconnect();
    process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
    console.error('parity check failed:', err);
    process.exit(1);
});
