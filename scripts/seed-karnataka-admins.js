/**
 * KARNATAKA — district and block admins, the way Tamil Nadu was set up.
 *
 *   node scripts/seed-karnataka-admins.js            # dry run
 *   node scripts/seed-karnataka-admins.js --confirm  # create
 *
 * - One DISTRICT admin per Karnataka district (the canonical reference list),
 *   with the association's official mailbox from "TN KA Emails.docx".
 * - One BLOCK admin per block (reference list), `<block>@activ.org.in` — a
 *   sign-in id, not a mailbox (block admins are never emailed).
 * - Each account gets its OWN generated password, like the Tamil Nadu pilot;
 *   every email + password is written to backups/karnataka-credentials-*.csv
 *   (the only copy — hand it out and keep it safe).
 * - Fixes the Karnataka State Admin's state spelling ("karanataka" -> "Karnataka")
 *   so the geofence matches Karnataka applicants.
 * - Accounts that already exist (same district / same block) are skipped, so it
 *   is safe to re-run. Writes go through admin.repository only.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const config = require('../src/config');
const repo = require('../src/modules/admin/admin.repository');
const geography = require('../src/modules/regions/geography');

const CONFIRM = process.argv.includes('--confirm');
const STATE = 'Karnataka';
const DOMAIN = 'activ.org.in';

// From "TN KA Emails.docx", keyed by the reference district names.
const DISTRICT_EMAIL = {
    Bagalkote: 'bktkad', Belagavi: 'bgmkad', Ballari: 'berkad', 'Bengaluru Rural': 'brrkad', 'Bengaluru Urban': 'blukad',
    Bidar: 'bdrkad', Vijayapura: 'bjrkad', Chamarajanagar: 'cjrkad', Chikkaballapura: 'ckpkad', Chikkamagaluru: 'ckmkad',
    Chitradurga: 'cdgkad', 'Dakshina Kannada': 'dkkkad', Davanagere: 'dvgkad', Dharwad: 'drdkad', Gadag: 'gdgkad',
    Kalaburagi: 'gbgkad', Hassan: 'hsnkad', Haveri: 'hvrkad', Kodagu: 'kdgkad', Kolar: 'klrkad', Koppal: 'kplkad',
    Mandya: 'mndkad', Mysuru: 'msrkad', Raichur: 'rcrkad', 'Bengaluru South': 'rmrkad' /* formerly Ramanagara */,
    Shivamogga: 'smgkad', Tumakuru: 'tmrkad', Udupi: 'udpkad', 'Uttara Kannada': 'utkkad', Vijayanagara: 'vjrkad', Yadgir: 'ydrkad',
};

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const password = () => {
    // 10 chars, unambiguous letters/digits + one symbol — easy to read out, hard to guess.
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let p = '';
    for (let i = 0; i < 9; i++) p += abc[crypto.randomInt(abc.length)];
    return `${p}@`;
};

(async () => {
    await mongoose.connect(config.db.uri);
    const all = await repo.findAll({ fresh: true, includeUnstamped: true });
    const taken = new Set(all.map((a) => String(a.email || '').toLowerCase()));
    const districtsDone = new Set(all.filter((a) => repo.normalizeRole(a.role) === 'district_admin' && /^karn/i.test(a.state || ''))
        .map((a) => slug(a.district)));
    const blocksDone = new Set(all.filter((a) => repo.normalizeRole(a.role) === 'block_admin' && /^karn/i.test(a.state || ''))
        .map((a) => `${slug(a.district)}|${slug(a.block)}`));

    const toCreate = [];
    for (const d of geography.listDistricts(STATE).map((x) => x.name || x)) {
        if (!districtsDone.has(slug(d))) {
            const local = DISTRICT_EMAIL[d];
            if (!local) { console.log('  ! no official email for district', d); continue; }
            const email = `${local}@${DOMAIN}`;
            if (taken.has(email)) { console.log('  ! email already in use, skipped:', email); continue; }
            taken.add(email);
            toCreate.push({ role: 'district_admin', fullName: `${d} District Admin`, email, state: STATE, district: d });
        }
        for (const b of geography.listBlocks(STATE, d).map((x) => x.name || x)) {
            if (blocksDone.has(`${slug(d)}|${slug(b)}`)) continue;
            let email = `${slug(b)}@${DOMAIN}`;
            if (taken.has(email)) email = `${slug(b)}${slug(d)}@${DOMAIN}`;          // same block name elsewhere
            let n = 2;
            while (taken.has(email)) email = `${slug(b)}${slug(d)}${n++}@${DOMAIN}`;
            taken.add(email);
            toCreate.push({ role: 'block_admin', fullName: `${b} Block Admin`, email, state: STATE, district: d, block: b });
        }
    }

    const stateAdmins = all.filter((a) => repo.normalizeRole(a.role) === 'state_admin' && /^kar/i.test(a.state || '') && !same(a.state, STATE));

    console.log(`${CONFIRM ? '' : 'DRY RUN — '}Karnataka: ${toCreate.filter((x) => x.role === 'district_admin').length} district admin(s), `
        + `${toCreate.filter((x) => x.role === 'block_admin').length} block admin(s) to create; `
        + `${stateAdmins.length} state admin spelling fix(es).`);
    toCreate.slice(0, 6).forEach((x) => console.log(`  ${x.role.padEnd(15)} ${x.email.padEnd(40)} ${x.fullName}`));
    stateAdmins.forEach((a) => console.log(`  state_admin     ${a.email}  state "${a.state}" -> "${STATE}"`));

    if (!CONFIRM) { await mongoose.disconnect(); process.exit(0); }

    for (const a of stateAdmins) {
        const hit = await repo.findRawByEmail(a.email);
        if (hit) await repo.updateById(hit, { state: STATE, role: 'state_admin' });
    }
    const rows = ['role,name,state,district,block,email,password'];
    let made = 0;
    for (const x of toCreate) {
        const pw = password();
        await repo.insert({ ...x, passwordHash: await bcrypt.hash(pw, 10), createdVia: 'ka_seed', active: true });
        rows.push([x.role, x.fullName, x.state, x.district, x.block || '', x.email, pw].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
        made++;
    }
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `karnataka-credentials-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    fs.writeFileSync(file, rows.join('\n'));
    console.log(`Created ${made} account(s). Credentials: ${file}`);
    await mongoose.disconnect();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
