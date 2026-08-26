/**
 * Removes accounts left behind by the verification scripts.
 *
 * Every synthetic account those scripts create uses the `@parity.local` domain,
 * which is reserved (RFC 6762 `.local` is link-local mDNS and can never be a
 * real mail domain), so the marker cannot collide with a member.
 *
 * They leaked because each script's teardown deleted the *applications* it
 * created — which is what its "before=N after=N" assertion checks — and, in
 * `verify-admin-parity`, only those MemberDetails rows produced by a final
 * approval. The applicant accounts registered on the way in were never
 * recorded, so nothing removed them, and the count assertion still passed
 * because it only ever counted applications.
 *
 *   node scripts/clean-verification-leftovers.js            # dry run
 *   node scripts/clean-verification-leftovers.js --confirm  # delete
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CONFIRM = process.argv.includes('--confirm');
const MARKER = /@parity\.local$/i;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const Member = require('../src/modules/members/memberdetails.model');
    const Auth = require('../src/modules/auth/auth.model');
    const Application = require('../src/modules/applications/application.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const FinancialInfo = require('../src/modules/members/memberfinancialinfo.model');
    const Declaration = require('../src/modules/members/memberdeclaration.model');
    const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
    const Company = require('../src/modules/members/company.model');
    const Product = require('../src/models/Product');

    try {
        const members = await Member.find({ email: MARKER }).select('_id email fullName').lean();
        const auths = await Auth.find({ email: MARKER }).select('_id email').lean();
        const apps = await Application.find({ email: MARKER }).select('_id email').lean();

        const ownerIds = [...new Set(
            [...members.map(m => m._id), ...auths.map(a => a._id)].map(String),
        )];

        const linked = async (model, filter) => (ownerIds.length ? model.countDocuments(filter) : 0);
        const byOwner = { $in: ownerIds };

        const counts = {
            members: members.length,
            auth: auths.length,
            applications: apps.length,
            personalInfo: await linked(PersonalInfo1, { userId: byOwner }),
            businessInfo: await linked(BusinessInfo, { userId: byOwner }),
            financialInfo: await linked(FinancialInfo, { memberId: byOwner }),
            declarations: await linked(Declaration, { $or: [{ userId: byOwner }, { memberId: byOwner }] }),
            companies: await linked(Company, { userId: byOwner }),
            products: await linked(Product, { userId: byOwner }),
        };

        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        console.log('\nLeftovers on the @parity.local marker\n');
        for (const [label, n] of Object.entries(counts)) {
            console.log('  ' + label.padEnd(16) + n);
        }
        console.log('  ' + '-'.repeat(24));
        console.log('  ' + 'total'.padEnd(16) + total);

        if (members.length) {
            console.log('\n  sample: ' + members.slice(0, 3).map(m => m.fullName + ' <' + m.email + '>').join(', '));
        }

        // The accounts that must survive, counted before and after.
        const realBefore = await Member.countDocuments({ email: { $not: MARKER } });

        if (!total) {
            console.log('\n  Nothing to remove.\n');
        } else if (!CONFIRM) {
            console.log('\n  Dry run. Re-run with --confirm to delete these.\n');
        } else {
            if (ownerIds.length) {
                await Product.deleteMany({ userId: byOwner });
                await Company.deleteMany({ userId: byOwner });
                await BusinessInfo.deleteMany({ userId: byOwner });
                await FinancialInfo.deleteMany({ memberId: byOwner });
                await Declaration.deleteMany({ $or: [{ userId: byOwner }, { memberId: byOwner }] });
                await PersonalInfo1.deleteMany({ userId: byOwner });
            }
            await Application.deleteMany({ email: MARKER });
            await Member.deleteMany({ email: MARKER });
            await Auth.deleteMany({ email: MARKER });

            const realAfter = await Member.countDocuments({ email: { $not: MARKER } });
            const leftover = await Member.countDocuments({ email: MARKER });

            console.log('\n  Removed ' + total + ' documents.');
            console.log('  real members before=' + realBefore + ' after=' + realAfter +
                (realBefore === realAfter ? ' (untouched)' : '  *** A REAL MEMBER WAS REMOVED ***'));
            console.log('  marked rows remaining: ' + leftover + '\n');
        }
    } finally {
        await mongoose.disconnect();
    }
})();
