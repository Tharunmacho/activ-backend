/**
 * Does every option the member forms OFFER actually save?
 *
 * The four forms are full of enum-constrained fields, and the clients keep their
 * own copies of the option lists because a dropdown cannot wait on a request to
 * render. When a copy drifts, nothing catches it until a member has filled in
 * the whole step and gets a 400 with a Mongoose sentence in it:
 *
 *     `Agriculture` is not a valid enum value for path `businessTypes.0`.
 *
 * `pages/member/Profile.tsx` had drifted on four fields at once, and on one of
 * them — turnover — not a single option it offered was valid, so the financial
 * step could not be saved by anybody.
 *
 * This posts every option, one at a time, through the real endpoint and reports
 * which are accepted. A dropdown must not offer a choice the database refuses.
 *
 *   PORT=5077 node src/server.js
 *   node scripts/verify-form-options.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const PORT = process.env.PARITY_PORT || 5077;
const BASE = `http://localhost:${PORT}/api/v1`;
const RUN = String(Date.now()).slice(-8);

/**
 * The lists the clients offer. Kept here verbatim rather than imported, because
 * the point of the check is to catch a client list that has drifted from the
 * server — importing the server's own list would test nothing.
 */
const OFFERED = {
    constitutionType: ['OPC', 'TRUST', 'SOCIETY', 'Proprietorship', 'Partnership', 'Private Limited'],
    businessTypes: ['Manufacturing', 'Trader', 'Service Provider', 'Others'],
    govtOrganizations: ['MSME', 'KVIC', 'NABARD', 'None', 'Others'],
    turnoverRange: ['Below 1 Lakh', '1-5 Lakhs', '5-10 Lakhs', '10-50 Lakhs', '50 Lakhs - 1 Crore', 'Above 1 Crore'],
    socialCategory: ['Christian ST', 'Christian SC', 'ST', 'SC', 'Others'],
    religion: ['Hinduism', 'Christianity', 'Islam', 'Sikhism', 'Buddhism', 'Jainism', 'Others'],
    category: ['Software', 'Services', 'Education', 'Product', 'Hardware', 'Electronics',
        'Clothing', 'Food', 'Books', 'Toys', 'Furniture', 'Sports', 'Beauty', 'Other'],
};

/** How each field has to be sent for the server to reach its enum. */
const PAYLOAD = {
    constitutionType: (v) => ({ doingBusiness: true, constitutionType: v, businessTypes: ['Manufacturing'] }),
    businessTypes: (v) => ({ doingBusiness: true, businessTypes: [v] }),
    govtOrganizations: (v) => ({ doingBusiness: true, businessTypes: ['Manufacturing'], govtOrganizations: [v] }),
    turnoverRange: (v) => ({ turnoverRange: v }),
    socialCategory: (v) => ({ socialCategory: v }),
    religion: (v) => ({ religion: v }),
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { minPoolSize: 2 });

    const MemberDetails = require('../src/modules/members/memberdetails.model');
    const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const MemberFinancialInfo = require('../src/modules/members/memberfinancialinfo.model');
    const MemberDeclaration = require('../src/modules/members/memberdeclaration.model');

    const anyMember = await MemberDetails.findOne({ state: { $ne: null } }).lean();
    const probe = await MemberDetails.create({
        fullName: 'Options Probe',
        email: `options-${RUN}@parity.local`,
        phoneNumber: '9000000008',
        state: anyMember?.state || 'Tamil Nadu',
        district: anyMember?.district || 'Ariyalur',
        block: anyMember?.block || 'Ariyalur',
    });
    const userId = String(probe._id);
    const token = jwt.sign({ userId, role: 'member', email: probe.email }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const put = async (body) => {
        const r = await fetch(`${BASE}/members/profile`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };

    let rejected = 0;

    for (const [field, buildPayload] of Object.entries(PAYLOAD)) {
        console.log(`\n  ${field}`);
        for (const value of OFFERED[field]) {
            const res = await put(buildPayload(value));
            const ok = res.status === 200;
            if (!ok) rejected++;
            console.log(`    ${ok ? 'OK  ' : 'REJECTED'} ${String(value).padEnd(20)}` +
                (ok ? '' : `HTTP ${res.status} — ${String(res.body?.message).slice(0, 70)}`));
        }
    }

    /**
     * `socialCategory` is guarded rather than rejected: an unknown value is
     * dropped before the write, so it returns 200 and simply does not save.
     * A 200 is not proof here — the stored value has to be read back.
     */
    console.log('\n  socialCategory — stored, not merely accepted');
    for (const value of OFFERED.socialCategory) {
        await put({ socialCategory: value });
        const doc = await MemberDetails.findById(userId).lean();
        const stored = doc?.socialCategory === value;
        if (!stored) rejected++;
        console.log(`    ${stored ? 'OK  ' : 'DROPPED '} ${String(value).padEnd(20)} stored=${JSON.stringify(doc?.socialCategory)}`);
    }

    // ---------------------------------------------------------------- teardown
    await Promise.all([
        PersonalInfo1.deleteMany({ userId }),
        BusinessInfo.deleteMany({ userId }),
        MemberFinancialInfo.deleteMany({ memberId: userId }),
        MemberDeclaration.deleteMany({ $or: [{ userId }, { memberId: userId }] }),
    ]);
    await MemberDetails.deleteOne({ _id: userId });
    const left = await MemberDetails.countDocuments({ email: probe.email });

    console.log(`\n  teardown: probe removed (${left} left behind)`);
    console.log(rejected === 0
        ? '\n  EVERY OPTION THE FORMS OFFER IS ACCEPTED AND STORED\n'
        : `\n  ${rejected} OPTION(S) THE FORMS OFFER ARE REFUSED BY THE DATABASE\n`);

    await mongoose.disconnect();
    process.exit(rejected === 0 ? 0 : 1);
})().catch((err) => {
    console.error('option check failed:', err);
    process.exit(1);
});
