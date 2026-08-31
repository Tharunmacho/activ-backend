/**
 * Remove admin accounts outside one state.
 *
 *   node scripts/trim-admins-to-state.js "Tamil Nadu"            # dry run
 *   node scripts/trim-admins-to-state.js "Tamil Nadu" --confirm  # delete
 *
 * The restore brought back every account that was in the migration backup,
 * including a handful the old unified `admins` collection held for other
 * states. Only Tamil Nadu is in the pilot, and an admin for a state with no
 * applicants is a live credential with no purpose — so they come out.
 *
 * Deletion goes through `admin.repository.deleteEverywhere`, which clears the
 * account from the per-tier collection AND from the legacy unified collection.
 * Deleting from one and not the other leaves a credential that can still sign
 * in but no longer appears in the directory, which is the worst of both.
 *
 * Matching is case-insensitive and trimmed, because the region tree is matched
 * by anchored regex elsewhere and "tamil  nadu" is a different region from
 * "Tamil Nadu". Anything that is not exactly the kept state — including a blank
 * state — is reported, and blanks are listed separately rather than deleted, so
 * an account with a missing region is never silently destroyed.
 */
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../src/config/db');
const adminsDb = require('../src/modules/admin/adminsDb');
const repo = require('../src/modules/admin/admin.repository');

const KEEP = (process.argv[2] || '').trim();
const CONFIRM = process.argv.includes('--confirm');

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

(async () => {
    if (!KEEP) {
        console.error('Usage: node scripts/trim-admins-to-state.js "Tamil Nadu" [--confirm]');
        process.exit(1);
    }
    console.log(CONFIRM ? `--- TRIMMING to "${KEEP}" (deleting) ---` : `--- DRY RUN: trim to "${KEEP}" (nothing deleted) ---`);

    await connectDB();
    await adminsDb.ensureReady();

    const all = await repo.findAll({ fresh: true, includeUnstamped: true });
    const keep = norm(KEEP);

    const keeping = all.filter((a) => norm(a.state) === keep);
    const blank = all.filter((a) => !norm(a.state));
    const removing = all.filter((a) => norm(a.state) && norm(a.state) !== keep);

    console.log(`\ntotal accounts     : ${all.length}`);
    console.log(`keeping (${KEEP}) : ${keeping.length}`);
    console.log(`blank state        : ${blank.length}${blank.length ? '  (left alone — inspect these yourself)' : ''}`);
    blank.forEach((a) => console.log(`      ? ${a.email}  [${a.role}]`));
    console.log(`removing           : ${removing.length}`);
    removing.forEach((a) => console.log(`      - ${a.email}  [${a.role}]  ${a.state}${a.district ? ' / ' + a.district : ''}`));

    if (!removing.length) {
        console.log('\nNothing to remove.');
        process.exit(0);
    }
    if (!CONFIRM) {
        console.log('\nDry run complete. Nothing was deleted. Re-run with --confirm to apply.');
        process.exit(0);
    }

    let done = 0;
    for (const a of removing) {
        // eslint-disable-next-line no-await-in-loop
        await repo.deleteEverywhere({ email: a.email, objectId: a.id || a._id });
        done += 1;
    }
    console.log(`\ndeleted ${done} account(s).`);

    const after = await repo.findAll({ fresh: true, includeUnstamped: true });
    const byState = after.reduce((acc, a) => {
        const s = (a.state || '(none)').trim();
        acc[s] = (acc[s] || 0) + 1;
        return acc;
    }, {});
    console.log(`remaining: ${after.length}`, JSON.stringify(byState));
    process.exit(0);
})().catch((err) => {
    console.error('TRIM FAILED:', err.message);
    process.exit(1);
});
