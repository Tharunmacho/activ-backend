/**
 * Set ONE default password on every state, district and block admin.
 *
 *   node scripts/set-admin-default-password.js                 # dry run: counts only
 *   node scripts/set-admin-default-password.js --confirm       # apply
 *   node scripts/set-admin-default-password.js --confirm --password "Other@123"
 *
 * Covers adminsdb.stateadmins, adminsdb.districtadmins and adminsdb.blockadmins.
 * Super admins, the CMS admin and the events admin are NOT touched.
 *
 * Writes go through admin.repository (`passwordHash`, bcrypt), the same path the
 * Super Admin's "edit admin -> password" uses, so a later edit from the UI simply
 * overwrites this default. Before writing, every account's CURRENT hash is saved
 * to backups/admin-password-hashes-<time>.json (hashes only, no plaintext), so
 * the previous passwords can be restored exactly.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const adminRepository = require('../src/modules/admin/admin.repository');
const bcrypt = require('../src/modules/common/passwordHash');

const CONFIRM = process.argv.includes('--confirm');
const pwIndex = process.argv.indexOf('--password');
const PASSWORD = pwIndex > -1 ? String(process.argv[pwIndex + 1] || '') : 'ChangeMe@123';
const TIER_COLLECTIONS = ['stateadmins', 'districtadmins', 'blockadmins'];

(async() => {
    if (PASSWORD.length < 8) throw new Error('Password must be at least 8 characters');
    await mongoose.connect(process.env.MONGODB_URI);
    await require('../src/modules/admin/adminsDb').ensureReady();

    const sources = adminRepository.sources()
        .filter((s) => s.segregated && TIER_COLLECTIONS.includes(s.name));
    if (sources.length !== TIER_COLLECTIONS.length) {
        throw new Error(`Expected ${TIER_COLLECTIONS.join(', ')}; found ${sources.map((s) => s.name).join(', ') || 'none'}`);
    }

    const targets = [];
    for (const source of sources) {
        const docs = await source.handle.find({}).project({ email: 1, role: 1, passwordHash: 1, password: 1 }).toArray();
        console.log(`${source.name.padEnd(16)} ${docs.length} accounts`);
        docs.forEach((doc) => targets.push({
            hit: { doc, source: source.name, sourceKey: source.key, handle: source.handle, objectId: doc._id },
            email: String(doc.email || ''),
            previousHash: doc.passwordHash || doc.password || ''
        }));
    }
    console.log(`TOTAL            ${targets.length} accounts -> password "${PASSWORD}"`);

    if (!CONFIRM) {
        console.log('\nDry run. Re-run with --confirm to apply.');
        process.exit(0);
    }

    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `admin-password-hashes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(targets.map((t) => ({
        collection: t.hit.source, _id: String(t.hit.objectId), email: t.email, previousHash: t.previousHash
    })), null, 2));
    console.log(`Previous hashes saved to ${path.relative(process.cwd(), backupFile)}`);

    let done = 0;
    let failed = 0;
    for (const t of targets) {
        try {
            const passwordHash = await bcrypt.hash(PASSWORD, 10);
            await adminRepository.updateById(t.hit, {
                passwordHash,
                resetPasswordToken: '',
                resetPasswordExpires: null,
                updatedAt: new Date()
            });
            done++;
            if (done % 50 === 0) console.log(`  ${done}/${targets.length}`);
        } catch (err) {
            failed++;
            console.error(`  FAILED ${t.email}: ${err.message}`);
        }
    }

    // Verify by reading back.
    let verified = 0;
    for (const t of targets) {
        const doc = await t.hit.handle.findOne({ _id: t.hit.objectId }, { projection: { passwordHash: 1 } });
        if (doc && doc.passwordHash && await bcrypt.compare(PASSWORD, doc.passwordHash)) verified++;
    }
    console.log(`\nUpdated ${done}, failed ${failed}, verified ${verified}/${targets.length}.`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
