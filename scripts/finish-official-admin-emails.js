/**
 * 1. State admins get their official mailboxes:
 *      Tamil Nadu -> tnevns@activ.org.in,  Karnataka -> kaevns@activ.org.in
 *    (email only — password unchanged).
 * 2. Duplicate District Admin accounts are deleted: every district admin of a
 *    district that ALREADY has the official `…@activ.org.in` account, except that
 *    official account itself. Nothing is assigned to an admin id (queues are
 *    geofenced by region), so no application loses its reviewer.
 *
 *   node scripts/finish-official-admin-emails.js            # dry run
 *   node scripts/finish-official-admin-emails.js --confirm  # apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const config = require('../src/config');
const repo = require('../src/modules/admin/admin.repository');

const CONFIRM = process.argv.includes('--confirm');
const STATE_EMAIL = { 'tamil nadu': 'tnevns@activ.org.in', karnataka: 'kaevns@activ.org.in' };
const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

(async () => {
    await mongoose.connect(config.db.uri);
    const all = await repo.findAll({ fresh: true, includeUnstamped: true });

    const stateChanges = all
        .filter((a) => repo.normalizeRole(a.role) === 'state_admin' && STATE_EMAIL[key(a.state)]
            && String(a.email).toLowerCase() !== STATE_EMAIL[key(a.state)])
        .map((a) => ({ admin: a, to: STATE_EMAIL[key(a.state)] }));

    const districts = all.filter((a) => repo.normalizeRole(a.role) === 'district_admin');
    const official = new Map();
    districts.filter((a) => /@activ\.org\.in$/i.test(a.email)).forEach((a) => official.set(`${key(a.state)}|${key(a.district)}`, a));
    const duplicates = districts.filter((a) => !/@activ\.org\.in$/i.test(a.email) && official.has(`${key(a.state)}|${key(a.district)}`));

    console.log(`${CONFIRM ? '' : 'DRY RUN — '}${stateChanges.length} state admin email change(s), ${duplicates.length} duplicate district admin(s) to delete`);
    stateChanges.forEach((c) => console.log(`  state_admin  ${c.admin.state}: ${c.admin.email} -> ${c.to}`));
    duplicates.forEach((d) => console.log(`  delete       ${d.email}  (${d.district}; official account: ${official.get(`${key(d.state)}|${key(d.district)}`).email})`));

    if (CONFIRM) {
        for (const c of stateChanges) {
            if (await repo.emailExists(c.to, c.admin.id)) { console.log('  ! already in use, skipped:', c.to); continue; }
            const hit = await repo.findRawByEmail(c.admin.email);
            if (hit) await repo.updateById(hit, { email: c.to, role: 'state_admin' });
        }
        for (const d of duplicates) await repo.deleteEverywhere({ email: d.email });
        console.log('Done.');
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
