/**
 * OFFICIAL ADMIN EMAILS — district admins get the association's real mailboxes
 * (from "TN KA Emails.docx"), block admins get the short `<block>@activ.org.in`.
 *
 *   node scripts/apply-official-admin-emails.js            # dry run: prints every change
 *   node scripts/apply-official-admin-emails.js --confirm  # apply
 *
 * Only the EMAIL (the sign-in id) changes. Passwords, names, roles and regions are
 * untouched, so every admin signs in with the new email and the SAME password.
 * Writes go through admin.repository (the only module allowed to write admin
 * documents). A CSV of old -> new emails is written to backups/ on --confirm.
 *
 * Why: district and state inboxes are real, so Reply-To and the "contact your
 * regional office" lines in every email/WhatsApp reach a person; block accounts
 * have no mailbox — their short address is a sign-in id only (no mail is sent to
 * block admins; see notification routing).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config');
const adminRepository = require('../src/modules/admin/admin.repository');

const CONFIRM = process.argv.includes('--confirm');

/* ---------------------------------------------------- the document's table */
const DISTRICT_EMAILS = {
    'Tamil Nadu': {
        Ariyalur: 'aritnd', Chengalpattu: 'cgltnd', Chennai: 'chntnd', Coimbatore: 'cmbtnd', Cuddalore: 'cudtnd',
        Dharmapuri: 'dprtnd', Dindigul: 'ddgtnd', Erode: 'erdtnd', Kallakurichi: 'klctnd', Kanchipuram: 'kpmtnd',
        Kanyakumari: 'knytnd', Karur: 'kartnd', Krishnagiri: 'krstnd', Madurai: 'mdutnd', Mayiladuthurai: 'mydtnd',
        Nagapattinam: 'ngptnd', Namakkal: 'nkltnd', Nilgiris: 'nlgtnd', Perambalur: 'pbltnd', Pudukkottai: 'pdktnd',
        Ramanathapuram: 'rmntnd', Ranipet: 'rpttnd', Salem: 'slmtnd', Sivagangai: 'svgtnd', Tenkasi: 'tnktnd',
        Thanjavur: 'tnjtnd', Theni: 'tnitnd', Thoothukudi: 'tuttnd', Tiruchirappalli: 'trytnd', Tirunelveli: 'tnltnd',
        Tirupathur: 'tpttnd', Tiruppur: 'tprtnd', Tiruvallur: 'tvltnd', Tiruvannamalai: 'tmltnd', Tiruvarur: 'tvrtnd',
        Vellore: 'vlrtnd', Viluppuram: 'vpmtnd', Virudhunagar: 'vrdtnd',
    },
    Karnataka: {
        Bagalkot: 'bktkad', Belgam: 'bgmkad', Bellari: 'berkad', 'Bengaluru Rural': 'brrkad', 'Bengaluru Urban': 'blukad',
        Bidar: 'bdrkad', Bijapur: 'bjrkad', Chamarajanagar: 'cjrkad', Chikkaballapur: 'ckpkad', Chikkamagalur: 'ckmkad',
        Chitradurga: 'cdgkad', 'Dakshina Kannada': 'dkkkad', Davanagere: 'dvgkad', Dharwad: 'drdkad', Gadag: 'gdgkad',
        Gulbarga: 'gbgkad', Hassan: 'hsnkad', Haveri: 'hvrkad', Kodugu: 'kdgkad', Kolar: 'klrkad', Koppal: 'kplkad',
        Mandya: 'mndkad', Mysore: 'msrkad', Raichur: 'rcrkad', Ramanagar: 'rmrkad', Shivamoga: 'smgkad', Tumkur: 'tmrkad',
        Udupi: 'udpkad', 'Uttar Kannada': 'utkkad', Vijayanagar: 'vjrkad', Yadgiri: 'ydrkad',
    },
};
const DOMAIN = 'activ.org.in';

/* ------------------------------------------------ name matching, tolerant */
const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z]/g, '');
// Other spellings of the same district that live data may carry.
const ALIASES = {
    belgaum: 'belgam', belagavi: 'belgam', ballari: 'bellari', bellary: 'bellari', vijayapura: 'bijapur',
    kalaburagi: 'gulbarga', kodagu: 'kodugu', coorg: 'kodugu', mysuru: 'mysore', shivamogga: 'shivamoga', shimoga: 'shivamoga',
    tumakuru: 'tumkur', uttarakannada: 'uttarkannada', karwar: 'uttarkannada', yadgir: 'yadgiri', ramanagara: 'ramanagar',
    chikkaballapura: 'chikkaballapur', chikmagalur: 'chikkamagalur', chikkamagaluru: 'chikkamagalur', bagalkote: 'bagalkot',
    chamrajnagar: 'chamarajanagar', chamarajanagara: 'chamarajanagar', davangere: 'davanagere', vijayanagara: 'vijayanagar',
    bangalorerural: 'bengalururural', bangaloreurban: 'bengaluruurban', bengaluru: 'bengaluruurban', bangalore: 'bengaluruurban',
    kancheepuram: 'kanchipuram', kanniyakumari: 'kanyakumari', tuticorin: 'thoothukudi', trichy: 'tiruchirappalli',
    tiruchirapalli: 'tiruchirappalli', thiruvallur: 'tiruvallur', villupuram: 'viluppuram', tirupattur: 'tirupathur',
    thiruvarur: 'tiruvarur', thiruvannamalai: 'tiruvannamalai', sivaganga: 'sivagangai', thirunelveli: 'tirunelveli',
    tiruppur: 'tiruppur', tirupur: 'tiruppur', nilgiris: 'nilgiris', pudukottai: 'pudukkottai', kallakurichi: 'kallakurichi',
};
const editDistance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
};
const stateKey = (s) => {
    const n = norm(s);
    if (n.startsWith('tamil')) return 'Tamil Nadu';
    if (n.startsWith('karnat')) return 'Karnataka';
    return '';
};
const districtEmailFor = (state, district) => {
    const table = DISTRICT_EMAILS[stateKey(state)];
    if (!table) return null;
    let d = norm(district);
    d = ALIASES[d] || d;
    const entries = Object.entries(table).map(([name, local]) => [norm(name), local, name]);
    let hit = entries.find(([n]) => n === d);
    if (!hit) {
        const near = entries.map((e) => [e, editDistance(e[0], d)]).sort((a, b) => a[1] - b[1])[0];
        if (near && near[1] <= 2) hit = near[0];
    }
    return hit ? { email: `${hit[1]}@${DOMAIN}`, docName: hit[2] } : null;
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
    await mongoose.connect(config.db.uri);
    const all = await adminRepository.findAll({ fresh: true, includeUnstamped: false });
    const admins = (all || []).filter((a) => ['district_admin', 'block_admin'].includes(adminRepository.normalizeRole(a.role)));

    const plan = [];
    const skipped = [];
    const taken = new Set((all || []).map((a) => String(a.email || '').toLowerCase()));
    const newEmails = new Set();

    // Districts first — their addresses are fixed by the document. When a district
    // has several accounts, the standard one (district.<name>.<state>@activ.com)
    // gets the official address; the extras are left as they are and reported.
    const standard = (a) => /^district\.[a-z]+\.[a-z.]+@activ\.com$/i.test(String(a.email || ''))
        && String(a.email).toLowerCase().split('.').length === 5 ? 0 : 1;
    const districts = admins.filter((x) => adminRepository.normalizeRole(x.role) === 'district_admin')
        .sort((x, y) => standard(x) - standard(y));
    for (const a of districts) {
        const m = districtEmailFor(a.state, a.district);
        if (!m) { skipped.push(`district  ${a.email}  (${a.district}, ${a.state}) — not in the document`); continue; }
        if (String(a.email).toLowerCase() === m.email) continue;
        if (newEmails.has(m.email)) { skipped.push(`district  ${a.email}  (${a.district}) — ${m.email} already given to another admin of this district`); continue; }
        newEmails.add(m.email);
        plan.push({ admin: a, to: m.email, why: `district ${a.district} -> ${m.docName}` });
    }
    // Blocks: <block>@activ.org.in; a block name used in two districts gets the district appended.
    const blocks = admins.filter((x) => adminRepository.normalizeRole(x.role) === 'block_admin');
    const countByBlock = blocks.reduce((m, b) => { const k = slug(b.block); m[k] = (m[k] || 0) + 1; return m; }, {});
    for (const a of blocks) {
        const base = slug(a.block);
        if (!base) { skipped.push(`block     ${a.email}  — no block name`); continue; }
        let local = countByBlock[base] > 1 ? `${base}${slug(a.district)}` : base;
        let email = `${local}@${DOMAIN}`;
        if (String(a.email).toLowerCase() === email) continue;
        let n = 2;
        while (newEmails.has(email) || (taken.has(email) && String(a.email).toLowerCase() !== email)) { email = `${local}${n++}@${DOMAIN}`; }
        newEmails.add(email);
        plan.push({ admin: a, to: email, why: `block ${a.block}, ${a.district}` });
    }

    console.log(`${plan.length} email change(s)${CONFIRM ? '' : ' (DRY RUN — add --confirm to apply)'}:`);
    for (const p of plan) console.log(`  ${adminRepository.normalizeRole(p.admin.role).padEnd(15)} ${String(p.admin.email).padEnd(52)} -> ${p.to.padEnd(34)} ${p.why}`);
    if (skipped.length) { console.log(`\nNot changed (${skipped.length}):`); skipped.forEach((s) => console.log('  ' + s)); }

    if (CONFIRM && plan.length) {
        const rows = ['role,name,state,district,block,old_email,new_email'];
        let done = 0;
        for (const p of plan) {
            const hit = await adminRepository.findRawByEmail(p.admin.email);
            if (!hit) { console.log('  ! not found at write time:', p.admin.email); continue; }
            await adminRepository.updateById(hit, { email: p.to });
            done++;
            rows.push([adminRepository.normalizeRole(p.admin.role), p.admin.fullName, p.admin.state, p.admin.district, p.admin.block, p.admin.email, p.to]
                .map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
        }
        const dir = path.join(__dirname, '..', 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `admin-email-changes-${Date.now()}.csv`);
        fs.writeFileSync(file, rows.join('\n'));
        console.log(`\nApplied ${done}. Old -> new list: ${file}`);
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
