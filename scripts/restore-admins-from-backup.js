/**
 * Restore the per-tier admin collections from the local backups.
 *
 *   node scripts/restore-admins-from-backup.js            # dry run (default)
 *   node scripts/restore-admins-from-backup.js --confirm  # actually write
 *
 * WHAT IT RESTORES, AND WHAT IT DELIBERATELY DOES NOT
 *
 * The target is the state the database was in AFTER the 23 Aug migration —
 * which is what was live until the data disappeared — not the state before it:
 *
 *   - the 23 real accounts that `migrate-to-segregated-admins` lifted out of
 *     the old unified `admins` collection. Their bcrypt hashes are in the
 *     backup, so these accounts come back with the passwords they already had.
 *   - the 433 Tamil Nadu pilot accounts the same migration seeded. Their
 *     passwords exist only as plaintext in `pilot-credentials-*.csv`, so they
 *     are re-hashed with bcrypt on the way in.
 *
 * It does NOT restore the 7,762-record scaffold that is also in that backup.
 * The migration deleted it on purpose: it is one shared bcrypt hash across
 * every region in India, and putting it back would return all 6,966 blocks to
 * the applicant dropdowns and make the coverage filter meaningless again.
 *
 * SAFETY
 *
 *   - Dry run unless `--confirm`.
 *   - Refuses to write into a tier that already holds stamped accounts, so it
 *     cannot double up if it is run twice or run against a healthy database.
 *   - Writes through `admin.repository` only. Writing these documents by hand
 *     is how you get `password` where the tier collections expect
 *     `passwordHash`, which Mongoose strict mode drops without an error and
 *     leaves an account with no credential at all.
 */
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// The repository reads the legacy unified `admins` collection alongside the
// per-tier ones, and that lives on the DEFAULT mongoose connection — so both
// have to be open or `col()` hands back undefined.
const connectDB = require('../src/config/db');
const adminsDb = require('../src/modules/admin/adminsDb');
const repo = require('../src/modules/admin/admin.repository');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const CONFIRM = process.argv.includes('--confirm');

const newest = (pattern) => {
    const hits = fs.readdirSync(BACKUP_DIR).filter((f) => pattern.test(f)).sort();
    return hits.length ? path.join(BACKUP_DIR, hits[hits.length - 1]) : '';
};

/** Minimal CSV reader for the credentials file: quoted fields, no embedded newlines. */
const readCsv = (file) => {
    const text = fs.readFileSync(file, 'utf8').trim();
    const rows = text.split(/\r?\n/);
    const header = rows[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
    return rows.slice(1).map((line) => {
        const cells = line.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
        const out = {};
        header.forEach((h, i) => {
            out[h] = String(cells[i] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"').trim();
        });
        return out;
    });
};

(async () => {
    console.log(CONFIRM ? '--- RESTORING ADMINS (writing) ---' : '--- DRY RUN (no writes; pass --confirm to apply) ---');

    const migrationFile = newest(/^admin-migration-.*\.json$/);
    const credentialsFile = newest(/^pilot-credentials-.*\.csv$/);
    if (!migrationFile) throw new Error('No admin-migration-*.json in backups/');
    if (!credentialsFile) throw new Error('No pilot-credentials-*.csv in backups/');

    console.log('migration backup :', path.basename(migrationFile));
    console.log('pilot credentials:', path.basename(credentialsFile));

    const migration = JSON.parse(fs.readFileSync(migrationFile, 'utf8'));
    const pilots = readCsv(credentialsFile);

    await connectDB();
    await adminsDb.ensureReady();

    // ---- what is in there right now
    const existing = await repo.findAll({ fresh: true, includeUnstamped: true });
    console.log(`\ncurrently in adminsdb: ${existing.length} account(s)`);
    if (existing.length > 0) {
        console.log('*** REFUSING TO RUN: the admin collections are not empty. ***');
        console.log('    Restoring on top of live accounts would create duplicates.');
        console.log('    Inspect them first, and clear them deliberately if that is what you want.');
        await adminsDb.close?.();
        process.exit(1);
    }

    // ---- build the document set
    const docs = [];
    const seen = new Set();

    for (const a of migration.unifiedAdmins || []) {
        const email = String(a.email || '').toLowerCase().trim();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        docs.push({
            fullName: a.fullName || '',
            email,
            // Already a bcrypt hash in the backup — carried across as-is so
            // these accounts keep the password they had.
            passwordHash: a.password || '',
            phoneNumber: a.phoneNumber || '',
            role: a.role,
            state: a.state || '',
            district: a.district || '',
            block: a.block || '',
            active: a.isActive !== false,
            createdVia: 'migrated_from_admins',
        });
    }
    const fromMigration = docs.length;

    for (const p of pilots) {
        const email = String(p.email || '').toLowerCase().trim();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        docs.push({
            fullName: p.fullName || '',
            email,
            // Plaintext in the CSV; hashed here so nothing is ever stored in clear.
            passwordHash: CONFIRM ? bcrypt.hashSync(p.password || '', 10) : '<hashed on --confirm>',
            phoneNumber: '',
            role: p.role,
            state: p.state || '',
            district: p.district || '',
            block: p.block || '',
            active: true,
            createdVia: 'tn_pilot_seed',
        });
    }
    const fromPilot = docs.length - fromMigration;

    const byRole = docs.reduce((acc, d) => { acc[d.role] = (acc[d.role] || 0) + 1; return acc; }, {});

    console.log(`\nto restore: ${docs.length} account(s)`);
    console.log(`   ${fromMigration} from the migration backup (existing bcrypt hashes preserved)`);
    console.log(`   ${fromPilot} from the pilot credentials CSV (re-hashed)`);
    console.log('   by role:', JSON.stringify(byRole));
    console.log('   NOT restoring the 7,762-record scaffold — see the header of this file.');

    const noCredential = docs.filter((d) => !d.passwordHash);
    if (noCredential.length) {
        console.log(`   !! ${noCredential.length} row(s) have no password and would be unusable:`);
        noCredential.slice(0, 5).forEach((d) => console.log('      ', d.email));
    }

    if (!CONFIRM) {
        console.log('\nDry run complete. Nothing was written. Re-run with --confirm to apply.');
        await adminsDb.close?.();
        process.exit(0);
    }

    const written = await repo.insertMany(docs);
    console.log(`\nwrote ${written.length} account(s).`);

    const after = await repo.findAll({ fresh: true, includeUnstamped: true });
    console.log(`adminsdb now holds ${after.length} account(s).`);

    await adminsDb.close?.();
    process.exit(0);
})().catch((err) => {
    console.error('RESTORE FAILED:', err.message);
    process.exit(1);
});
