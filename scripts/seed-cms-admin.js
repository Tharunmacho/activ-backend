/**
 * Seed the CMS super-admin account.
 *
 *   CMS_ADMIN_PASSWORD='...' node scripts/seed-cms-admin.js
 *   CMS_ADMIN_EMAIL=x@y.com CMS_ADMIN_PASSWORD='...' node scripts/seed-cms-admin.js
 *
 * Writes through `admin.repository`, which is the only module allowed to touch
 * the admin collections: it knows that `passwordHash` is stored as `password`
 * in the unified collection and as `passwordHash` in the per-tier ones, and
 * getting that wrong leaves an account with no credential and reports success.
 *
 * There is deliberately no default password. An earlier version defaulted to a
 * six-character one, which is below the eight the Super Admin UI enforces — and
 * because this script writes directly, nothing would have caught it. A working
 * weak credential is exactly the kind that reaches production, so the script
 * now refuses to run rather than seed one.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const EMAIL = String(process.env.CMS_ADMIN_EMAIL || 'cms.admin@activ.org.in').toLowerCase().trim();

/**
 * No default password.
 *
 * The original build shipped `123456`, which is six characters — below the
 * eight the Super Admin UI enforces, and this script writes directly so nothing
 * would have stopped it. A seeded weak credential on a publicly reachable admin
 * panel is the kind of thing that survives to production precisely because it
 * works, so the script now refuses to run without one being supplied.
 */
const PASSWORD = String(process.env.CMS_ADMIN_PASSWORD || '');

(async () => {
    if (!PASSWORD) {
        console.error([
            'CMS_ADMIN_PASSWORD is required.',
            '',
            '  CMS_ADMIN_PASSWORD="your-password" node scripts/seed-cms-admin.js',
            '',
            `Optionally set CMS_ADMIN_EMAIL too (default: ${EMAIL}).`,
        ].join('\n'));
        process.exit(1);
    }
    if (PASSWORD.length < 8) {
        console.error(`The password is ${PASSWORD.length} characters. Use at least 8 — the Super Admin UI enforces that, and this script bypasses it.`);
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

    const adminsDb = require('../src/modules/admin/adminsDb');
    await adminsDb.ensureReady();

    const repo = require('../src/modules/admin/admin.repository');

    const existing = await repo.findRawByEmail(EMAIL);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    if (existing) {
        // Reset the credential rather than creating a duplicate: a second row
        // with the same email is exactly what makes an account impossible to
        // delete cleanly later.
        await repo.updateById(existing, {
            passwordHash,
            role: 'super_admin',
            active: true,
            fullName: existing.doc.fullName || 'CMS Administrator',
        });
        console.log(`Updated the existing account ${EMAIL} (found in ${existing.source}) — password reset, role super_admin.`);
    } else {
        const created = await repo.insert({
            email: EMAIL,
            passwordHash,
            fullName: 'CMS Administrator',
            phoneNumber: '',
            role: 'super_admin',
            active: true,
            createdVia: 'cms_seed',
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        console.log(`Created ${EMAIL} as super_admin (id ${created.id}, collection ${created.source}).`);
    }

    if (PASSWORD.length < 8) {
        console.warn(
            `\nWARNING: the password is ${PASSWORD.length} characters. The Super Admin UI requires 8 or more;\n` +
            'this script wrote it directly and skipped that check. Change it before exposing the site publicly.',
        );
    }

    console.log('\nSign in at the CMS with:');
    console.log(`  email    ${EMAIL}`);
    console.log(`  password ${PASSWORD}`);

    await mongoose.disconnect();
    process.exit(0);
})().catch(async (error) => {
    console.error('Seed failed:', error && error.message);
    await mongoose.disconnect().catch(() => null);
    process.exit(1);
});
