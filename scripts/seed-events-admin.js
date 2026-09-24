/**
 * Create (or reset) the EVENTS ADMIN account.
 *
 *   node scripts/seed-events-admin.js --email event@gmail.com --password 'ChangeMe@123'           # report
 *   node scripts/seed-events-admin.js --email event@gmail.com --password 'ChangeMe@123' --confirm # apply
 *
 * Stored exactly the way the CMS admin is (see `split-super-admin-roles.js`):
 * through `admin.repository`, the only module allowed to write admin documents,
 * into `adminsdb.superadmins` with `role: 'events_admin'` and a bcrypt
 * `passwordHash`. The repository translates the field names per collection —
 * writing the document by hand is how an account ends up with no credential.
 *
 * What the role reaches: `/events-admin` on the website — the events list and
 * editor, categories and bookings, exactly the super admin's screens — and the
 * event endpoints behind them. Nothing else: every other admin route refuses it.
 *
 * Re-running on an existing email resets its password and role rather than
 * creating a duplicate row, which is what makes an account impossible to
 * delete cleanly later.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const CONFIRM = argv.includes('--confirm');
const EMAIL = arg('email', 'event@gmail.com').toLowerCase().trim();
const PASSWORD = arg('password', '');
const NAME = arg('name', 'Events Administrator');

async function main() {
    console.log('\n=== Events admin account ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: REPORT ONLY (pass --confirm to apply)');

    if (PASSWORD.length < 8) {
        console.error('\n--password is required and must be at least 8 characters. Nothing changed.');
        process.exit(1);
    }

    await mongoose.connect(config.db.uri);
    if (!await adminsDb.ensureReady()) {
        console.error('\nadminsdb is unreachable — nothing was changed.');
        process.exit(1);
    }

    const repo = require('../src/modules/admin/admin.repository');
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const existing = await repo.findRawByEmail(EMAIL).catch(() => null);

    if (existing) {
        const row = repo.toAdminRow(existing.doc, existing.source);
        console.log(`  ${EMAIL} exists  role=${row.role}  collection=${existing.source}`);
        if (row.role && !['events_admin'].includes(row.role)) {
            console.error(`  Refusing: that address belongs to a ${row.role}. Use a different email.`);
            process.exit(1);
        }
        console.log(`  ${CONFIRM ? 'RESET' : 'would reset'} password, role=events_admin, active`);
        if (CONFIRM) {
            await repo.updateById(existing, { passwordHash, role: 'events_admin', active: true, fullName: NAME });
        }
    } else {
        console.log(`  ${CONFIRM ? 'CREATE' : 'would create'}  ${EMAIL}  role=events_admin`);
        if (CONFIRM) {
            const created = await repo.insert({
                fullName: NAME,
                email: EMAIL,
                passwordHash,
                phoneNumber: '',
                role: 'events_admin',
                active: true,
                // Stamped like every other created admin, so staffing counts can
                // tell a real account from the pre-seeded scaffold.
                createdVia: 'super_admin_ui'
            });
            console.log(`  created in ${created.source} (id ${created.id})`);
        }
    }

    if (CONFIRM) {
        const check = await repo.findRawByEmail(EMAIL);
        const row = check && repo.toAdminRow(check.doc, check.source);
        const hash = check && (check.doc.passwordHash || check.doc.password || '');
        const ok = !!hash && await bcrypt.compare(PASSWORD, hash);
        console.log(`\n  verified: role=${row && row.role}  active=${row && row.active}  password matches=${ok}`);
        console.log(`\nSign in at /admin/login with ${EMAIL}. It opens /events-admin/dashboard.`);
    } else {
        console.log('\nNothing was changed. Re-run with --confirm.');
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(async(err) => {
    console.error('Failed:', err && err.message);
    await mongoose.disconnect().catch(() => null);
    process.exit(1);
});
