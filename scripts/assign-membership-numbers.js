/**
 * Give every existing member a year-wise membership number: ACTIV-2026-001, …
 *
 *   node scripts/assign-membership-numbers.js            # dry run: prints old -> new
 *   node scripts/assign-membership-numbers.js --confirm  # apply
 *
 * Who: every member whose membership has ever been activated (active, completed,
 * expired — an expired member is still a member with a number) and who does not
 * already hold a standard `ACTIV-YYYY-NNN` number. Numbered in the order they
 * were activated, within the year they were activated, continuing each year's
 * counter (`membership_counters`) — so new payments after this carry on from
 * where it stops. Safe to re-run: members already numbered are skipped.
 *
 * A CSV of old -> new is written to backups/ on --confirm.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const MemberDetails = require('../src/modules/members/memberdetails.model');
const {
    membershipNumberFor, yearOf, assignMembershipNumber, STANDARD_NUMBER
} = require('../src/modules/members/memberNumber');

const CONFIRM = process.argv.includes('--confirm');

(async() => {
    await mongoose.connect(process.env.MONGODB_URI);

    const members = await MemberDetails.find({
        membershipStatus: { $in: ['active', 'completed', 'expired', 'ACTIVE', 'COMPLETED', 'EXPIRED'] }
    }).select('fullName email membershipNumber membershipActivatedAt createdAt').lean();

    const todo = members
        .filter((m) => !STANDARD_NUMBER.test(String(m.membershipNumber || '').trim()))
        .sort((a, b) => new Date(a.membershipActivatedAt || a.createdAt || 0) - new Date(b.membershipActivatedAt || b.createdAt || 0));

    console.log(`${members.length} members with an activated membership; ${todo.length} need a standard number.`);
    if (!todo.length) process.exit(0);

    if (!CONFIRM) {
        todo.forEach((m) => console.log(`  ${membershipNumberFor(m).padEnd(22)} -> next ACTIV-${yearOf(m)}-NNN   ${m.fullName || ''} <${m.email || ''}>`));
        console.log('\nDry run. Re-run with --confirm to assign.');
        process.exit(0);
    }

    const rows = [['email', 'name', 'old_number', 'new_number']];
    for (const m of todo) {
        const before = membershipNumberFor(m);
        const after = await assignMembershipNumber(m._id, { year: yearOf(m) });
        console.log(`  ${before.padEnd(22)} -> ${after || '(failed)'}   ${m.fullName || ''}`);
        rows.push([m.email || '', m.fullName || '', before, after || '']);
    }

    const dir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `membership-numbers-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    fs.writeFileSync(file, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));
    console.log(`\nWritten ${path.relative(process.cwd(), file)}`);
    process.exit(0);
})().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
