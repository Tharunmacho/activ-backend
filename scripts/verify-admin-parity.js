/**
 * Deep value-check for the ADMIN workflows: does an approval or rejection taken
 * from the mobile app land in the database identically to the same decision
 * taken from the website?
 *
 * The two clients do NOT call the same endpoint. Mobile posts to the tier-named
 * routes, one per admin type:
 *
 *     POST /applications/:id/block-review     { action, rejectionReason }
 *     POST /applications/:id/district-review  { action, rejectionReason }
 *     POST /applications/:id/state-review     { action, rejectionReason }
 *
 * The website posts to the tier-agnostic aliases, letting the caller's role
 * select the tier:
 *
 *     POST /applications/:id/approve          {}
 *     POST /applications/:id/reject           { rejectionReason }
 *
 * Both are legitimate and documented, and `reviewApplication` does delegate to
 * the same three tier methods — but "reads like it delegates" is not a
 * guarantee. This runs the real decision down both paths, on two applications
 * seeded to be byte-identical, and diffs every field the workflow touches:
 * status, the three approval timestamps, reviewedBy, rejectedBy and its nested
 * reason, and the notes trail.
 *
 * It also walks the full three-tier chain (Pending-Block -> Approved) down each
 * path, because a per-step match does not prove the end state matches.
 *
 * Everything is created inside a synthetic region tagged with a run id and
 * deleted afterwards, so it is safe against the shared cluster. It asserts the
 * real application count is unchanged at the end.
 *
 *   PORT=5077 node src/server.js
 *   node scripts/verify-admin-parity.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PORT = process.env.PARITY_PORT || 5077;
const BASE = `http://localhost:${PORT}/api/v1`;

const RUN = String(Date.now()).slice(-8);
const REGION = {
    state: `ZZ Parity State ${RUN}`,
    district: `ZZ Parity District ${RUN}`,
    block: `ZZ Parity Block ${RUN}`,
};

/** Differs per document by construction; never a parity signal. */
const VOLATILE = new Set([
    '_id', '__v', 'createdAt', 'updatedAt', 'applicationId', 'userId', 'email',
    'submittedAt', 'blockApprovedAt', 'districtApprovedAt', 'stateApprovedAt',
    'reviewedAt', 'rejectedAt', 'memberId', 'fullName',
]);

/**
 * Timestamps are compared as "set / not set" rather than by value — two runs a
 * few milliseconds apart must not read as a divergence, but a path that forgets
 * to stamp one at all must.
 */
const shape = (v) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return '<set>';
    if (Array.isArray(v)) return v.map(shape);
    if (typeof v === 'object') {
        const out = {};
        Object.keys(v).sort().forEach((k) => {
            if (k === '_id' || k === 'createdAt' || k === 'adminId') return;
            /**
             * Per-document identity, at any depth.
             *
             * The two copies under comparison are separate applications with
             * their own tag, so `data.personalDetails.email` and `.fullName`
             * differ by construction. Comparing them would report a divergence
             * on every single case and drown the fields that actually matter.
             */
            if (k === 'email' || k === 'fullName') return;
            if (/At$/.test(k)) { out[k] = v[k] ? '<set>' : null; return; }
            out[k] = shape(v[k]);
        });
        return out;
    }
    return v;
};

const snap = (doc) => {
    if (!doc) return null;
    const out = {};
    Object.keys(doc).sort().forEach((k) => {
        if (VOLATILE.has(k)) {
            // Presence still matters for the approval stamps.
            if (/ApprovedAt$/.test(k)) out[`${k}!set`] = !!doc[k];
            return;
        }
        out[k] = shape(doc[k]);
    });
    return out;
};

const diff = (a, b) => {
    const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
    const out = [];
    for (const k of keys) {
        const av = JSON.stringify((a || {})[k]);
        const bv = JSON.stringify((b || {})[k]);
        if (av !== bv) out.push(`        ${k}\n          mobile : ${av}\n          website: ${bv}`);
    }
    return out;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { minPoolSize: 2 });

    const Application = require('../src/modules/applications/application.model');
    const MemberDetails = require('../src/modules/members/memberdetails.model');

    const realCountBefore = await Application.countDocuments({});

    /** A token carrying the location claims the geofence reads. */
    const tokenFor = (role) => jwt.sign({
        userId: new mongoose.Types.ObjectId().toString(),
        role,
        email: `${role}-${RUN}@parity.local`,
        ...REGION,
    }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const TOKENS = {
        block: tokenFor('block_admin'),
        district: tokenFor('district_admin'),
        state: tokenFor('state_admin'),
    };

    const post = async (path, token, body) => {
        const r = await fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body || {}),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    const created = [];

    const seedApplication = async (tag, status) => {
        const app = await Application.create({
            applicationId: `PARITY-${RUN}-${tag}`,
            // Required on the schema. Each seeded application gets its own, so
            // the two copies under comparison are independent documents.
            userId: new mongoose.Types.ObjectId(),
            fullName: `Parity Applicant ${tag}`,
            email: `applicant-${RUN}-${tag}@parity.local`,
            phone: '9000000009',
            ...REGION,
            status,
            applicationType: 'membership',
            registrationType: 'aspirant',
            memberType: 'aspirant',
            data: {
                personalDetails: {
                    fullName: `Parity Applicant ${tag}`,
                    email: `applicant-${RUN}-${tag}@parity.local`,
                    phone: '9000000009',
                    ...REGION,
                },
                businessInfo: {}, financialInfo: {}, declaration: {},
            },
        });
        created.push(app._id);
        return app;
    };

    const read = async (id) => snap(await Application.findById(id).lean());

    let failures = 0;
    const report = (label, mobileRes, webRes, mSnap, wSnap) => {
        const problems = [];
        if (mobileRes.status !== webRes.status) {
            problems.push(`        HTTP: mobile=${mobileRes.status} website=${webRes.status}`);
        }
        problems.push(...diff(mSnap, wSnap));
        if (problems.length) {
            failures++;
            console.log(`  DIFFER  ${label}`);
            problems.forEach((p) => console.log(p));
        } else {
            console.log(`  MATCH   ${label}  (HTTP ${mobileRes.status})`);
        }
    };

    const TIERS = [
        { tier: 'block', from: 'Pending-Block', path: 'block-review' },
        { tier: 'district', from: 'Pending-District', path: 'district-review' },
        { tier: 'state', from: 'Pending-State', path: 'state-review' },
    ];

    // ------------------------------------------------------------- approvals
    console.log('\n  APPROVE — mobile tier route vs website generic alias\n');
    for (const t of TIERS) {
        const a = await seedApplication(`${t.tier}-app-m`, t.from);
        const b = await seedApplication(`${t.tier}-app-w`, t.from);

        const m = await post(`/applications/${a._id}/${t.path}`, TOKENS[t.tier], { action: 'approve' });
        const w = await post(`/applications/${b._id}/approve`, TOKENS[t.tier], {});

        report(`${t.tier} admin approves ${t.from}`, m, w, await read(a._id), await read(b._id));
    }

    // ------------------------------------------------------------ rejections
    console.log('\n  REJECT — including the rejection reason each client sends\n');
    for (const t of TIERS) {
        const a = await seedApplication(`${t.tier}-rej-m`, t.from);
        const b = await seedApplication(`${t.tier}-rej-w`, t.from);

        const REASON = 'Documents illegible';
        const m = await post(`/applications/${a._id}/${t.path}`, TOKENS[t.tier],
            { action: 'reject', rejectionReason: REASON });
        const w = await post(`/applications/${b._id}/reject`, TOKENS[t.tier],
            { rejectionReason: REASON });

        report(`${t.tier} admin rejects ${t.from}`, m, w, await read(a._id), await read(b._id));
    }

    /**
     * A match is not proof on its own — two paths that both store nothing also
     * match. This asserts the reason and the reviewer actually landed, and that
     * `rejectedAt` sits inside `rejectedBy` where the schema puts it (a
     * top-level `rejectedAt` is silently dropped by Mongoose).
     */
    console.log('\n  REJECT — the reason and reviewer actually persist\n');
    for (const client of ['mobile', 'website']) {
        const app = await seedApplication(`persist-${client}`, 'Pending-Block');
        const REASON = 'Documents illegible';
        if (client === 'mobile') {
            await post(`/applications/${app._id}/block-review`, TOKENS.block,
                { action: 'reject', rejectionReason: REASON });
        } else {
            await post(`/applications/${app._id}/reject`, TOKENS.block, { rejectionReason: REASON });
        }
        const d = await Application.findById(app._id).lean();
        const checks = {
            'status': d?.status === 'Rejected',
            'rejectionReason': d?.rejectionReason === REASON,
            'rejectedBy.adminType': d?.rejectedBy?.adminType === 'BlockAdmin',
            'rejectedBy.rejectedAt': !!d?.rejectedBy?.rejectedAt,
            'rejectedBy.adminId': !!d?.rejectedBy?.adminId,
        };
        const bad = Object.entries(checks).filter(([, ok]) => !ok);
        if (bad.length) failures++;
        console.log(`    via ${client}: ${bad.length ? 'FAIL' : 'OK  '} ` +
            Object.entries(checks).map(([k, ok]) => `${k}=${ok ? 'y' : 'N'}`).join('  '));
    }

    // ------------------------------- the website's alternate reason key: `reason`
    console.log('\n  REJECT — website sending `reason` instead of `rejectionReason`\n');
    {
        const a = await seedApplication('altkey-m', 'Pending-Block');
        const b = await seedApplication('altkey-w', 'Pending-Block');
        const m = await post(`/applications/${a._id}/block-review`, TOKENS.block,
            { action: 'reject', rejectionReason: 'Key test' });
        const w = await post(`/applications/${b._id}/reject`, TOKENS.block, { reason: 'Key test' });
        report('block reject via `reason` alias', m, w, await read(a._id), await read(b._id));
    }

    // -------------------------------------------------- full three-tier chain
    console.log('\n  FULL CHAIN — Pending-Block through to Approved, down each path\n');
    {
        const a = await seedApplication('chain-m', 'Pending-Block');
        const b = await seedApplication('chain-w', 'Pending-Block');

        let mLast, wLast;
        for (const t of TIERS) {
            mLast = await post(`/applications/${a._id}/${t.path}`, TOKENS[t.tier], { action: 'approve' });
            wLast = await post(`/applications/${b._id}/approve`, TOKENS[t.tier], {});
        }
        report('full chain -> final state', mLast, wLast, await read(a._id), await read(b._id));

        const finalDoc = await Application.findById(a._id).lean();
        console.log(`        final status via mobile path : ${finalDoc?.status}`);
        const finalDocW = await Application.findById(b._id).lean();
        console.log(`        final status via website path: ${finalDocW?.status}`);

        // Final approval creates the member documents; record what appeared so
        // the teardown can remove them.
        for (const e of [a.email, b.email]) {
            const m = await MemberDetails.findOne({ email: e }).lean();
            if (m) created.push({ member: m._id });
        }
    }

    // ----------------------------------------- read paths: dashboards & members
    console.log('\n  READ PATHS — the queues each client renders\n');
    for (const t of TIERS) {
        const r = await fetch(`${BASE}/admin/${t.tier}/dashboard`, {
            headers: { Authorization: `Bearer ${TOKENS[t.tier]}` },
        });
        const body = await r.json().catch(() => null);
        const d = body?.data || {};
        const buckets = d.applicants || {};
        const ok = r.status === 200 && ['pending', 'approved', 'rejected', 'all'].every((k) => Array.isArray(buckets[k]));
        if (!ok) failures++;
        console.log(`    ${ok ? 'OK  ' : 'FAIL'} GET /admin/${t.tier}/dashboard  ` +
            `HTTP ${r.status}  buckets=[${Object.keys(buckets).join(',')}]  ` +
            `scopeUnresolved=${d.scopeUnresolved === true}`);
    }

    // ------------------------------------------------------------- teardown
    const ids = created.filter((c) => !c.member);
    const memberIds = created.filter((c) => c.member).map((c) => c.member);
    await Application.deleteMany({ _id: { $in: ids } });
    if (memberIds.length) await MemberDetails.deleteMany({ _id: { $in: memberIds } });
    await Application.deleteMany({ applicationId: new RegExp(`^PARITY-${RUN}-`) });

    // Sweep by the run marker as well as by recorded id.
    //
    // Only the MemberDetails rows produced by a *final approval* were recorded
    // above; the applicant accounts registered on the way in were not, so
    // nothing removed them. Thirty-one accumulated before this was noticed,
    // because the assertion below counts applications and those were always
    // cleaned. `@parity.local` is reserved (RFC 6762) and cannot be a real
    // member, so matching on it is safe.
    const MARKER = new RegExp(`(^|-)${RUN}(-|@)`);
    await MemberDetails.deleteMany({ email: MARKER });
    await Application.deleteMany({ email: MARKER });

    const realCountAfter = await Application.countDocuments({});
    const clean = realCountBefore === realCountAfter;
    if (!clean) failures++;
    console.log(`\n  teardown: applications before=${realCountBefore} after=${realCountAfter} ` +
        `${clean ? '(clean)' : '(LEFTOVERS — clean up before re-running)'}`);

    console.log(failures === 0
        ? '\n  ADMIN ACTIONS PRODUCE IDENTICAL DATABASE STATE FROM BOTH CLIENTS\n'
        : `\n  ${failures} CHECK(S) FAILED\n`);

    await mongoose.disconnect();
    process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
    console.error('admin parity check failed:', err);
    process.exit(1);
});
