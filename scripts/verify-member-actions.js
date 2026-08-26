/**
 * Verifies the admin Members screen actions end to end, against the live API.
 *
 * Four things are checked, in this order:
 *
 *   1. a rejected applicant appears in the Members directory as Inactive
 *      (the Inactive tab used to be structurally unreachable);
 *   2. suspend / reactivate flip the real `isActive` field and the directory
 *      follows;
 *   3. the geofence rejects an admin from another region — this write had no
 *      scope check at all, so any block admin could delete any member;
 *   4. delete removes every collection keyed to the member, not just the
 *      MemberDetails row.
 *
 * Everything it creates is synthetic, tagged with a run id, and removed at the
 * end — including on failure. It asserts the real application count is unchanged
 * before it exits, the same guard the other verification scripts use.
 *
 *   PORT=5077 node src/server.js
 *   BASE_URL=http://localhost:5077 node scripts/verify-member-actions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const BASE = (process.env.BASE_URL || 'http://localhost:5077').replace(/\/$/, '') + '/api/v1';
const RUN = 'MBRACT' + Date.now().toString(36).toUpperCase();

const REGION = { state: 'MA Test State', district: 'MA Test District', block: 'MA Test Block' };
const OTHER = { state: 'MA Other State', district: 'MA Other District', block: 'MA Other Block' };

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

const token = (role, claims) => jwt.sign(
    Object.assign({ userId: new mongoose.Types.ObjectId().toString(), role, email: RUN + '@admin.test' }, claims),
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
);

const call = async (path, options = {}) => {
    const res = await fetch(BASE + path, {
        method: options.method || 'GET',
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            options.token ? { Authorization: 'Bearer ' + options.token } : {},
        ),
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const Application = require('../src/modules/applications/application.model');
    const Member = require('../src/modules/members/memberdetails.model');
    const Auth = require('../src/modules/auth/auth.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const FinancialInfo = require('../src/modules/members/memberfinancialinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');

    const baseline = await Application.countDocuments();
    const created = { applications: [], members: [], auths: [], extras: [] };

    /** One applicant, with the four member-side documents behind it. */
    const seed = async (label, status, region) => {
        const email = (RUN + '.' + label + '@test.invalid').toLowerCase();

        const auth = await Auth.create({
            email,
            password: 'x'.repeat(60),
            role: 'member',
            isVerified: true,
        });
        created.auths.push(auth._id);

        const member = await Member.create({
            _id: auth._id,
            fullName: RUN + ' ' + label,
            email,
            phoneNumber: '9000000000',
            state: region.state,
            district: region.district,
            block: region.block,
            isActive: true,
        });
        created.members.push(member._id);

        const business = await BusinessInfo.create({ userId: auth._id, organizationName: RUN + ' Co' });
        const financial = await FinancialInfo.create({ memberId: auth._id, turnoverRange: '1-5 Lakhs' });
        const declaration = await Declaration.create({ userId: auth._id, memberId: auth._id, agreeToDeclaration: true });
        created.extras.push(
            { model: BusinessInfo, id: business._id },
            { model: FinancialInfo, id: financial._id },
            { model: Declaration, id: declaration._id },
        );

        const application = await Application.create({
            userId: auth._id,
            fullName: RUN + ' ' + label,
            email,
            phone: '9000000000',
            status,
            state: region.state,
            district: region.district,
            block: region.block,
            rejectedBy: status === 'Rejected'
                ? { adminType: 'BlockAdmin', rejectedAt: new Date(), rejectionReason: 'Test rejection ' + RUN }
                : undefined,
            blockApprovedAt: status === 'Approved' ? new Date() : undefined,
            districtApprovedAt: status === 'Approved' ? new Date() : undefined,
            stateApprovedAt: status === 'Approved' ? new Date() : undefined,
        });
        created.applications.push(application._id);

        return { application, member, auth, email };
    };

    const cleanup = async () => {
        for (const { model, id } of created.extras) await model.deleteOne({ _id: id }).catch(() => {});
        await Application.deleteMany({ _id: { $in: created.applications } }).catch(() => {});
        await Member.deleteMany({ _id: { $in: created.members } }).catch(() => {});
        await Auth.deleteMany({ _id: { $in: created.auths } }).catch(() => {});
    };

    try {
        const blockAdmin = token('block_admin', REGION);
        const foreignAdmin = token('block_admin', OTHER);

        const approved = await seed('approved', 'Approved', REGION);
        const rejected = await seed('rejected', 'Rejected', REGION);

        const directory = async (tok) => {
            const res = await call('/admin/block/dashboard', { token: tok });
            return (res.body && res.body.data && res.body.data.members) || [];
        };

        // ---- 1. rejected lands in Inactive -------------------------------
        console.log('\nA rejected applicant is an Inactive member');

        let rows = await directory(blockAdmin);
        const findRow = (list, id) => list.find(r => String(r.id) === String(id));

        const approvedRow = findRow(rows, approved.application._id);
        const rejectedRow = findRow(rows, rejected.application._id);

        check('the approved applicant is in the directory', !!approvedRow);
        check('the approved applicant is Active',
            approvedRow && approvedRow.memberStatus === 'Active',
            approvedRow && approvedRow.memberStatus);
        check('the rejected applicant is in the directory', !!rejectedRow,
            'rejected applicants used to be absent entirely');
        check('the rejected applicant is Inactive',
            rejectedRow && rejectedRow.memberStatus === 'Inactive',
            rejectedRow && rejectedRow.memberStatus);
        check('the row says why they are inactive',
            !!(rejectedRow && rejectedRow.inactiveReason),
            rejectedRow && rejectedRow.inactiveReason);

        // ---- 2. suspend / reactivate -------------------------------------
        console.log('\nSuspend and reactivate');

        const suspend = await call('/admin/users/' + approved.application._id + '/suspend', {
            method: 'POST', token: blockAdmin,
        });
        check('suspend returns 200 for an application id', suspend.status === 200,
            'status ' + suspend.status + ' ' + JSON.stringify(suspend.body && suspend.body.message));

        let stored = await Member.findById(approved.member._id).lean();
        check('isActive is false in the database', stored && stored.isActive === false, String(stored && stored.isActive));

        rows = await directory(blockAdmin);
        check('the directory now reports Inactive',
            (findRow(rows, approved.application._id) || {}).memberStatus === 'Inactive');

        const reactivate = await call('/admin/users/' + approved.application._id + '/activate', {
            method: 'POST', token: blockAdmin,
        });
        check('activate returns 200', reactivate.status === 200, 'status ' + reactivate.status);

        stored = await Member.findById(approved.member._id).lean();
        check('isActive is true again', stored && stored.isActive === true, String(stored && stored.isActive));

        // ---- 3. the geofence ---------------------------------------------
        console.log('\nThe geofence covers this write, not just reads');

        const foreignSuspend = await call('/admin/users/' + approved.application._id + '/suspend', {
            method: 'POST', token: foreignAdmin,
        });
        check('an admin from another block cannot suspend', foreignSuspend.status === 403,
            'status ' + foreignSuspend.status);

        const foreignDelete = await call('/admin/users/' + approved.application._id + '/delete', {
            method: 'POST', token: foreignAdmin,
        });
        check('an admin from another block cannot delete', foreignDelete.status === 403,
            'status ' + foreignDelete.status);

        const stillThere = await Member.findById(approved.member._id).lean();
        check('the member survived the refused delete', !!stillThere);

        const badAction = await call('/admin/users/' + approved.application._id + '/banish', {
            method: 'POST', token: blockAdmin,
        });
        check('an unknown action is rejected', badAction.status === 400, 'status ' + badAction.status);

        // ---- 4. delete cascades ------------------------------------------
        console.log('\nDelete removes every record, not just the member row');

        const del = await call('/admin/users/' + rejected.application._id + '/delete', {
            method: 'POST', token: blockAdmin,
        });
        check('delete returns 200', del.status === 200, 'status ' + del.status);

        const gone = async (label, model, filter) => {
            const count = await model.countDocuments(filter);
            check(label + ' removed', count === 0, count + ' left behind');
        };

        await gone('application', Application, { _id: rejected.application._id });
        await gone('member record', Member, { _id: rejected.member._id });
        await gone('login credential', Auth, { _id: rejected.auth._id });
        await gone('business info', BusinessInfo, { userId: rejected.auth._id });
        await gone('financial info', FinancialInfo, { memberId: rejected.auth._id });
        await gone('declaration', Declaration, { userId: rejected.auth._id });

        rows = await directory(blockAdmin);
        check('the deleted member is gone from the directory',
            !findRow(rows, rejected.application._id));

        const otherStill = await Member.findById(approved.member._id).lean();
        check('the other member was untouched', !!otherStill);
    } catch (error) {
        failed += 1;
        console.log('\n  FAIL  the run threw: ' + (error && error.message));
    } finally {
        await cleanup();
        const after = await Application.countDocuments();
        console.log('\n  teardown: applications before=' + baseline + ' after=' + after +
            (after === baseline ? ' (clean)' : '  *** MISMATCH ***'));
        if (after !== baseline) failed += 1;
        await mongoose.disconnect();
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed === 0) {
        console.log('\n  MEMBER ACTIONS ARE SCOPED, PERSISTED AND FULLY CASCADED\n');
    }
    process.exit(failed > 0 ? 1 : 0);
})();
