/**
 * The four registration forms and the payment surface, round-tripped.
 *
 * Every check here exists because a 200 response is not evidence. Both clients
 * write the four onboarding forms through one endpoint — `PUT /members/profile`
 * — and two mechanisms discard data on that path without raising anything a
 * client can see:
 *
 *   Mongoose strict mode drops a path the schema does not declare.
 *   Mongoose casting turns an unexpected type into a plausible-looking value —
 *   a Number field handed prose stores the default `0`.
 *
 * Either way the request succeeds, the form says "saved", and the value is
 * gone. So each section here WRITES a known value and READS IT BACK, and the
 * assertion is on the value, never on the status code.
 *
 * Two kinds of check:
 *
 *   UNIT   — the schema enums and types, loaded from the models. No server, no
 *            database. These are the ones that catch a client offering a
 *            dropdown option the schema will reject.
 *
 *   LIVE   — the API against a running backend. Skipped with a notice when
 *            nothing is listening, rather than failing for that reason.
 *
 * The live half creates one probe member, exercises it, and deletes it and all
 * four of its documents in a `finally`. It touches no existing record.
 *
 *   npm run test:forms
 *   BASE_URL=http://localhost:5055 npm run test:forms
 */

require('dotenv').config();

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5000').replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;
const PROBE_EMAIL = 'formprobe.test@activ.invalid';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const check = (label, ok, detail = '') => {
    if (ok) {
        passed++;
        console.log(`  ok    ${label}${detail ? '  — ' + detail : ''}`);
    } else {
        failed++;
        failures.push(`${label}${detail ? '  — ' + detail : ''}`);
        console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
    }
    return ok;
};

const skip = (label, why) => {
    skipped++;
    console.log(`  skip  ${label}  — ${why}`);
};

const section = (name) => console.log(`\n${name}\n${'-'.repeat(name.length)}`);

const call = async(method, path, body, token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch(API + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let payload = {};
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
        return {
            status: res.status,
            data: payload.data !== undefined ? payload.data : payload,
            message: payload.message,
        };
    } catch (err) {
        return { status: 0, data: null, message: err.message };
    }
};

// ==================================================== unit: the client contract
//
// A dropdown option that is not in the schema's enum is not a cosmetic
// mismatch: the save throws a ValidationError, and because all six financial
// fields share one document, PAN, GST, Udyam and the ITR flag are lost with it.
//
// These lists are the ones the mobile app ships. The website is held to the
// same ones, and both are held to the schema.

const testSchemaContract = () => {
    section('Schema contract (unit)');

    const Financial = require('../src/modules/members/memberfinancialinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');
    const Business = require('../src/modules/members/businessinfo.model');
    const Personal = require('../src/modules/members/personalinfo1.model');

    const CLIENT_TURNOVER_RANGES = [
        'Below 1 Lakh',
        '1-5 Lakhs',
        '5-10 Lakhs',
        '10-50 Lakhs',
        '50 Lakhs - 1 Crore',
        'Above 1 Crore',
    ];

    const enumOf = (model, path) => model.schema.path(path)?.enumValues || [];

    const turnover = enumOf(Financial, 'turnoverRange');
    check('turnoverRange declares an enum', turnover.length > 0, `${turnover.length} value(s)`);

    // Spelling to the space. The schema says "50 Lakhs - 1 Crore"; a client
    // sending "50 Lakhs-1 Crore" is sending a different string.
    for (const range of CLIENT_TURNOVER_RANGES) {
        check(`  the clients' "${range}" is accepted`, turnover.includes(range));
    }
    const orphans = turnover.filter((r) => !CLIENT_TURNOVER_RANGES.includes(r));
    check('  no schema range is unreachable from the clients', orphans.length === 0,
        orphans.join(', ') || 'none');

    const social = enumOf(Personal, 'socialCategory');
    for (const value of ['Christian ST', 'Christian SC', 'ST', 'SC', 'Others', '']) {
        check(`socialCategory accepts ${value === '' ? '(empty)' : `"${value}"`}`, social.includes(value));
    }

    // Types the clients must respect. A count sent as prose casts to the
    // default; a Boolean sent as "no" is truthy in any JavaScript that tests it
    // before Mongoose casts it.
    check('sisterConcerns is a Number, not a flag',
        Declaration.schema.path('sisterConcerns')?.instance === 'Number',
        Declaration.schema.path('sisterConcerns')?.instance);
    for (const [model, path, name] of [
        [Business, 'doingBusiness', 'BusinessInfo'],
        [Business, 'memberOfOtherChamber', 'BusinessInfo'],
        [Financial, 'filedITR', 'MemberFinancialInfo'],
        [Financial, 'govtSchemeBenefit', 'MemberFinancialInfo'],
    ]) {
        check(`${name}.${path} is a Boolean`,
            model.schema.path(path)?.instance === 'Boolean',
            model.schema.path(path)?.instance);
    }

    // `panNumber` is `select: false`, so any query meaning to return it must ask
    // for it by name. Two do.
    const panHidden = Financial.schema.path('panNumber')?.options?.select === false;
    check('panNumber is select:false (so reads must opt in)', panHidden);
    if (panHidden) {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../src/modules/members/member.controller.js'), 'utf8');
        const selects = (src.match(/\.select\('\+panNumber'\)/g) || []).length;
        const queries = (src.match(/MemberFinancialInfo\.findOne\(/g) || []).length;
        check('  every financial query opts back into panNumber', selects === queries,
            `${selects} select(s) for ${queries} quer(ies)`);
    }
};

// ==================================================== unit: boolean coercion
//
// The controller derives `registrationType` from `doingBusiness`. Before this
// was normalised, a client sending the string "no" produced a record that
// disagreed with itself: Mongoose cast the value to `false` while the ternary
// wrote `'business'`.

const testBooleanNormalisation = () => {
    section('Boolean normalisation (unit)');

    const src = require('fs').readFileSync(
        require('path').join(__dirname, '../src/modules/members/member.controller.js'), 'utf8');

    check('registrationType is not derived from the raw request value',
        !src.includes("profileData.doingBusiness ? 'business' : 'aspirant'"),
        'a truthy "no" would label an aspirant a business');
    check('the controller normalises before deriving',
        src.includes("registrationType: doesBusiness ? 'business' : 'aspirant'"));
    check('an unanswered radio cannot reach a Boolean path',
        src.includes("delete profileData.filedITR") &&
        src.includes("delete profileData.govtSchemeBenefit"),
        "'' has no Boolean cast and 500s the whole save");
    check("an empty turnoverRange is dropped rather than sent to the enum",
        src.includes("if (profileData.turnoverRange === '') delete profileData.turnoverRange;"));
};

// ==================================================== live
//
// One throwaway member, written and read back through the real API.

const testLive = async() => {
    section(`Live round trip (${BASE_URL})`);

    const health = await call('GET', '/cms/site');
    if (health.status === 0) {
        skip('the whole live section', `nothing is listening on ${BASE_URL}`);
        return;
    }

    const mongoose = require('mongoose');
    const jwt = require('jsonwebtoken');

    let probeId = null;
    let token = '';

    try {
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(process.env.MONGODB_URI);
        }

        const MemberDetails = require('../src/modules/members/memberdetails.model');
        const MemberAuth = require('../src/modules/auth/auth.model');

        // A region is required on the model; these values are never routed
        // anywhere because the probe submits no application.
        const auth = await MemberAuth.create({
            email: PROBE_EMAIL, password: 'x'.repeat(20),
            phoneNumber: '9000000099', fullName: 'Form Probe',
        });
        const member = await MemberDetails.create({
            userId: auth._id, email: PROBE_EMAIL, fullName: 'Form Probe',
            phoneNumber: '9000000099',
            state: 'Probe State', district: 'Probe District', block: 'Probe Block',
        });
        probeId = member._id;

        token = jwt.sign(
            { userId: String(member._id), email: PROBE_EMAIL, role: 'member' },
            process.env.JWT_SECRET, { expiresIn: '10m' });

        // ---------------------------------------------------------- personal
        let res = await call('PUT', '/members/profile', {
            fullName: 'Form Probe', phoneNumber: '9000000099',
            state: 'Probe State', district: 'Probe District', block: 'Probe Block',
            city: 'ProbeCity', religion: 'Hindu', socialCategory: 'Others',
        }, token);
        check('personal details save', res.status === 200, `HTTP ${res.status} ${res.message || ''}`);

        let read = await call('GET', '/members/my-profile', undefined, token);
        for (const [key, want] of [['city', 'ProbeCity'], ['religion', 'Hindu'],
            ['socialCategory', 'Others'], ['fullName', 'Form Probe']]) {
            check(`  ${key} persisted`, (read.data || {})[key] === want,
                JSON.stringify((read.data || {})[key]));
        }

        // ---------------------------------------------------------- business
        res = await call('PUT', '/members/profile', {
            doingBusiness: true,
            organizationName: 'Probe Traders',
            constitutionType: 'Proprietorship',
            businessTypes: ['Manufacturing'],
            businessActivities: 'Probe activity',
            businessCommencementYear: '2019',
            numberOfEmployees: '10-50',
            memberOfOtherChamber: false,
            govtOrganizations: ['MSME'],
        }, token);
        check('business details save', res.status === 200, `HTTP ${res.status} ${res.message || ''}`);

        read = await call('GET', '/members/business-info', undefined, token);
        let biz = read.data || {};
        check('  organizationName persisted', biz.organizationName === 'Probe Traders', biz.organizationName);
        check('  businessTypes array persisted',
            Array.isArray(biz.businessTypes) && biz.businessTypes[0] === 'Manufacturing',
            JSON.stringify(biz.businessTypes));
        check('  govtOrganizations array persisted',
            Array.isArray(biz.govtOrganizations) && biz.govtOrganizations[0] === 'MSME',
            JSON.stringify(biz.govtOrganizations));
        check('  registrationType is business', biz.registrationType === 'business', biz.registrationType);

        // The record must not contradict itself, whichever spelling arrives.
        // "no" is a truthy string: a client sending it once produced
        // `doingBusiness: false` alongside `registrationType: 'business'`.
        for (const value of [false, 'no']) {
            await call('PUT', '/members/profile', { doingBusiness: value }, token);
            read = await call('GET', '/members/business-info', undefined, token);
            biz = read.data || {};
            check(`  ${JSON.stringify(value)} yields a consistent aspirant record`,
                biz.doingBusiness === false && biz.registrationType === 'aspirant',
                `doingBusiness=${biz.doingBusiness} registrationType=${biz.registrationType}`);
        }

        res = await call('PUT', '/members/profile', { doingBusiness: '' }, token);
        check('  an unanswered doingBusiness does not 500', res.status === 200, `HTTP ${res.status}`);

        // --------------------------------------------------------- financial
        await call('PUT', '/members/profile', { doingBusiness: true }, token);
        res = await call('PUT', '/members/profile', {
            panNumber: 'ABCDE1234F',
            gstNumber: '33ABCDE1234F1Z5',
            udyamNumber: 'UDYAM-TN-01-0000001',
            filedITR: true,
            turnoverRange: '50 Lakhs - 1 Crore',
            govtSchemeBenefit: false,
        }, token);
        check('financial details save', res.status === 200, `HTTP ${res.status} ${res.message || ''}`);

        read = await call('GET', '/members/financial-info', undefined, token);
        const fin = read.data || {};
        for (const [key, want] of [['gstNumber', '33ABCDE1234F1Z5'],
            ['udyamNumber', 'UDYAM-TN-01-0000001'],
            ['turnoverRange', '50 Lakhs - 1 Crore']]) {
            check(`  ${key} persisted`, fin[key] === want, fin[key]);
        }
        // `select: false` made this undefined on every read for a long time.
        check('  panNumber is returned despite select:false',
            fin.panNumber === 'ABCDE1234F', fin.panNumber);
        check('  filedITR stored as a Boolean', fin.filedITR === true, String(fin.filedITR));
        check('  govtSchemeBenefit stored as a Boolean', fin.govtSchemeBenefit === false,
            String(fin.govtSchemeBenefit));

        // The write path falls back to the stored PAN when the form omits it.
        // Without `+panNumber` on that query the fallback was undefined, and
        // saving the form a second time erased the PAN.
        await call('PUT', '/members/profile', { gstNumber: '33ABCDE1234F1Z5' }, token);
        read = await call('GET', '/members/financial-info', undefined, token);
        check('  panNumber survives a save that omits it',
            (read.data || {}).panNumber === 'ABCDE1234F', (read.data || {}).panNumber);

        // Every range the clients offer must actually store.
        for (const range of ['Below 1 Lakh', '1-5 Lakhs', '5-10 Lakhs',
            '10-50 Lakhs', '50 Lakhs - 1 Crore', 'Above 1 Crore']) {
            const r = await call('PUT', '/members/profile', { turnoverRange: range }, token);
            const back = await call('GET', '/members/financial-info', undefined, token);
            check(`  turnover "${range}" round-trips`,
                r.status === 200 && (back.data || {}).turnoverRange === range,
                `HTTP ${r.status} -> ${(back.data || {}).turnoverRange}`);
        }

        // ------------------------------------------------------- declaration
        res = await call('PUT', '/members/profile', {
            sisterConcerns: 3,
            companyNames: 'Probe Traders, Probe Sister Co',
            agreeToDeclaration: true,
        }, token);
        check('declaration saves', res.status === 200, `HTTP ${res.status} ${res.message || ''}`);

        read = await call('GET', '/members/declaration-info', undefined, token);
        const dec = read.data || {};
        check('  sisterConcerns persisted as the count', dec.sisterConcerns === 3,
            String(dec.sisterConcerns));
        check('  companyNames persisted',
            JSON.stringify(dec.companyNames || '').includes('Probe Sister Co'),
            JSON.stringify(dec.companyNames));
        check('  agreeToDeclaration persisted', dec.agreeToDeclaration === true,
            String(dec.agreeToDeclaration));

        // The mobile app spells the consent flag `agreeToTerms`. Both clients
        // share this controller, so both spellings must land on one field.
        await call('PUT', '/members/profile', { agreeToDeclaration: false }, token);
        await call('PUT', '/members/profile', { agreeToTerms: true }, token);
        read = await call('GET', '/members/declaration-info', undefined, token);
        check("  mobile's agreeToTerms lands on agreeToDeclaration",
            (read.data || {}).agreeToDeclaration === true,
            String((read.data || {}).agreeToDeclaration));

        // ----------------------------------------------------------- payment
        read = await call('GET', '/membership/plans', undefined, token);
        check('membership plans are served', read.status === 200, `HTTP ${read.status}`);
        const plans = (read.data || {}).plans || [];
        check('  at least one plan is offered', plans.length > 0, `${plans.length} plan(s)`);
        check('  each plan carries a name and an amount',
            plans.every((p) => p && p.name && p.amount !== undefined),
            plans.map((p) => p.name).join(', '));

        // NOT a working purchase, and recorded as such. `/payment/complete`
        // activates a membership from an empty body — there is no gateway
        // behind it and both clients mint their own transaction ids. This pins
        // the current behaviour so that changing it is a deliberate act.
        res = await call('POST', '/payment/complete', {}, token);
        check('  /payment/complete activates without payment proof (MOCK GATEWAY)',
            res.status === 200, `HTTP ${res.status} — no verification step exists`);

        // Its amount table (500/1000/2000/2500, keyed by starter/intermediate/
        // advanced/lifetime/aspirant) matches neither the seeded plans nor their
        // memberType values, and no screen in either client calls it.
        res = await call('POST', '/payment/create-request',
            { amount: 1000, membershipType: 'company', purpose: 'membership' }, token);
        check('  /payment/create-request rejects the seeded plan shape',
            res.status === 400, `HTTP ${res.status} — ${res.message || ''}`);

        // ------------------------------------------------------------ guards
        res = await call('PUT', '/members/profile', { fullName: 'x' });
        check('an unauthenticated save is refused', res.status === 401, `HTTP ${res.status}`);
    } catch (err) {
        check('the live section ran', false, err.message);
    } finally {
        // Nothing survives this run.
        try {
            const mongoose = require('mongoose');
            if (mongoose.connection.readyState === 1) {
                const MemberDetails = require('../src/modules/members/memberdetails.model');
                const MemberAuth = require('../src/modules/auth/auth.model');
                const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
                const BusinessInfo = require('../src/modules/members/businessinfo.model');
                const Financial = require('../src/modules/members/memberfinancialinfo.model');
                const Declaration = require('../src/modules/members/memberdeclaration.model');

                if (probeId) {
                    await PersonalInfo1.deleteMany({ userId: probeId });
                    await BusinessInfo.deleteMany({ userId: probeId });
                    await Financial.deleteMany({ memberId: probeId });
                    await Declaration.deleteMany({ $or: [{ userId: probeId }, { memberId: probeId }] });
                }
                await MemberDetails.deleteMany({ email: PROBE_EMAIL });
                await MemberAuth.deleteMany({ email: PROBE_EMAIL });

                const left = await MemberDetails.countDocuments({ email: PROBE_EMAIL });
                check('the probe member is fully removed', left === 0, `${left} left`);
                await mongoose.disconnect();
            }
        } catch (err) {
            console.log(`  note  cleanup: ${err.message}`);
        }
    }
};

(async() => {
    console.log('='.repeat(72));
    console.log('REGISTRATION FORMS & PAYMENT');
    console.log('='.repeat(72));

    testSchemaContract();
    testBooleanNormalisation();
    await testLive();

    console.log(`\n${'='.repeat(72)}`);
    if (failures.length) {
        console.log('Failures:');
        failures.forEach((f) => console.log(`  - ${f}`));
    }
    console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('='.repeat(72));
    process.exit(failed === 0 ? 0 : 1);
})();
