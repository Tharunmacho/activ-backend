/**
 * Split the one super-admin account into two jobs.
 *
 * Editing the public site and administering the platform are different
 * responsibilities done by different people, and a single account doing both
 * means whoever writes the About page can also delete every block admin. This
 * creates the second account and assigns each its role.
 *
 *   node scripts/split-super-admin-roles.js                 # report
 *   node scripts/split-super-admin-roles.js --confirm       # apply
 *
 *   --cms-email <e>       default cms@activ.org.in
 *   --cms-password <p>    required on the first run that creates it
 *   --platform-email <e>  the existing account to keep as super_admin
 *
 * What each role reaches:
 *
 *   super_admin  everything — the platform AND the CMS. A platform
 *                administrator locked out of content is a support ticket.
 *   cms_admin    the CMS and nothing else. Every route under /admin refuses
 *                it, so the separation is enforced by the server rather than
 *                by hiding links.
 *
 * No password is defaulted. A script that invents one produces an account whose
 * credentials are in a repository.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const config = require('../src/config');
const adminsDb = require('../src/modules/admin/adminsDb');

const arg = (name, fallback = '') => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CONFIRM = process.argv.includes('--confirm');
const CMS_EMAIL = arg('cms-email', 'cms@activ.org.in').toLowerCase();
const CMS_PASSWORD = arg('cms-password', '');
const PLATFORM_EMAIL = arg('platform-email', 'admin@gmail.com').toLowerCase();

async function main() {
    console.log('\n=== Split super-admin responsibilities ===');
    console.log(CONFIRM ? 'Mode: WRITE' : 'Mode: REPORT ONLY (pass --confirm to apply)');

    await mongoose.connect(config.db.uri);
    if (!await adminsDb.ensureReady()) {
        console.error('\nadminsdb is unreachable — nothing was changed.');
        process.exit(1);
    }

    const adminRepository = require('../src/modules/admin/admin.repository');

    // ---- the platform administrator ---------------------------------------
    const platform = await adminRepository.findRawByEmail(PLATFORM_EMAIL).catch(() => null);

    console.log('\nPlatform administrator');
    if (!platform) {
        console.log(`  NOT FOUND: ${PLATFORM_EMAIL}`);
        console.log('  Pass --platform-email to name the account that should keep super_admin.');
    } else {
        const row = adminRepository.toAdminRow(platform.doc, platform.source);
        console.log(`  ${row.email}  role=${row.role}  collection=${platform.source}`);
        if (row.role === 'super_admin') {
            console.log('  already super_admin — nothing to change');
        } else if (CONFIRM) {
            await adminRepository.updateById(platform, { role: 'super_admin' });
            console.log('  set to super_admin');
        } else {
            console.log('  would set to super_admin');
        }
    }

    // ---- the content editor ------------------------------------------------
    console.log('\nCMS administrator');
    const existing = await adminRepository.findRawByEmail(CMS_EMAIL).catch(() => null);

    if (existing) {
        const row = adminRepository.toAdminRow(existing.doc, existing.source);
        console.log(`  ${row.email} already exists  role=${row.role}`);

        if (row.role === 'cms_admin') {
            console.log('  already cms_admin — nothing to change');
        } else if (CONFIRM) {
            await adminRepository.updateById(existing, { role: 'cms_admin' });
            console.log('  set to cms_admin');
        } else {
            console.log('  would set to cms_admin');
        }
    } else if (!CMS_PASSWORD) {
        console.log(`  ${CMS_EMAIL} does not exist and no --cms-password was given.`);
        console.log('  Re-run with --cms-password to create it. Nothing is defaulted:');
        console.log('  an invented password is a credential committed to a repository.');
    } else if (CMS_PASSWORD.length < 8) {
        console.log('  --cms-password must be at least 8 characters. Nothing created.');
    } else {
        console.log(`  ${CONFIRM ? 'CREATE' : 'would create'}  ${CMS_EMAIL}  role=cms_admin`);
        if (CONFIRM) {
            const created = await adminRepository.insert({
                fullName: 'CMS Administrator',
                email: CMS_EMAIL,
                passwordHash: await bcrypt.hash(CMS_PASSWORD, 10),
                role: 'cms_admin',
                active: true,
                // Stamped so coverage counting can tell a real account from the
                // pre-seeded scaffold, exactly as every other created admin is.
                createdVia: 'super_admin_ui',
            });
            console.log(`  created in ${created.source}`);
        }
    }

    console.log('\nWhat each reaches:');
    console.log('  super_admin  platform + CMS');
    console.log('  cms_admin    CMS only — every /admin route refuses it');

    if (!CONFIRM) console.log('\nNothing was changed. Re-run with --confirm.');

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error('\nFailed:', err && err.message);
    console.error(err);
    process.exit(1);
});
