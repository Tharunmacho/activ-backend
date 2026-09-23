/**
 * Time every database call `PUT /members/profile` makes, one by one.
 *
 *   node scripts/time-profile-update.js            # report
 *   node scripts/time-profile-update.js <memberId> # against one member
 *
 * READ-ONLY. It runs the READS the handler runs and `explain`s the write it
 * makes, so it can be pointed at the live cluster without changing anything.
 *
 * Why this exists: "saving my profile is slow" is not a measurement, and the
 * handler makes seven or eight round trips in sequence — the only way to know
 * which one costs the time is to time each of them.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const ms = (start) => `${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(0)} ms`;

const time = async (label, fn) => {
    const started = process.hrtime.bigint();
    let note = '';
    try {
        note = (await fn()) || '';
    } catch (err) {
        note = `FAILED: ${err.message}`;
    }
    console.log(`  ${label.padEnd(38)} ${ms(started).padStart(8)}   ${note}`);
};

async function main() {
    console.log('\n=== PUT /members/profile — where the time goes ===\n');

    const connectStart = process.hrtime.bigint();
    await mongoose.connect(config.db.uri);
    await adminsDb.ensureReady();
    console.log(`  ${'connect + adminsdb'.padEnd(38)} ${ms(connectStart).padStart(8)}`);

    const MemberDetails = require('../src/modules/members/memberdetails.model');
    const PersonalInfo1 = require('../src/modules/members/personalinfo1.model');
    const BusinessInfo = require('../src/modules/members/businessinfo.model');
    const Application = require('../src/modules/applications/application.model');

    const argId = process.argv[2];
    const member = argId
        ? await MemberDetails.findById(argId)
        : await MemberDetails.findOne({ profileCompleted: true }).sort({ updatedAt: -1 });

    if (!member) {
        console.log('\n  No member found to measure against.\n');
        return;
    }

    const userId = member._id;
    const email = String(member.email || '').toLowerCase();
    console.log(`\n  Measuring against: ${member.fullName || member.name || userId} (${email})\n`);

    await time('MemberDetails.findById', () => MemberDetails.findById(userId).lean());
    await time('PersonalInfo1.findOne({ userId })', () => PersonalInfo1.findOne({ userId }).lean());
    await time('BusinessInfo.findOne({ userId })', () => BusinessInfo.findOne({ userId }).lean());

    await time('Application.countDocuments (all)', async () => {
        const n = await Application.estimatedDocumentCount();
        return `${n} applications in the collection`;
    });

    /*
     * The one the handler blocks on. `$or` over three predicates can only use
     * an index if EVERY branch has one — otherwise Mongo scans the collection
     * for the whole query, however well indexed the other branches are.
     */
    const filter = {
        $or: [{ userId }, { email }, { email }],
    };
    await time('Application.find(sync filter)', async () => {
        const rows = await Application.find(filter).select('_id').lean();
        return `${rows.length} row(s) would be updated`;
    });

    await time('Application.explain(sync filter)', async () => {
        const plan = await Application.find(filter).explain('executionStats');
        const stats = plan?.executionStats || {};
        const winning = JSON.stringify(plan?.queryPlanner?.winningPlan || {});
        const stage = winning.includes('COLLSCAN') ? 'COLLSCAN — no index used' : 'index used';
        return `${stage}; examined ${stats.totalDocsExamined} doc(s), returned ${stats.nReturned}`;
    });

    console.log('\n  Read the largest number above: that is the call to fix.\n');
}

main()
    .catch((err) => {
        console.error('\nFailed:', err && err.message ? err.message : err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
        process.exit(process.exitCode || 0);
    });
